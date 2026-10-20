/**
 * Trading V2 — trailing 발동 시 키움 주문 + trading_orders/stages 반영
 * (레거시 auto_tradings 미사용)
 */

const {
  placeAutoMarketOrder,
  normalizeAutoCode,
  isSessionOpenForMarket,
  getMsUntilMarketCutoff,
} = require('./autoTradingMarket');
const {
  createTradingOrder,
  getTradingPlanById,
  resolveStageForOrder,
  findTradingOrderByBrokerNo,
} = require('./tradingV2Store');

const OPEN_ORDER_STATUSES = new Set(['pending', 'submitted', 'partial']);
const inflightV2Orders = new Set();

const v2OrderLockKey = (side, planId, stageId, cycleId, stageNo) =>
  `${String(side).toUpperCase()}:${planId}:${stageId || 0}:${cycleId || 0}:${stageNo || 0}`;

/**
 * 키움이 주문을 거부하면(잔고·수량 부족 등) 같은 플랜·방향 재주문을 잠시 막는다.
 * 막지 않으면 trailing 이 매 틱 다시 arm → 즉시 재주문을 반복한다.
 */
const REJECT_COOLDOWN_MS = 3 * 60 * 1000;
/** @type {Map<string, number>} key → 재시도 허용 시각 */
const rejectCooldowns = new Map();
const cooldownKey = (side, planId) => `${String(side).toUpperCase()}:${planId}`;

const markOrderRejected = (side, planId, code, reason) => {
  if (!planId) return;
  rejectCooldowns.set(cooldownKey(side, planId), Date.now() + REJECT_COOLDOWN_MS);
  console.warn(
    `[TradingV2] ${side} 주문 거부 — plan=${planId} ${code} ${REJECT_COOLDOWN_MS / 60000}분간 재주문 중지: ${reason}`
  );
};

/**
 * 접수 여부를 알 수 없는 주문(응답 시간초과·네트워크 오류·주문번호 없음·접수 후 DB 저장 실패).
 * 키움에 주문이 살아 있을 수 있으므로 당일 주문이 만료되는 장 종료(+5분)까지 같은 플랜·방향 재주문을 막고 알린다.
 */
const markOrderUncertain = ({ side, planId, userId, code, stockMarket, reason }) => {
  if (!planId) return;
  const untilCutoff = Math.max(0, getMsUntilMarketCutoff(stockMarket)) + 5 * 60 * 1000;
  const blockMs = Math.max(REJECT_COOLDOWN_MS, untilCutoff);
  rejectCooldowns.set(cooldownKey(side, planId), Date.now() + blockMs);
  console.error(
    `[TradingV2] ${side} 주문 접수 불확실 — plan=${planId} ${code} ${Math.round(blockMs / 60000)}분간 재주문 중지: ${reason}`
  );
  try {
    const { sendTelegramToUserById } = require('../services/telegramService');
    void sendTelegramToUserById(
      userId,
      `⚠️ ${side === 'BUY' ? '매수' : '매도'} 주문 접수 확인 불가\n${code} (plan ${planId})\n${reason}\n` +
        `중복 주문 방지를 위해 장 종료까지 이 플랜의 자동 ${side === 'BUY' ? '매수' : '매도'}를 멈춥니다. ` +
        `영웅문에서 주문·체결을 확인해주세요.`
    );
  } catch {
    /* ignore */
  }
};

/** 키움이 응답으로 명확히 거부한 오류(4xx)인지 — 아니면 접수 여부를 알 수 없다 */
const isDefiniteRejectError = (err) => {
  const status = Number(err?.status);
  return Number.isFinite(status) && status >= 400 && status < 500;
};

/** 주문 직전 최신 토큰 (07:50 자동갱신 등으로 trailing 시작 때 받은 토큰이 바뀌었을 수 있다) */
const resolveLatestKiwoomInfo = async (userId, fallback) => {
  try {
    const { getKiwoomInfo } = require('./kiwoomUtils');
    const info = await getKiwoomInfo(userId);
    if (info?.accessToken) {
      return {
        accessToken: info.accessToken,
        appKey: info.appKey,
        appSecret: info.appSecret,
        accountNo: info.accountNo,
      };
    }
  } catch (err) {
    console.warn(`[TradingV2] 최신 토큰 조회 실패 — 기존 토큰 사용 user=${userId}:`, err.message);
  }
  return fallback;
};

const isV2OrderOnCooldown = (side, planId) => {
  const key = cooldownKey(side, planId);
  const until = rejectCooldowns.get(key);
  if (!until) return false;
  if (Date.now() < until) return true;
  rejectCooldowns.delete(key);
  return false;
};

const canPlaceKrV2Order = (stockMarket) => isSessionOpenForMarket(stockMarket);

/**
 * 주문 직전 차수 확인. 플랜 재저장으로 stageId 가 바뀌었으면 (side, 차수, 회차)로 현재 차수를 다시 찾는다.
 * @returns {{ok: boolean, error?: string, stageId?: number|null}} stageId = 주문에 쓸 현재 차수 ID
 */
const assertV2StageStillOpen = async ({ userId, planId, side, stageId, stageNo, cycleId }) => {
  if (!planId) return { ok: false, error: 'planId 없음' };
  const plan = await getTradingPlanById(userId, planId);
  if (!plan) return { ok: false, error: '플랜을 찾을 수 없습니다.' };
  if (String(plan.status) !== 'active') {
    return { ok: false, error: `플랜이 활성 상태가 아닙니다 (${plan.status})` };
  }

  let currentStageId = stageId ? Number(stageId) : null;
  if (stageId) {
    const st = resolveStageForOrder(plan, { side, stageId, stageNo, cycleId });
    if (!st) {
      return { ok: false, error: '차수 정보가 변경되어 주문하지 않습니다.' };
    }
    currentStageId = Number(st.id);
    if (String(st.status) !== 'pending') {
      return { ok: false, error: `이미 진행된 차수입니다 (${st.status})` };
    }
  }
  if (hasOpenOrderForStage(plan, side, currentStageId, cycleId)) {
    return { ok: false, error: '이미 미체결 주문이 있습니다.' };
  }
  return { ok: true, stageId: currentStageId };
};

/** 키움 접수 후 DB 저장 — 실패하면 차수 연결 없이 한 번 더 저장해 주문 기록·체결 감시를 남긴다 */
const saveAcceptedOrder = async (userId, planId, body) => {
  try {
    await createTradingOrder(userId, planId, body);
  } catch (err) {
    console.error(
      `[TradingV2] 주문 저장 실패 — 차수 연결 없이 재저장: plan=${planId} ${body.side} order=${body.brokerOrderNo}`,
      err.message
    );
    // 첫 저장이 행을 남겼으면 다시 넣지 않는다 (같은 주문번호 두 줄 → 한 줄은 영원히 미체결로 남음)
    const existing = await findTradingOrderByBrokerNo(userId, body.brokerOrderNo).catch(() => null);
    if (existing?.order && Number(existing.planId) === Number(planId)) return;
    await createTradingOrder(userId, planId, { ...body, stageId: null, markStageOrdered: false });
  }
};

/**
 * 키움 주문 요청 — 명확한 거부는 짧은 쿨다운, 접수 여부를 모르면 장 종료까지 차단
 * @returns {Promise<{ok: true, orderNo: string} | {ok: false, error: string}>}
 */
const submitToBroker = async ({ kiwoomInfo, orderData, stockMarket, side, planId, userId, code }) => {
  let result;
  try {
    result = await placeAutoMarketOrder(kiwoomInfo, orderData, stockMarket);
  } catch (err) {
    const errorMsg = err?.message || '주문 실패';
    if (isDefiniteRejectError(err)) {
      markOrderRejected(side, planId, code, errorMsg);
    } else {
      markOrderUncertain({ side, planId, userId, code, stockMarket, reason: `주문 응답 오류: ${errorMsg}` });
    }
    return { ok: false, error: errorMsg };
  }
  if (result.return_code !== undefined && result.return_code !== 0) {
    const errorMsg = result.return_msg || '주문 실패';
    markOrderRejected(side, planId, code, errorMsg);
    return { ok: false, error: errorMsg };
  }
  const orderNo = result.orderNo || result.ord_no || null;
  if (!orderNo) {
    markOrderUncertain({ side, planId, userId, code, stockMarket, reason: '주문번호를 받지 못했습니다.' });
    return { ok: false, error: '주문번호를 받을 수 없습니다.' };
  }
  return { ok: true, orderNo: String(orderNo) };
};

/** 접수된 주문 DB 저장 — 실패하면 기록 없이 살아 있는 주문이 되므로 재주문을 막고 알린다 */
const saveAcceptedOrderOrBlock = async ({ userId, planId, body, code, stockMarket }) => {
  try {
    await saveAcceptedOrder(userId, planId, body);
    return true;
  } catch (err) {
    markOrderUncertain({
      side: body.side,
      planId,
      userId,
      code,
      stockMarket,
      reason: `주문번호 ${body.brokerOrderNo} 접수됐으나 DB 저장 실패: ${err.message}`,
    });
    return false;
  }
};

const startFillWatchSafe = (args) => {
  try {
    require('./tradingV2FillRestBackup').startTradingV2FillWatch(args);
  } catch (err) {
    console.error(`[TradingV2] 체결감시 등록 실패:`, err.message);
  }
};
/**
 * @param {object} args
 * @param {object} args.kiwoomInfo
 * @param {string|number} args.userId
 * @param {string} args.stockCode
 * @param {number} args.price
 * @param {number} args.qty
 * @param {string} args.stockMarket
 * @param {number} args.planId
 * @param {number|null} [args.cycleId]
 * @param {number|null} [args.stageId]
 * @param {number} [args.buyStage]
 * @param {string|null} [args.mode] 'entry' = 무한매매 1회 진입 (cycle 내 매수 체결 있으면 거부)
 */
const executeTradingV2BuyOrder = async ({
  kiwoomInfo: kiwoomInfoArg,
  userId,
  stockCode,
  price,
  qty,
  stockMarket = 'KRX',
  planId,
  cycleId = null,
  stageId = null,
  buyStage = 1,
  mode = null,
}) => {
  const code = normalizeAutoCode(stockCode, stockMarket);
  const lockKey = v2OrderLockKey('BUY', planId, stageId, cycleId, buyStage);
  if (inflightV2Orders.has(lockKey)) {
    return { success: false, stockCode: code, buyStage, error: '동일 차수 주문 처리 중', message: '동일 차수 주문 처리 중' };
  }
  inflightV2Orders.add(lockKey);
  try {
    if (!canPlaceKrV2Order(stockMarket)) {
      return {
        success: false,
        stockCode: code,
        error: '주문 가능 시간이 아닙니다.',
        message: '주문 가능 시간이 아닙니다.',
      };
    }
    if (!planId) {
      return { success: false, stockCode: code, error: 'planId 없음', message: 'planId 없음' };
    }

    const stillOpen = await assertV2StageStillOpen({
      userId,
      planId,
      side: 'BUY',
      stageId,
      stageNo: buyStage,
      cycleId,
    });
    if (!stillOpen.ok) {
      console.warn(`[TradingV2매수] 중복 스킵: ${code} plan=${planId} ${buyStage}차 ${stillOpen.error}`);
      return { success: false, stockCode: code, buyStage, error: stillOpen.error, message: stillOpen.error };
    }
    const orderStageId = stillOpen.stageId ?? null;

    if (mode === 'entry') {
      const plan = await getTradingPlanById(userId, planId);
      const { avgCostFromPlanFills } = require('./infiniteTradeBands');
      const cid = cycleId != null ? cycleId : plan?.currentCycleId ?? null;
      if (plan && avgCostFromPlanFills(plan, { cycleId: cid }).buyQty > 0) {
        const msg = '이미 진입 매수가 체결되었습니다.';
        console.warn(`[TradingV2매수] 중복 진입 스킵: ${code} plan=${planId} ${msg}`);
        return { success: false, stockCode: code, buyStage, error: msg, message: msg };
      }
    }

    let orderQty = Number(qty) || 0;
    // 무한매매: 시드 잔액으로 수량 제한 (seedAmount 미설정 시 스킵)
    try {
      const plan = await getTradingPlanById(userId, planId);
      if (plan && String(plan.strategyType).toUpperCase() === 'INFINITE_TRADE') {
        const { clampBuyBySeed } = require('./infiniteTradeBands');
        const capped = clampBuyBySeed(
          plan,
          { price, qty: orderQty, amount: Number(price) * orderQty },
          { cycleId: cycleId != null ? cycleId : plan.currentCycleId }
        );
        if (!capped.ok) {
          const msg =
            capped.reason === 'seed_exhausted'
              ? '시드금액이 소진되었습니다.'
              : '시드 잔액이 부족하여 주문할 수 없습니다.';
          console.warn(`[TradingV2매수] 시드 스킵: ${code} plan=${planId} ${capped.reason} rem=${capped.remaining}`);
          return { success: false, stockCode: code, buyStage, error: msg, message: msg };
        }
        if (capped.capped) {
          console.log(
            `[TradingV2매수] 시드 잔액으로 수량 축소: ${code} plan=${planId} ${orderQty}→${capped.qty}`
          );
        }
        orderQty = capped.qty;
      }
    } catch (err) {
      // 시드 한도를 확인 못 하면 한도 초과 매수가 될 수 있으므로 주문하지 않는다
      const msg = `시드 검사 실패로 주문하지 않습니다: ${err.message}`;
      console.warn(`[TradingV2매수] ${code} plan=${planId} ${msg}`);
      return { success: false, stockCode: code, buyStage, error: msg, message: msg };
    }
    if (!(orderQty > 0)) {
      return {
        success: false,
        stockCode: code,
        buyStage,
        error: '주문 수량이 없습니다.',
        message: '주문 수량이 없습니다.',
      };
    }

    const orderData = {
      symbol: code,
      orderType: 'buy',
      quantity: orderQty,
      priceType: 'limit',
      price,
    };

    const unit = stockMarket === 'US' ? '$' : '원';
    console.log(
      `[TradingV2매수] 주문: user=${userId} plan=${planId} ${code} ${buyStage}차 ${price}${unit} x${orderQty}`
    );

    const kiwoomInfo = await resolveLatestKiwoomInfo(userId, kiwoomInfoArg);
    const placed = await submitToBroker({
      kiwoomInfo,
      orderData,
      stockMarket,
      side: 'BUY',
      planId,
      userId,
      code,
    });
    if (!placed.ok) {
      console.error(`[TradingV2매수] 실패: ${code}`, placed.error);
      return { success: false, stockCode: code, buyStage, error: placed.error, message: placed.error };
    }
    const { orderNo } = placed;

    const saved = await saveAcceptedOrderOrBlock({
      userId,
      planId,
      code,
      stockMarket,
      body: {
        side: 'BUY',
        cycleId,
        stageId: orderStageId,
        stageNo: buyStage,
        orderType: 'LIMIT',
        requestedPrice: price,
        requestedQty: orderQty,
        brokerOrderNo: orderNo,
        status: 'submitted',
        markStageOrdered: !!orderStageId,
      },
    });
    if (!saved) {
      // 주문은 키움에 접수됨 — 재주문은 막았고 사용자에게 알림
      return { success: true, stockCode: code, buyStage, orderNo, message: '주문은 접수됐으나 기록 저장에 실패했습니다.' };
    }

    startFillWatchSafe({
      kiwoomInfo,
      userId,
      stockCode: code,
      stockMarket,
      orderNo: String(orderNo),
      orderPrice: price,
      orderQty,
      planId,
    });

    console.log(`[TradingV2매수] 접수: ${code} plan=${planId} orderNo=${orderNo}`);
    return { success: true, stockCode: code, buyStage, orderNo, message: '주문이 접수되었습니다.' };
  } catch (error) {
    console.error(`[TradingV2매수] 오류: ${stockCode}`, error.message);
    markOrderRejected('BUY', planId, stockCode, error.message);
    return { success: false, stockCode, buyStage, error: error.message, message: '주문 접수에 실패했습니다.' };
  } finally {
    inflightV2Orders.delete(lockKey);
  }
};

/**
 * @param {object} args
 */
/**
 * 매도 수량 = min(trailing 수량, DB 잔량, 키움 매도가능수량)
 * - DB 잔량: 무한 = cycle 체결 잔량, 분할 = 해당 차수 로트 잔량
 * - 키움 조회 실패·필드 없음이면 DB 잔량 기준으로만 진행 (매도를 막지 않음)
 * @returns {Promise<{ok: true, qty: number} | {ok: false, error: string, cooldown?: boolean}>}
 */
const resolveSellQty = async ({ userId, planId, cycleId, sellStage, qty, kiwoomInfo, code, stockMarket }) => {
  let want = Math.floor(Number(qty) || 0);
  const plan = await getTradingPlanById(userId, planId);
  if (plan) {
    const cid = cycleId != null ? Number(cycleId) : plan.currentCycleId != null ? Number(plan.currentCycleId) : null;
    const { avgCostFromPlanFills, netFilledQtyForSplitStage } = require('./infiniteTradeBands');
    const dbRem =
      String(plan.strategyType).toUpperCase() === 'SPLIT_TRADE'
        ? Math.floor(Number(netFilledQtyForSplitStage(plan, Number(sellStage) || 1, cid)) || 0)
        : Math.floor(Number(avgCostFromPlanFills(plan, { cycleId: cid, includeSubmitted: false }).remQty) || 0);
    if (!(dbRem > 0)) return { ok: false, error: '매도할 잔량이 없습니다 (이미 매도·청산됨).' };
    if (!(want > 0) || want > dbRem) {
      if (want > 0) console.warn(`[TradingV2매도] plan=${planId} ${code} 수량 ${want}→${dbRem} (DB 잔량)`);
      want = dbRem;
    }
  }
  if (!(want > 0)) return { ok: false, error: '주문 수량이 없습니다.' };

  const { getBrokerSellableQty } = require('./brokerSellableQty');
  const broker = await getBrokerSellableQty(kiwoomInfo, code, stockMarket);
  if (broker.qty == null) {
    console.warn(`[TradingV2매도] plan=${planId} ${code} 키움 매도가능수량 확인 불가(${broker.reason}) — DB 잔량 ${want}주로 진행`);
    return { ok: true, qty: want };
  }
  if (!(broker.qty > 0)) {
    // 다시 arm 돼도 같은 결과이므로 쿨다운
    return { ok: false, cooldown: true, error: `키움 매도가능수량이 없습니다 (${broker.reason || '0주'}).` };
  }
  if (broker.qty < want) {
    console.warn(`[TradingV2매도] plan=${planId} ${code} 수량 ${want}→${broker.qty} (키움 매도가능수량)`);
    return { ok: true, qty: broker.qty };
  }
  return { ok: true, qty: want };
};

const executeTradingV2SellOrder = async ({
  kiwoomInfo: kiwoomInfoArg,
  userId,
  stockCode,
  price,
  qty,
  stockMarket = 'KRX',
  planId,
  cycleId = null,
  stageId = null,
  sellStage = 1,
}) => {
  const code = normalizeAutoCode(stockCode, stockMarket);
  const lockKey = v2OrderLockKey('SELL', planId, stageId, cycleId, sellStage);
  if (inflightV2Orders.has(lockKey)) {
    return { success: false, stockCode: code, sellStage, error: '동일 차수 주문 처리 중', message: '동일 차수 주문 처리 중' };
  }
  inflightV2Orders.add(lockKey);
  try {
    if (!canPlaceKrV2Order(stockMarket)) {
      return {
        success: false,
        stockCode: code,
        error: '주문 가능 시간이 아닙니다.',
        message: '주문 가능 시간이 아닙니다.',
      };
    }
    if (!planId) {
      return { success: false, stockCode: code, error: 'planId 없음', message: 'planId 없음' };
    }

    const stillOpen = await assertV2StageStillOpen({
      userId,
      planId,
      side: 'SELL',
      stageId,
      stageNo: sellStage,
      cycleId,
    });
    if (!stillOpen.ok) {
      console.warn(`[TradingV2매도] 중복 스킵: ${code} plan=${planId} ${sellStage}차 ${stillOpen.error}`);
      return { success: false, stockCode: code, sellStage, error: stillOpen.error, message: stillOpen.error };
    }
    const orderStageId = stillOpen.stageId ?? null;

    // trailing 을 건 뒤 청산·다른 매도·수동 매도로 잔량이 줄었을 수 있다 → DB 잔량·키움 매도가능수량으로 다시 제한
    const kiwoomInfo = await resolveLatestKiwoomInfo(userId, kiwoomInfoArg);
    const sized = await resolveSellQty({ userId, planId, cycleId, sellStage, qty, kiwoomInfo, code, stockMarket });
    if (!sized.ok) {
      console.warn(`[TradingV2매도] 수량 스킵: ${code} plan=${planId} ${sellStage}차 ${sized.error}`);
      if (sized.cooldown) markOrderRejected('SELL', planId, code, sized.error);
      return { success: false, stockCode: code, sellStage, error: sized.error, message: sized.error };
    }
    const sellQty = sized.qty;

    const orderData = {
      symbol: code,
      orderType: 'sell',
      quantity: sellQty,
      priceType: 'limit',
      price,
    };

    const unit = stockMarket === 'US' ? '$' : '원';
    console.log(
      `[TradingV2매도] 주문: user=${userId} plan=${planId} ${code} ${sellStage}차 ${price}${unit} x${sellQty}`
    );

    const placed = await submitToBroker({
      kiwoomInfo,
      orderData,
      stockMarket,
      side: 'SELL',
      planId,
      userId,
      code,
    });
    if (!placed.ok) {
      console.error(`[TradingV2매도] 실패: ${code}`, placed.error);
      return { success: false, stockCode: code, sellStage, error: placed.error, message: placed.error };
    }
    const { orderNo } = placed;

    const saved = await saveAcceptedOrderOrBlock({
      userId,
      planId,
      code,
      stockMarket,
      body: {
        side: 'SELL',
        cycleId,
        stageId: orderStageId,
        stageNo: sellStage,
        orderType: 'LIMIT',
        requestedPrice: price,
        requestedQty: sellQty,
        brokerOrderNo: orderNo,
        status: 'submitted',
        markStageOrdered: !!orderStageId,
      },
    });
    if (!saved) {
      return { success: true, stockCode: code, sellStage, orderNo, message: '주문은 접수됐으나 기록 저장에 실패했습니다.' };
    }

    startFillWatchSafe({
      kiwoomInfo,
      userId,
      stockCode: code,
      stockMarket,
      orderNo: String(orderNo),
      orderPrice: price,
      orderQty: sellQty,
      planId,
    });

    console.log(`[TradingV2매도] 접수: ${code} plan=${planId} orderNo=${orderNo}`);
    return { success: true, stockCode: code, sellStage, orderNo, message: '주문이 접수되었습니다.' };
  } catch (error) {
    console.error(`[TradingV2매도] 오류: ${stockCode}`, error.message);
    markOrderRejected('SELL', planId, stockCode, error.message);
    return { success: false, stockCode, sellStage, error: error.message, message: '주문 접수에 실패했습니다.' };
  } finally {
    inflightV2Orders.delete(lockKey);
  }
};

const hasOpenOrderForStage = (plan, side, stageId, cycleId = undefined) => {
  const orders = plan?.orders || [];
  const cycleFilter =
    cycleId !== undefined
      ? cycleId
      : plan?.currentCycleId != null
        ? Number(plan.currentCycleId)
        : null;
  return orders.some((o) => {
    if (String(o.side).toUpperCase() !== String(side).toUpperCase()) return false;
    if (!OPEN_ORDER_STATUSES.has(String(o.status || '').toLowerCase())) return false;
    if (cycleFilter != null) {
      if (o.cycleId != null && Number(o.cycleId) !== Number(cycleFilter)) return false;
      if (o.cycleId == null && o.stageId != null) {
        const st = (plan.stages || []).find((s) => Number(s.id) === Number(o.stageId));
        if (st && Number(st.cycleId) !== Number(cycleFilter)) return false;
      }
    }
    if (stageId != null) {
      return o.stageId == null || Number(o.stageId) === Number(stageId);
    }
    return true;
  });
};

module.exports = {
  executeTradingV2BuyOrder,
  executeTradingV2SellOrder,
  hasOpenOrderForStage,
  isV2OrderOnCooldown,
  OPEN_ORDER_STATUSES,
};

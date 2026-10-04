/**
 * Trading V2 — trailing 발동 시 키움 주문 + trading_orders/stages 반영
 * (레거시 auto_tradings 미사용)
 */

const { placeAutoMarketOrder, normalizeAutoCode, isSessionOpenForMarket } = require('./autoTradingMarket');
const { createTradingOrder, getTradingPlanById } = require('./tradingV2Store');

const OPEN_ORDER_STATUSES = new Set(['pending', 'submitted', 'partial']);
const inflightV2Orders = new Set();

const v2OrderLockKey = (side, planId, stageId, cycleId, stageNo) =>
  `${String(side).toUpperCase()}:${planId}:${stageId || 0}:${cycleId || 0}:${stageNo || 0}`;

const canPlaceKrV2Order = (stockMarket) => isSessionOpenForMarket(stockMarket);

const assertV2StageStillOpen = async ({ userId, planId, side, stageId, cycleId }) => {
  if (!planId) return { ok: false, error: 'planId 없음' };
  const plan = await getTradingPlanById(userId, planId);
  if (!plan) return { ok: false, error: '플랜을 찾을 수 없습니다.' };
  if (String(plan.status) !== 'active') {
    return { ok: false, error: `플랜이 활성 상태가 아닙니다 (${plan.status})` };
  }
  if (hasOpenOrderForStage(plan, side, stageId, cycleId)) {
    return { ok: false, error: '이미 미체결 주문이 있습니다.' };
  }
  if (stageId) {
    const st = (plan.stages || []).find((s) => Number(s.id) === Number(stageId));
    if (st && String(st.status) !== 'pending') {
      return { ok: false, error: `이미 진행된 차수입니다 (${st.status})` };
    }
  }
  return { ok: true };
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
  kiwoomInfo,
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
      cycleId,
    });
    if (!stillOpen.ok) {
      console.warn(`[TradingV2매수] 중복 스킵: ${code} plan=${planId} ${buyStage}차 ${stillOpen.error}`);
      return { success: false, stockCode: code, buyStage, error: stillOpen.error, message: stillOpen.error };
    }

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
      console.warn(`[TradingV2매수] 시드 검사 실패(계속):`, err.message);
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

    const result = await placeAutoMarketOrder(kiwoomInfo, orderData, stockMarket);
    if (result.return_code !== undefined && result.return_code !== 0) {
      const errorMsg = result.return_msg || '주문 실패';
      console.error(`[TradingV2매수] 실패: ${code}`, errorMsg);
      return { success: false, stockCode: code, buyStage, error: errorMsg, message: errorMsg };
    }

    const orderNo = result.orderNo || result.ord_no || null;
    if (!orderNo) {
      return {
        success: false,
        stockCode: code,
        error: '주문번호를 받을 수 없습니다.',
        message: '주문 접수에 실패했습니다.',
      };
    }

    await createTradingOrder(userId, planId, {
      side: 'BUY',
      cycleId,
      stageId,
      stageNo: buyStage,
      orderType: 'LIMIT',
      requestedPrice: price,
      requestedQty: orderQty,
      brokerOrderNo: String(orderNo),
      status: 'submitted',
      markStageOrdered: !!stageId,
    });

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
    return { success: false, stockCode, buyStage, error: error.message, message: '주문 접수에 실패했습니다.' };
  } finally {
    inflightV2Orders.delete(lockKey);
  }
};

/**
 * @param {object} args
 */
const executeTradingV2SellOrder = async ({
  kiwoomInfo,
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
      cycleId,
    });
    if (!stillOpen.ok) {
      console.warn(`[TradingV2매도] 중복 스킵: ${code} plan=${planId} ${sellStage}차 ${stillOpen.error}`);
      return { success: false, stockCode: code, sellStage, error: stillOpen.error, message: stillOpen.error };
    }

    const orderData = {
      symbol: code,
      orderType: 'sell',
      quantity: qty,
      priceType: 'limit',
      price,
    };

    const unit = stockMarket === 'US' ? '$' : '원';
    console.log(
      `[TradingV2매도] 주문: user=${userId} plan=${planId} ${code} ${sellStage}차 ${price}${unit} x${qty}`
    );

    const result = await placeAutoMarketOrder(kiwoomInfo, orderData, stockMarket);
    if (result.return_code !== undefined && result.return_code !== 0) {
      const errorMsg = result.return_msg || '주문 실패';
      console.error(`[TradingV2매도] 실패: ${code}`, errorMsg);
      return { success: false, stockCode: code, sellStage, error: errorMsg, message: errorMsg };
    }

    const orderNo = result.orderNo || result.ord_no || null;
    if (!orderNo) {
      return {
        success: false,
        stockCode: code,
        error: '주문번호를 받을 수 없습니다.',
        message: '주문 접수에 실패했습니다.',
      };
    }

    await createTradingOrder(userId, planId, {
      side: 'SELL',
      cycleId,
      stageId,
      stageNo: sellStage,
      orderType: 'LIMIT',
      requestedPrice: price,
      requestedQty: qty,
      brokerOrderNo: String(orderNo),
      status: 'submitted',
      markStageOrdered: !!stageId,
    });

    startFillWatchSafe({
      kiwoomInfo,
      userId,
      stockCode: code,
      stockMarket,
      orderNo: String(orderNo),
      orderPrice: price,
      orderQty: qty,
      planId,
    });

    console.log(`[TradingV2매도] 접수: ${code} plan=${planId} orderNo=${orderNo}`);
    return { success: true, stockCode: code, sellStage, orderNo, message: '주문이 접수되었습니다.' };
  } catch (error) {
    console.error(`[TradingV2매도] 오류: ${stockCode}`, error.message);
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
  OPEN_ORDER_STATUSES,
};

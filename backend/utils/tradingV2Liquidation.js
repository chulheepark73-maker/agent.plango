/**
 * Trading V2 — 보유종목 일괄청산
 * 1) 플랜 paused (감시·trailing 중지) 2) 미체결 주문 취소 3) 잔량 매도 (order_reason=LIQUIDATE)
 *    - 국내: 최유리지정가 (KRX 09:00~15:20)
 *    - 미국: 화면 표시 시세 지정가 (프리·정규·애프터 04:00~20:00 ET)
 * 체결 후 처리: tradingV2Fill.finalizeAfterComplete → 차수 재오픈/새 cycle 없이 플랜 completed
 */

const pool = require('./db');
const { getKiwoomInfo, validateKiwoomInfo } = require('./kiwoomUtils');
const { getTradingPlanById, createTradingOrder, ensureTradingV2Tables } = require('./tradingV2Store');
const { avgCostFromPlanFills, netFilledQtyForSplitStage } = require('./infiniteTradeBands');
const {
  placeAutoMarketOrder,
  normalizeAutoCode,
  isUsMarket,
  resolveUsStexTpPreferMaster,
} = require('./autoTradingMarket');
const { extractPriceData, isWeekend, isHolidaySync, isUsTradingHours } = require('./stockUtils');

const LOG = '[TradingV2청산]';
const LIQUIDATE_REASON = 'LIQUIDATE';
const OPEN_STATUSES = ['pending', 'submitted', 'partial'];
const inflightPlans = new Set();

const kstMinutes = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  return h * 60 + m;
};

/** 최유리지정가는 KRX 정규 접속매매(09:00~15:20)에서만 가능 */
const isLiquidationSessionOpen = () => {
  if (isWeekend() || isHolidaySync()) return false;
  const t = kstMinutes();
  return t >= 9 * 60 && t < 15 * 60 + 20;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchCurrentPrice = async (kiwoomInfo, code6) => {
  try {
    const kiwoomAPI = require('../services/kiwoomApi');
    const info = await kiwoomAPI.getStockInfo(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      code6,
      'N',
      '',
      'KRX'
    );
    const { price } = extractPriceData(info);
    return Number(price) > 0 ? Number(price) : null;
  } catch {
    return null;
  }
};

const cancelOpenOrdersForPlan = async (userId, plan, kiwoomInfo, isUs) => {
  const kiwoomAPI = require('../services/kiwoomApi');
  const { markOrderCancelledAndReopenStage } = require('./tradingV2EodUnfilledScheduler');
  const open = (plan.orders || []).filter((o) =>
    OPEN_STATUSES.includes(String(o.status || '').toLowerCase())
  );
  const symbol = String(plan.instrument?.symbol || '').trim();
  const code6 = symbol.substring(0, 6);
  const venue = String(plan.venue?.exchange || '').toUpperCase() === 'NXT' ? 'NXT' : 'KRX';
  const usStex =
    isUs && open.length > 0
      ? await resolveUsStexTpPreferMaster(symbol, plan.venue?.exchange || null)
      : null;

  for (const order of open) {
    if (order.brokerOrderNo) {
      try {
        if (isUs) {
          await kiwoomAPI.cancelUsOrder(
            { symbol: symbol.toUpperCase(), orderNo: order.brokerOrderNo },
            kiwoomInfo.accessToken,
            kiwoomInfo.appKey,
            kiwoomInfo.appSecret,
            kiwoomInfo.accountNo,
            usStex
          );
        } else {
          await kiwoomAPI.cancelOrder(
            { symbol: code6, orderNo: order.brokerOrderNo, quantity: 0 },
            kiwoomInfo.accessToken,
            kiwoomInfo.appKey,
            kiwoomInfo.appSecret,
            kiwoomInfo.accountNo,
            venue
          );
        }
        console.log(`${LOG}[${userId}] 미체결 취소 plan=${plan.id} ${order.side} ord=${order.brokerOrderNo}`);
      } catch (err) {
        // 이미 체결/취소된 주문은 키움이 거부 → DB만 정리
        console.warn(
          `${LOG}[${userId}] 취소 응답 오류(DB 정리 계속) plan=${plan.id} ord=${order.brokerOrderNo}: ${err.message || err}`
        );
      }
      try {
        require('./tradingV2FillRestBackup').stopTradingV2FillWatch(userId, order.brokerOrderNo);
      } catch {
        /* ignore */
      }
    }
    await markOrderCancelledAndReopenStage({ id: order.id, stageId: order.stageId });
  }
  return open.length;
};

/** 청산 매도 대상: 분할 = 차수별 잔량 / 무한 = cycle 잔량 1건 */
const buildSellLegs = (plan) => {
  const cycleId = plan.currentCycleId != null ? Number(plan.currentCycleId) : null;
  if (String(plan.strategyType).toUpperCase() === 'INFINITE_TRADE') {
    const { remQty } = avgCostFromPlanFills(plan, { cycleId, includeSubmitted: false });
    const qty = Math.floor(remQty);
    return qty > 0 ? [{ stageId: null, stageNo: 1, cycleId, qty }] : [];
  }
  const stages = (plan.stages || []).filter((s) => !cycleId || Number(s.cycleId) === cycleId);
  const legs = [];
  for (const buySt of stages.filter((s) => String(s.side).toUpperCase() === 'BUY')) {
    const stageNo = Number(buySt.stage);
    const qty = Math.floor(netFilledQtyForSplitStage(plan, stageNo, cycleId));
    if (!(qty > 0)) continue;
    const sellSt = stages.find(
      (s) => String(s.side).toUpperCase() === 'SELL' && Number(s.stage) === stageNo
    );
    legs.push({ stageId: sellSt ? Number(sellSt.id) : null, stageNo, cycleId, qty });
  }
  return legs.sort((a, b) => a.stageNo - b.stageNo);
};

const liquidatePlan = async (userId, planId, kiwoomInfo, { limitPrice = null } = {}) => {
  const uid = String(userId);
  const id = Number(planId);
  let plan = await getTradingPlanById(uid, id);
  if (!plan) return { planId: id, ok: false, error: '플랜을 찾을 수 없습니다.' };

  const symbol = String(plan.instrument?.symbol || '').trim();
  const market = String(plan.instrument?.market || '').toUpperCase();
  const isUs = market === 'US' || isUsMarket(market, symbol);
  const rawLimit = Number(limitPrice) || 0;
  const usLimit =
    rawLimit >= 1 ? Math.round(rawLimit * 100) / 100 : Math.round(rawLimit * 10000) / 10000;
  if (isUs) {
    if (!isUsTradingHours()) {
      return { planId: id, ok: false, error: '미국 주문 가능 시간(ET 04:00~20:00)이 아닙니다.' };
    }
    if (!(usLimit > 0)) {
      return { planId: id, ok: false, error: '표시된 시세가 없어 지정가를 정할 수 없습니다.' };
    }
  } else if (!isLiquidationSessionOpen()) {
    return { planId: id, ok: false, error: '국내 일괄청산은 정규장 09:00~15:20에만 가능합니다.' };
  }
  const status = String(plan.status || '').toLowerCase();
  if (status !== 'active' && status !== 'paused') {
    return { planId: id, ok: false, error: `청산할 수 없는 플랜 상태입니다 (${plan.status})` };
  }

  // 1) 감시 중지 — paused 가 되면 모니터가 새 매수/매도를 내지 않음
  await pool.query(
    `UPDATE trading_plans SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2`,
    [id, uid]
  );
  try {
    const { stopV2BuyTrailingsByPlanId } = require('./autoTradingBuyTrailingStop');
    const { stopV2SellTrailingsByPlanId } = require('./autoTradingTrailingStop');
    stopV2BuyTrailingsByPlanId(id, { silent: true });
    stopV2SellTrailingsByPlanId(id, { silent: true });
  } catch (err) {
    console.warn(`${LOG}[${uid}] trailing 중지 실패 plan=${id}:`, err.message);
  }

  // 2) 미체결 취소 후 체결 이벤트 반영 시간 확보
  const cancelled = await cancelOpenOrdersForPlan(uid, plan, kiwoomInfo, isUs);
  if (cancelled > 0) await sleep(800);
  plan = await getTradingPlanById(uid, id);

  // 3) 잔량 매도
  const legs = buildSellLegs(plan);
  if (!legs.length) {
    await markPlanLiquidated(uid, id, plan.currentCycleId);
    return { planId: id, ok: true, orders: [], cancelled, message: '보유 잔량이 없어 플랜을 종료했습니다.' };
  }

  const stockMarket = isUs ? 'US' : 'KRX';
  const code = isUs ? symbol.toUpperCase() : normalizeAutoCode(symbol, 'KRX');
  const refPrice = isUs ? usLimit : await fetchCurrentPrice(kiwoomInfo, code.substring(0, 6));
  const orders = [];
  for (const leg of legs) {
    try {
      const result = await placeAutoMarketOrder(
        kiwoomInfo,
        isUs
          ? { symbol: code, orderType: 'sell', quantity: leg.qty, priceType: 'limit', price: usLimit }
          : { symbol: code, orderType: 'sell', quantity: leg.qty, priceType: 'best' },
        stockMarket
      );
      const orderNo = result?.orderNo || result?.ord_no || null;
      if (!orderNo) throw new Error(result?.return_msg || '주문번호를 받을 수 없습니다.');

      await createTradingOrder(uid, id, {
        side: 'SELL',
        cycleId: leg.cycleId,
        stageId: leg.stageId,
        stageNo: leg.stageNo,
        orderType: isUs ? 'LIMIT' : 'BEST',
        requestedPrice: refPrice,
        requestedQty: leg.qty,
        brokerOrderNo: String(orderNo),
        status: 'submitted',
        markStageOrdered: !!leg.stageId,
        orderReason: LIQUIDATE_REASON,
      });
      try {
        require('./tradingV2FillRestBackup').startTradingV2FillWatch({
          kiwoomInfo,
          userId: uid,
          stockCode: code,
          stockMarket,
          orderNo: String(orderNo),
          orderPrice: refPrice || 0,
          orderQty: leg.qty,
          planId: id,
        });
      } catch (err) {
        console.error(`${LOG}[${uid}] 체결감시 등록 실패:`, err.message);
      }
      console.log(
        `${LOG}[${uid}] 매도 접수 plan=${id} ${code} ${leg.stageNo}차 x${leg.qty} ` +
          `${isUs ? `지정가 $${usLimit}` : '최유리'} ord=${orderNo}`
      );
      orders.push({ stageNo: leg.stageNo, qty: leg.qty, orderNo: String(orderNo), ok: true });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`${LOG}[${uid}] 매도 실패 plan=${id} ${code} ${leg.stageNo}차:`, msg);
      orders.push({ stageNo: leg.stageNo, qty: leg.qty, ok: false, error: msg });
    }
  }

  const okCount = orders.filter((o) => o.ok).length;
  return {
    planId: id,
    strategyType: plan.strategyType,
    ok: okCount > 0,
    cancelled,
    orders,
    error: okCount === 0 ? orders[0]?.error || '매도 주문 실패' : undefined,
  };
};

/** cycle 종료 + 플랜 completed */
const markPlanLiquidated = async (userId, planId, cycleId) => {
  await ensureTradingV2Tables();
  if (cycleId != null) {
    await pool.query(
      `UPDATE trading_cycles
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'open'`,
      [Number(cycleId)]
    );
  }
  await pool.query(
    `UPDATE trading_plans SET status = 'completed', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND user_id = $2`,
    [Number(planId), String(userId)]
  );
  try {
    require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
  } catch {
    /* ignore */
  }
};

/**
 * 청산 매도 완전체결 후 — 잔량 0 이고 남은 청산 주문이 없으면 플랜 종료
 * @returns {Promise<boolean>} 종료 여부
 */
const finalizeLiquidationIfDone = async (userId, planId) => {
  const uid = String(userId);
  const plan = await getTradingPlanById(uid, planId);
  if (!plan) return false;
  const cycleId = plan.currentCycleId != null ? Number(plan.currentCycleId) : null;
  const hasOpenLiquidation = (plan.orders || []).some(
    (o) =>
      o.orderReason === LIQUIDATE_REASON &&
      OPEN_STATUSES.includes(String(o.status || '').toLowerCase())
  );
  if (hasOpenLiquidation) return false;
  const { remQty } = avgCostFromPlanFills(plan, { cycleId, includeSubmitted: false });
  if (remQty > 0) return false;
  await markPlanLiquidated(uid, plan.id, cycleId);
  console.log(`${LOG}[${uid}] 청산 완료 → 플랜 종료 plan=${plan.id}`);
  return true;
};

/**
 * @param {string|number} userId
 * @param {number[]} planIds
 * @param {{ limitPrice?: number|null }} [opts] 미국: 화면 표시 시세 (지정가)
 */
const liquidatePlans = async (userId, planIds, opts = {}) => {
  const uid = String(userId);
  const kiwoomInfo = await getKiwoomInfo(uid);
  const validationError = validateKiwoomInfo(kiwoomInfo);
  if (validationError || !kiwoomInfo?.accessToken) {
    const err = new Error(validationError?.error || validationError || '키움 연결 정보가 없습니다.');
    err.status = 400;
    throw err;
  }

  const ids = [...new Set((planIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const results = [];
  for (const id of ids) {
    const lockKey = `${uid}:${id}`;
    if (inflightPlans.has(lockKey)) {
      results.push({ planId: id, ok: false, error: '청산 처리 중입니다.' });
      continue;
    }
    inflightPlans.add(lockKey);
    try {
      results.push(await liquidatePlan(uid, id, kiwoomInfo, { limitPrice: opts.limitPrice }));
    } catch (err) {
      console.error(`${LOG}[${uid}] plan=${id} 오류:`, err.message);
      results.push({ planId: id, ok: false, error: err.message });
    } finally {
      inflightPlans.delete(lockKey);
    }
  }

  try {
    require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
  } catch {
    /* ignore */
  }
  return results;
};

module.exports = {
  LIQUIDATE_REASON,
  liquidatePlans,
  finalizeLiquidationIfDone,
};

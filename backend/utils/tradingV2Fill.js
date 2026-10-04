/**
 * Trading V2 — 키움 WS/REST 체결 → trading_fills / stage
 * - 부분체결: fills 적재 + order=partial, stage 유지(ordered)
 * - 완전체결: order=filled + stage filled + 분할 재오픈 / 감시 갱신
 */

const {
  findTradingOrderByBrokerNo,
  createTradingFill,
  sumFilledQtyForOrder,
  updateTradingOrderStatus,
  markTradingStageFilled,
  reopenSplitStageAfterSell,
} = require('./tradingV2Store');
const { roundFillPrice, normalizeAutoCode, isUsMarket } = require('./autoTradingMarket');
const { parseAbsPrice } = require('./orderExecutionPrice');

const LOG = '[TradingV2체결]';

const notifyV2Refresh = () => {
  try {
    require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
  } catch {
    /* ignore */
  }
};

const stopFillWatch = (userId, orderNo) => {
  try {
    require('./tradingV2FillRestBackup').stopTradingV2FillWatch(userId, orderNo);
  } catch {
    /* ignore */
  }
};

const resolveStockMarket = (matched) => {
  if (String(matched.market || '').toUpperCase() === 'US' || isUsMarket(matched.market, matched.symbol)) {
    return 'US';
  }
  return matched.exchange === 'NXT' ? 'NXT' : 'KRX';
};

const isLooksComplete = (evt, requestedQty, filledAfter) => {
  if (evt?.fullyFilled) return true;
  if (evt?.unexecQty === 0 && (evt?.execQty > 0 || filledAfter > 0)) return true;
  if (evt?.orderQty > 0 && (evt.execQty >= evt.orderQty || filledAfter >= evt.orderQty)) return true;
  if (requestedQty > 0 && filledAfter >= requestedQty) return true;
  return false;
};

/**
 * 체결분 반영 (부분/완전 공용)
 * @returns {Promise<{ok:boolean, complete?:boolean, side?:string, planId?:number}|null>}
 */
async function applyTradingV2FillProgress({
  userId,
  matched,
  execPrice,
  execQty,
  brokerFillNo = null,
  forceComplete = false,
  source = 'ws',
}) {
  if (!matched?.order || !(execQty > 0) || !(execPrice > 0)) return null;

  const order = matched.order;
  const uid = String(userId);
  const requestedQty = Number(order.requestedQty) || 0;
  const existingSum = await sumFilledQtyForOrder(order.id);
  const remaining = requestedQty > 0 ? Math.max(0, requestedQty - existingSum) : execQty;

  // 이미 완결된 수량이면 상태만 정리
  if (requestedQty > 0 && existingSum >= requestedQty) {
    if (String(order.status).toLowerCase() !== 'filled') {
      await updateTradingOrderStatus(order.id, 'filled');
      if (order.stageId) await markTradingStageFilled(order.stageId);
    }
    stopFillWatch(uid, order.brokerOrderNo);
    await finalizeAfterComplete(uid, matched, order);
    return { ok: true, complete: true, side: String(order.side).toLowerCase(), planId: matched.planId };
  }

  const qtyToAdd = remaining > 0 ? Math.min(execQty, remaining) : execQty;
  if (!(qtyToAdd > 0)) return null;

  const filledAfter = existingSum + qtyToAdd;
  const complete =
    forceComplete ||
    (requestedQty > 0 && filledAfter >= requestedQty);

  console.log(
    `${LOG}[${uid}] ${order.side} ${complete ? '완전' : '부분'}(${source}): plan=${matched.planId} ` +
      `order=${order.id} ${matched.symbol} @${execPrice} +${qtyToAdd} ` +
      `(${existingSum}→${filledAfter}/${requestedQty || '?'})`
  );

  await createTradingFill(uid, matched.planId, order.id, {
    fillPrice: execPrice,
    fillQty: qtyToAdd,
    brokerFillNo,
    orderStatus: complete ? 'filled' : 'partial',
    markStageFilled: complete && !!order.stageId,
  });

  if (!complete) {
    return {
      ok: true,
      complete: false,
      side: String(order.side).toLowerCase(),
      planId: matched.planId,
      orderId: order.id,
    };
  }

  stopFillWatch(uid, order.brokerOrderNo);
  await finalizeAfterComplete(uid, matched, order);
  return {
    ok: true,
    complete: true,
    side: String(order.side).toLowerCase(),
    planId: matched.planId,
    orderId: order.id,
    strategyType: matched.strategyType,
  };
}

async function finalizeAfterComplete(userId, matched, order) {
  const side = String(order.side || '').toUpperCase();
  if (side === 'SELL' && order.orderReason === 'LIQUIDATE') {
    try {
      const { finalizeLiquidationIfDone } = require('./tradingV2Liquidation');
      await finalizeLiquidationIfDone(userId, matched.planId);
    } catch (err) {
      console.error(`${LOG}[${userId}] 청산 마무리 실패 plan=${matched.planId}:`, err.message);
    }
    notifyV2Refresh();
    return;
  }
  if (side === 'SELL' && matched.strategyType === 'SPLIT_TRADE' && order.stageId) {
    try {
      // 매도 체결 직후 남은/스테일 sell trailing 즉시 중지 (재오픈 전)
      try {
        const { stopV2SellTrailingsByPlanId } = require('./autoTradingTrailingStop');
        stopV2SellTrailingsByPlanId(matched.planId, {
          silent: true,
          reason: '매도 체결·재오픈',
        });
      } catch {
        /* ignore */
      }

      const reopened = await reopenSplitStageAfterSell(
        userId,
        matched.planId,
        order.stageId,
        order.stageNo
      );
      if (reopened) {
        console.log(
          `${LOG}[${userId}] 분할 ${reopened.stageNo}차 매도후 재오픈 → ${reopened.stageNo}차 매수 감시`
        );
        try {
          const { requestSymbolRefreshSoon } = require('../services/autoTradingWsMonitor_v2');
          requestSymbolRefreshSoon();
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.error(`${LOG}[${userId}] 분할 재오픈 실패:`, err.message);
    }
  }

  // 무한: 현재 cycle 전량 익절 → cycle 종료 + 새 cycle (entry부터 다시)
  if (side === 'SELL' && matched.strategyType === 'INFINITE_TRADE') {
    try {
      const { getTradingPlanById, openNewCycle } = require('./tradingV2Store');
      const { avgCostFromPlanFills } = require('./infiniteTradeBands');
      const plan = await getTradingPlanById(userId, matched.planId);
      if (plan) {
        const cycleId =
          order.cycleId != null
            ? Number(order.cycleId)
            : plan.currentCycleId != null
              ? Number(plan.currentCycleId)
              : null;
        const { remQty } = avgCostFromPlanFills(plan, { cycleId });
        if (remQty <= 0) {
          try {
            const { stopV2SellTrailingsByPlanId } = require('./autoTradingTrailingStop');
            stopV2SellTrailingsByPlanId(matched.planId, {
              silent: true,
              reason: '전량 익절',
            });
          } catch {
            /* ignore */
          }
          const next = await openNewCycle(userId, matched.planId);
          const newNo = next?.cycles?.slice(-1)?.[0]?.cycleNo;
          console.log(
            `${LOG}[${userId}] 무한 전량익절 → cycle 종료, 새 cycle=${newNo ?? '?'} plan=${matched.planId}`
          );
        }
      }
    } catch (err) {
      console.error(`${LOG}[${userId}] 무한 새 cycle 실패:`, err.message);
    }
  }

  notifyV2Refresh();
}

/**
 * @param {string} userId
 * @param {object} evt parseOrderFillEvent 결과
 * @returns {Promise<{ok:boolean, side?:string, planId?:number}|null>}
 */
async function tryCompleteTradingV2Fill(userId, evt) {
  if (!evt?.orderNo || !(evt.execQty > 0)) return null;

  let matched;
  try {
    matched = await findTradingOrderByBrokerNo(userId, evt.orderNo);
  } catch (err) {
    console.error(`${LOG}[${userId}] 주문 조회 실패:`, err.message);
    return null;
  }
  if (!matched?.order) return null;

  const order = matched.order;
  const stockMarket = resolveStockMarket(matched);

  if (evt.stockCode) {
    const code = normalizeAutoCode(matched.symbol, stockMarket);
    const evtCode = normalizeAutoCode(evt.stockCode, stockMarket);
    if (code && evtCode && code !== evtCode && code.toUpperCase() !== evtCode.toUpperCase()) {
      console.log(
        `${LOG}[${userId}] 종목 불일치 skip: order=${code} evt=${evtCode} ord=${evt.orderNo}`
      );
      return null;
    }
  }

  const execPriceRaw =
    parseAbsPrice(evt.execPrice) > 0 ? parseAbsPrice(evt.execPrice) : order.requestedPrice;
  const execPrice = roundFillPrice(execPriceRaw, stockMarket) || order.requestedPrice;
  const execQty = Number(evt.execQty) || 0;
  const requestedQty = Number(order.requestedQty) || 0;
  const existingSum = await sumFilledQtyForOrder(order.id);
  const filledAfterGuess = existingSum + execQty;
  const complete = isLooksComplete(evt, requestedQty, filledAfterGuess);

  // 부분체결도 fills 적재 (stage는 완전 시에만)
  return applyTradingV2FillProgress({
    userId,
    matched,
    execPrice,
    execQty,
    brokerFillNo: evt.fillNo || evt.brokerFillNo || null,
    forceComplete: complete,
    source: 'ws',
  });
}

/**
 * REST 백업용 — 누적 체결수량 기준으로 부분/완전 반영
 * @param {object} args
 * @param {number} args.restExecQty 해당 주문 REST 누적 체결수량
 * @param {number} args.restExecPrice 평균 체결가
 */
async function applyTradingV2RestFill({ userId, orderNo, restExecQty, restExecPrice }) {
  if (!orderNo || !(restExecQty > 0)) return null;

  let matched;
  try {
    matched = await findTradingOrderByBrokerNo(userId, orderNo);
  } catch (err) {
    console.error(`${LOG}[${userId}] REST 주문 조회 실패:`, err.message);
    return null;
  }
  if (!matched?.order) return null;

  const order = matched.order;
  const stockMarket = resolveStockMarket(matched);
  const existingSum = await sumFilledQtyForOrder(order.id);
  const requestedQty = Number(order.requestedQty) || 0;
  const delta = Math.max(0, Number(restExecQty) - existingSum);

  if (!(delta > 0)) {
    if (requestedQty > 0 && existingSum >= requestedQty) {
      if (String(order.status).toLowerCase() !== 'filled') {
        await updateTradingOrderStatus(order.id, 'filled');
        if (order.stageId) await markTradingStageFilled(order.stageId);
      }
      stopFillWatch(userId, order.brokerOrderNo);
      await finalizeAfterComplete(userId, matched, order);
      return { ok: true, complete: true, planId: matched.planId };
    }
    return { ok: true, complete: false, skipped: true };
  }

  const execPrice =
    roundFillPrice(restExecPrice, stockMarket) || order.requestedPrice || 0;
  const forceComplete = requestedQty > 0 && existingSum + delta >= requestedQty;

  return applyTradingV2FillProgress({
    userId,
    matched,
    execPrice,
    execQty: delta,
    brokerFillNo: `rest:${orderNo}:${existingSum + delta}`,
    forceComplete,
    source: 'rest',
  });
}

module.exports = {
  tryCompleteTradingV2Fill,
  applyTradingV2FillProgress,
  applyTradingV2RestFill,
};

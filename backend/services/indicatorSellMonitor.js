/**
 * 지표기반매매 — open 포지션 익절/손절/트레일링 자동매도
 * 시세는 자동매매 WebSocket 틱 우선, REST는 ON 직후 폴백용
 */

const kiwoomAPI = require('./kiwoomApi');
const { aggregateRestExecutions } = require('../utils/orderExecutionPrice');
const {
  REST_BACKUP_FIRST_MS,
  REST_BACKUP_INTERVAL_MS,
  shouldRunRestFillPoll,
  markRestFillPolled,
} = require('../utils/orderFillRestBackup');
const { getKiwoomInfo } = require('../utils/kiwoomUtils');
const { extractPriceData, isNXTTradingHours, isKRXSessionOpen } = require('../utils/stockUtils');
const { isNXTStock } = require('../utils/stockListStore');
const { getTickSize, adjustPriceToTickSize } = require('../utils/priceUtils');
const { getIndicatorTrading } = require('../utils/indicatorTradingStore');
const {
  getOpenPositions,
  updatePositionPriceState,
  markPositionSelling,
  updateSellingOrderDetails,
  markPositionClosed,
  markPositionCancelled,
  revertPositionToOpen,
  insertOrderLog,
  getUnfilledSellPlacesFromOrders,
  getSellingPositions,
  listUserIdsWithSellingPositions,
} = require('../utils/indicatorPositionStore');
const { resolveTradeVenue } = require('../utils/indicatorTradingTracker');

const sellingLocks = new Set(); // `${userId}_${positionId}`
/** @type {Map<string, object>} */
const pendingSellChecks = new Map();
/** @type {Map<string, number>} */
const lastSellRecoverPollAt = new Map();
let pollTimer = null;
let started = false;

const fetchCurrentPrice = async (kiwoomInfo, stockCode) => {
  const attempts = [{ code: stockCode, exchange: 'KRX' }];
  if (await isNXTStock(stockCode)) {
    attempts.push({ code: `${String(stockCode).substring(0, 6)}_NX`, exchange: 'NXT' });
  }

  for (const { code, exchange } of attempts) {
    try {
      const stockInfo = await kiwoomAPI.getStockInfo(
        kiwoomInfo.accessToken,
        kiwoomInfo.appKey,
        kiwoomInfo.appSecret,
        code,
        'N',
        '',
        exchange
      );
      if (stockInfo?.return_code !== undefined && stockInfo.return_code !== 0) continue;
      const { price } = extractPriceData(stockInfo);
      if (price > 0) return Math.round(price);
    } catch (err) {
      if (err?.isRateLimit) throw err;
    }
  }
  return null;
};

const calcProfitRate = (buyPrice, currentPrice) => {
  if (!(buyPrice > 0) || !(currentPrice > 0)) return null;
  return ((currentPrice - buyPrice) / buyPrice) * 100;
};

/**
 * @returns {{ reason: string|null, detail?: string }}
 */
const evaluateSellSignal = (position, currentPrice, settings) => {
  const buyPrice = Number(position.buyFilledPrice ?? position.buyOrderPrice);
  if (!(buyPrice > 0) || !(currentPrice > 0)) {
    return { reason: null };
  }

  const profitRate = calcProfitRate(buyPrice, currentPrice);
  const high = Math.max(
    Number(position.highPriceSinceBuy) || buyPrice,
    currentPrice,
    buyPrice
  );
  const dropFromHighPct = ((currentPrice - high) / high) * 100;

  if (settings.useStopLoss) {
    const sl = Number(settings.stopLossPercent);
    if (Number.isFinite(sl) && profitRate <= sl) {
      return { reason: 'stop_loss', detail: `수익률 ${profitRate.toFixed(2)}% ≤ 손절 ${sl}%` };
    }
  }

  if (settings.useTrailingStop) {
    const armPct = Number(settings.trailingStopOnPercent);
    const trailPct = Number(settings.trailingStopFromHighPercent);
    const highProfit = calcProfitRate(buyPrice, high);
    if (
      Number.isFinite(armPct) &&
      Number.isFinite(trailPct) &&
      highProfit != null &&
      highProfit >= armPct &&
      dropFromHighPct <= trailPct
    ) {
      return {
        reason: 'trailing',
        detail: `고가대비 ${dropFromHighPct.toFixed(2)}% (발동 ${armPct}% / 고가하락 ${trailPct}%)`,
      };
    }
  }

  if (settings.useTakeProfit) {
    const tp = Number(settings.takeProfitPercent);
    if (Number.isFinite(tp) && profitRate >= tp) {
      return { reason: 'take_profit', detail: `수익률 ${profitRate.toFixed(2)}% ≥ 익절 ${tp}%` };
    }
  }

  return { reason: null };
};

const buildSellOrderPrice = (currentPrice, settings) => {
  const tick = getTickSize(currentPrice);
  const offset = Number(settings.sellLimitTickOffset);
  const off = Number.isFinite(offset) ? offset : 0;
  const orderPrice = adjustPriceToTickSize(currentPrice + off * tick);
  return { priceType: 'limit', orderPrice: orderPrice > 0 ? orderPrice : currentPrice };
};

const reasonLabel = (reason) => {
  if (reason === 'take_profit') return '익절';
  if (reason === 'stop_loss') return '손절';
  if (reason === 'trailing') return '트레일링';
  return reason || '매도';
};

const processOpenPosition = async (
  userId,
  kiwoomInfo,
  settings,
  position,
  currentPriceOverride = null
) => {
  const lockKey = `${userId}_${position.id}`;
  if (sellingLocks.has(lockKey)) return null;

  let currentPrice =
    currentPriceOverride != null && Number(currentPriceOverride) > 0
      ? Math.round(Number(currentPriceOverride))
      : null;
  if (!(currentPrice > 0)) {
    currentPrice = await fetchCurrentPrice(kiwoomInfo, position.stockCode);
  }
  if (!(currentPrice > 0)) return null;

  const buyPrice = Number(position.buyFilledPrice ?? position.buyOrderPrice);
  const profitRate = calcProfitRate(buyPrice, currentPrice);
  const prevHigh = Number(position.highPriceSinceBuy) || buyPrice || currentPrice;
  const high = Math.max(prevHigh, currentPrice);

  await updatePositionPriceState(userId, position.id, {
    lastPrice: currentPrice,
    highPriceSinceBuy: high,
    lastProfitRate: profitRate,
  });

  const signal = evaluateSellSignal(
    { ...position, highPriceSinceBuy: high },
    currentPrice,
    settings
  );
  if (!signal.reason) return null;

  const venue = await resolveTradeVenue(position.stockCode);
  if (!venue.ok) {
    console.log(
      `[지표기반매매매도] 스킵 ${position.stockCode}: ${venue.reason} (${reasonLabel(signal.reason)})`
    );
    return null;
  }

  const qty = Number(position.buyFilledQty || position.buyQty) || 0;
  if (qty < 1) return null;

  const { priceType, orderPrice } = buildSellOrderPrice(currentPrice, settings);

  sellingLocks.add(lockKey);
  try {
    // CAS로 open → selling (동시 틱 중복 방지)
    const claimed = await markPositionSelling(userId, position.id, {
      sellOrderNo: null,
      sellOrderPrice: orderPrice,
      sellQty: qty,
      sellReason: signal.reason,
    });
    if (!claimed) return null;

    console.log(
      `[지표기반매매매도] ${reasonLabel(signal.reason)} 주문: ${position.stockCode} ` +
        `현재=${currentPrice} 주문=${orderPrice}(${priceType}) qty=${qty} ` +
        `${signal.detail || ''}`
    );

    const orderRes = await kiwoomAPI.placeOrder(
      {
        symbol: position.stockCode,
        orderType: 'sell',
        quantity: qty,
        priceType,
        price: orderPrice,
      },
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      kiwoomInfo.accountNo,
      venue.market
    );

    if (orderRes?.return_code !== undefined && orderRes.return_code !== 0) {
      const failMsg = String(orderRes.return_msg || orderRes.return_code || '');
      if (failMsg.includes('매도가능수량') || failMsg.includes('800033')) {
        await markPositionCancelled(userId, position.id, 'no_sellable_qty');
        console.error(
          `[지표기반매매매도] 보유 없음 → 포지션 취소 ${position.stockCode}:`,
          failMsg
        );
      } else {
        await revertPositionToOpen(userId, position.id);
        console.error(
          `[지표기반매매매도] 주문 실패 ${position.stockCode}:`,
          failMsg
        );
      }
      return null;
    }

    const orderNo =
      orderRes?.orderNo ||
      orderRes?.ord_no ||
      orderRes?.order_no ||
      orderRes?.ODNO ||
      orderRes?.data?.ord_no ||
      '';

    if (!orderNo) {
      await revertPositionToOpen(userId, position.id);
      console.error(`[지표기반매매매도] 주문번호 없음 ${position.stockCode}`);
      return null;
    }

    await insertOrderLog(userId, {
      positionId: position.id,
      stockCode: position.stockCode,
      side: 'sell',
      action: 'place',
      venue: venue.market,
      priceType,
      orderPrice,
      qty,
      orderNo,
      reason: signal.reason,
      rawMessage: signal.detail || null,
    });

    // 체결 전엔 closed 하지 않음 — selling 유지 (OFF 시 미체결 취소 가능)
    await updateSellingOrderDetails(userId, position.id, {
      sellOrderNo: orderNo,
      sellOrderPrice: orderPrice,
      sellQty: qty,
      sellReason: signal.reason,
    });

    registerIndicatorSellPending({
      kiwoomInfo,
      userId,
      positionId: position.id,
      stockCode: position.stockCode,
      stockName: position.stockName,
      venue: venue.market,
      orderNo,
      orderPrice,
      qty,
      priceType,
      reason: signal.reason,
    });

    return {
      stockCode: position.stockCode,
      reason: signal.reason,
      orderNo,
      orderPrice,
      qty,
      closed: null,
    };
  } catch (err) {
    const msg = String(err.message || err || '');
    try {
      if (msg.includes('매도가능수량') || msg.includes('800033')) {
        await markPositionCancelled(userId, position.id, 'no_sellable_qty');
        console.error(
          `[지표기반매매매도] 보유 없음 → 포지션 취소 ${position.stockCode}:`,
          msg
        );
      } else {
        await revertPositionToOpen(userId, position.id);
        console.error(`[지표기반매매매도] 예외 ${position.stockCode}:`, msg);
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  } finally {
    sellingLocks.delete(lockKey);
  }
};

/**
 * 자동매매 WS 틱에서 호출 — REST 시세 없이 currentPrice로 익절/손절 평가
 */
const processIndicatorSellOnTick = async (userId, stockCode, currentPrice, kiwoomInfo) => {
  if (!(Number(currentPrice) > 0)) return null;

  const state = await getIndicatorTrading(userId);
  if (!state.autoTradingEnabled) return null;

  let info = kiwoomInfo;
  if (!info?.accessToken) {
    info = await getKiwoomInfo(userId);
  }
  if (!info?.accessToken) return null;

  if (!isKRXSessionOpen() && !isNXTTradingHours()) return null;

  const code6 = String(stockCode || '').substring(0, 6);
  const positions = await getOpenPositions(userId);
  const position = positions.find(
    (p) => String(p.stockCode || '').substring(0, 6) === code6
  );
  if (!position) return null;

  return processOpenPosition(userId, info, state.settings || {}, position, currentPrice);
};

/** 구독 목록용 — 지표기반매매 ON + open 포지션 */
const listIndicatorOpenSymbolsForWs = async (userId) => {
  const state = await getIndicatorTrading(userId);
  if (!state.autoTradingEnabled) return [];
  const positions = await getOpenPositions(userId);
  const out = [];
  for (const p of positions) {
    const code6 = String(p.stockCode || '').substring(0, 6);
    if (!code6) continue;
    const isNxt = await isNXTStock(p.stockCode);
    out.push({
      stockCode: code6,
      stockName: p.stockName || code6,
      stockMarket: isNxt ? 'NXT' : 'KRX',
    });
  }
  return out;
};

const processUser = async (userId) => {
  const state = await getIndicatorTrading(userId);
  if (!state.autoTradingEnabled) return [];

  const kiwoomInfo = await getKiwoomInfo(userId);
  if (!kiwoomInfo?.accessToken) return [];

  if (!isKRXSessionOpen() && !isNXTTradingHours()) return [];

  const positions = await getOpenPositions(userId);
  if (!positions.length) return [];

  const settings = state.settings || {};
  const logs = [];
  for (const pos of positions) {
    try {
      const result = await processOpenPosition(userId, kiwoomInfo, settings, pos);
      if (result) {
        logs.push(
          `[${result.stockCode}] ${reasonLabel(result.reason)} 매도 접수 ` +
            `${result.orderPrice}원 ${result.qty}주 (#${result.orderNo})`
        );
      }
    } catch (err) {
      if (err?.isRateLimit) {
        console.warn(`[지표기반매매매도] 시세 유량 제한 — user ${userId} 사이클 중단`);
        break;
      }
      console.error(`[지표기반매매매도] 포지션 처리 실패:`, err.message || err);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return logs;
};

/** 자동매매 ON 직후 1회 (REST 폴백) */
const evaluateIndicatorSellsForUser = async (userId) => processUser(userId);

/**
 * REST 폴링은 중단 — 시세·매도는 자동매매 WS 틱에서 처리.
 * 함수는 서버 호환용으로 남겨 둠.
 */
const startIndicatorSellMonitor = () => {
  if (started) return;
  started = true;
  console.log(
    '[지표기반매매매도] WS 연동 모드 (시세=자동매매 WebSocket 0B, REST 폴링 없음)'
  );
};

const stopIndicatorSellMonitor = () => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  started = false;
};

const sellCheckKeyOf = (userId, positionId, orderNo) =>
  `ind_sell_${userId}_${positionId}_${orderNo}`;

const clearSellPending = (checkKey) => {
  const existing = pendingSellChecks.get(checkKey);
  if (existing?.intervalId) clearInterval(existing.intervalId);
  pendingSellChecks.delete(checkKey);
};

const completeIndicatorSellFill = async ({
  checkKey,
  userId,
  positionId,
  stockCode,
  orderNo,
  orderPrice,
  qty,
  execPrice,
  execQty,
  reason,
  venue,
  priceType,
  source = 'rest',
}) => {
  const existing = pendingSellChecks.get(checkKey);
  if (existing?.completing) return null;
  if (existing) {
    existing.completing = true;
    pendingSellChecks.set(checkKey, existing);
  }

  const price = Math.round(Number(execPrice || orderPrice) || 0);
  const filledQty = parseInt(execQty || qty, 10) || 0;
  console.log(
    `[지표기반매매매도] 매도 체결(${source}): ${stockCode} ord=${orderNo} price=${price} qty=${filledQty}`
  );

  const closed = await markPositionClosed(userId, positionId, {
    sellFilledPrice: price,
    sellFilledQty: filledQty,
    sellOrderNo: orderNo,
    sellReason: reason,
  });
  await insertOrderLog(userId, {
    positionId,
    stockCode,
    side: 'sell',
    action: 'fill',
    venue: venue || 'KRX',
    priceType: priceType || 'limit',
    orderPrice,
    qty,
    filledPrice: price,
    filledQty,
    orderNo,
    reason,
    rawMessage: `filled_via_${source}`,
  });
  clearSellPending(checkKey);
  try {
    const { retryBuyAfterStopLossIfTracking } = require('../utils/indicatorTradingTracker');
    await retryBuyAfterStopLossIfTracking(userId, stockCode, reason, price);
  } catch (err) {
    console.error(`[지표기반매매매도] 손절 후 재매수 오류:`, err.message);
  }
  try {
    const { requestSymbolRefreshSoon } = require('./indicatorWsMonitor');
    requestSymbolRefreshSoon();
  } catch (_) {
    /* ignore */
  }
  return closed;
};

const pollIndicatorSellFill = async (checkKey, opts = {}) => {
  const state = pendingSellChecks.get(checkKey);
  if (!state || state.completing) return;
  if (!shouldRunRestFillPoll(state, opts)) return;
  if (Date.now() - state.startTime > 6 * 60 * 60 * 1000) {
    console.warn(
      `[지표기반매매매도] 매도 체결 대기 타임아웃: ${state.stockCode} ord=${state.orderNo}`
    );
    clearSellPending(checkKey);
    return;
  }
  try {
    markRestFillPolled(state);
    const executionResult = await kiwoomAPI.checkOrderExecution(
      state.kiwoomInfo.accessToken,
      state.kiwoomInfo.appKey,
      state.kiwoomInfo.appSecret,
      state.kiwoomInfo.accountNo,
      state.orderNo,
      state.venue
    );
    if (executionResult.isExecuted && executionResult.acnt_ord_cntr_prst_array?.length > 0) {
      const fill = aggregateRestExecutions(
        executionResult.acnt_ord_cntr_prst_array,
        state.orderPrice
      );
      if (fill && fill.execQty > 0) {
        await completeIndicatorSellFill({
          checkKey,
          userId: state.userId,
          positionId: state.positionId,
          stockCode: state.stockCode,
          orderNo: state.orderNo,
          orderPrice: state.orderPrice,
          qty: state.qty,
          execPrice: fill.execPrice,
          execQty: fill.execQty,
          reason: state.reason,
          venue: state.venue,
          priceType: state.priceType,
          source: 'rest',
        });
      }
    }
  } catch (err) {
    console.error(
      `[지표기반매매매도] 매도 체결확인 실패 ${state.stockCode}:`,
      err.message || err
    );
  }
};

const registerIndicatorSellPending = (payload) => {
  const {
    kiwoomInfo,
    userId,
    positionId,
    stockCode,
    orderNo,
    orderPrice,
    qty,
    venue,
    priceType,
    reason,
  } = payload;
  if (!orderNo || !positionId) return null;
  const checkKey = sellCheckKeyOf(userId, positionId, orderNo);
  if (pendingSellChecks.has(checkKey)) return checkKey;
  const startTime = Date.now();
  const intervalId = setInterval(() => {
    pollIndicatorSellFill(checkKey).catch(() => {});
  }, REST_BACKUP_INTERVAL_MS);
  pendingSellChecks.set(checkKey, {
    ...payload,
    userId: String(userId),
    stockCode: String(stockCode).substring(0, 6),
    orderNo: String(orderNo),
    venue: venue || 'KRX',
    startTime,
    lastRestPollAt: 0,
    intervalId,
    kiwoomInfo,
  });
  setTimeout(() => {
    pollIndicatorSellFill(checkKey).catch(() => {});
  }, REST_BACKUP_FIRST_MS);
  console.log(
    `[지표기반매매매도] 매도 체결 대기: ${stockCode} ord=${orderNo} pos=${positionId} (WS 00 우선, REST 백업 2분/5분)`
  );
  return checkKey;
};

/**
 * 서버 재시작 등으로 pendingSellChecks가 사라진 selling 포지션 복구.
 * 전일(KST) 이전 주문은 당일 주문이 소멸된 것으로 보고 EOD 정리.
 */
const recoverPendingIndicatorSells = async (userId, { minPollIntervalMs = 0 } = {}) => {
  const uid = String(userId);
  const kiwoomInfo = await getKiwoomInfo(uid);
  if (!kiwoomInfo?.accessToken) return { recovered: 0, polled: 0, eodSettled: 0 };

  let selling = await getSellingPositions(uid);
  const staleIds = selling
    .filter((p) => isSellOrderedBeforeTodayKst(p.sellOrderedAt))
    .map((p) => p.id);

  let eodSettled = 0;
  if (staleIds.length > 0) {
    console.log(
      `[지표기반매매매도] 전일 미체결 selling ${staleIds.length}건 — EOD 정리 시도 user=${uid}`
    );
    const settled = await settleUnfilledIndicatorSells(uid, {
      reason: 'eod_unfilled',
      venueFilter: null,
      tryFillFirst: true,
      onlyPositionIds: staleIds,
    });
    eodSettled = (settled.cancelled || 0) + (settled.failed || 0) + (settled.filled || 0);
    selling = await getSellingPositions(uid);
  }

  let recovered = 0;
  let polled = 0;

  for (const p of selling) {
    const orderNo = p.sellOrderNo;
    if (!orderNo) continue;

    const checkKey = sellCheckKeyOf(uid, p.id, orderNo);
    if (!pendingSellChecks.has(checkKey)) {
      registerIndicatorSellPending({
        kiwoomInfo,
        userId: uid,
        positionId: p.id,
        stockCode: p.stockCode,
        stockName: p.stockName,
        venue: p.venue || 'KRX',
        orderNo,
        orderPrice: p.sellOrderPrice,
        qty: p.sellQty || p.buyFilledQty || p.buyQty,
        priceType: 'limit',
        reason: p.sellReason || 'recovery',
      });
      recovered += 1;
      console.log(
        `[지표기반매매매도] selling 복구: ${p.stockCode} ord=${orderNo} pos=${p.id}`
      );
    }

    const last = lastSellRecoverPollAt.get(checkKey) || 0;
    if (Date.now() - last >= minPollIntervalMs) {
      lastSellRecoverPollAt.set(checkKey, Date.now());
      polled += 1;
      await pollIndicatorSellFill(checkKey, { force: true }).catch(() => {});
    }
  }

  return { recovered, polled, eodSettled, total: selling.length };
};

const findPendingSellByOrderNo = (userId, orderNo, stockCode) => {
  const uid = String(userId);
  const code6 = stockCode ? String(stockCode).substring(0, 6) : null;
  const { normalizeOrderNo } = require('./kiwoomRealtimeClient');
  for (const [checkKey, info] of pendingSellChecks.entries()) {
    if (info.userId !== uid) continue;
    const a = String(info.orderNo || '').trim();
    const b = String(orderNo || '').trim();
    const match =
      a === b ||
      (normalizeOrderNo(a) !== '' && normalizeOrderNo(a) === normalizeOrderNo(b));
    if (!match) continue;
    if (code6 && String(info.stockCode).substring(0, 6) !== code6) continue;
    return { checkKey, info };
  }
  return null;
};

const SETTLE_SELL_REASON_META = {
  auto_trading_off: {
    rejectReason: 'auto_trading_off',
    cancelFailedReason: 'auto_trading_off_cancel_failed',
    rawOk: '자동매매 OFF — 미체결 매도 취소',
    logTag: 'OFF',
  },
  eod_unfilled: {
    rejectReason: 'eod_unfilled',
    cancelFailedReason: 'eod_unfilled_cancel_failed',
    rawOk: '장마감 — 미체결 매도 정리',
    logTag: 'EOD',
  },
};

/** sell_ordered_at 이 오늘(KST) 0시 이전인지 */
const isSellOrderedBeforeTodayKst = (sellOrderedAt) => {
  if (!sellOrderedAt) return true;
  const d = sellOrderedAt instanceof Date ? sellOrderedAt : new Date(sellOrderedAt);
  if (Number.isNaN(d.getTime())) return true;
  const kstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const start = new Date(kstNow);
  start.setHours(0, 0, 0, 0);
  const orderedKst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return orderedKst < start;
};

/**
 * 미체결 매도 정리 — 키움 취소 시도 + reject 기록 + selling → open
 * @param {string} userId
 * @param {{ reason?: 'auto_trading_off'|'eod_unfilled', venueFilter?: 'KRX'|'NXT'|null, tryFillFirst?: boolean, onlyPositionIds?: number[]|Set }} [opts]
 */
const settleUnfilledIndicatorSells = async (userId, opts = {}) => {
  const reasonKey = opts.reason || 'auto_trading_off';
  const meta = SETTLE_SELL_REASON_META[reasonKey] || SETTLE_SELL_REASON_META.auto_trading_off;
  const venueFilter = opts.venueFilter || null;
  const tryFillFirst = opts.tryFillFirst !== false;
  const onlyIds = opts.onlyPositionIds
    ? new Set([...opts.onlyPositionIds].map((id) => Number(id)))
    : null;

  const kiwoomInfo = await getKiwoomInfo(userId);
  if (!kiwoomInfo?.accessToken) {
    return { cancelled: 0, failed: 0, filled: 0, total: 0, skipped: true };
  }

  const fromOrders = await getUnfilledSellPlacesFromOrders(userId);
  const selling = await getSellingPositions(userId);
  const byOrd = new Map();

  for (const s of fromOrders) {
    if (!s.orderNo) continue;
    if (onlyIds && (s.positionId == null || !onlyIds.has(Number(s.positionId)))) continue;
    byOrd.set(String(s.orderNo), {
      stockCode: s.stockCode,
      orderNo: s.orderNo,
      qty: s.qty || 0,
      venue: s.venue || 'KRX',
      positionId: s.positionId,
      orderPrice: s.orderPrice,
      reason: null,
    });
  }
  for (const p of selling) {
    if (onlyIds && !onlyIds.has(Number(p.id))) continue;
    if (!p.sellOrderNo) {
      if (venueFilter && (p.venue || 'KRX') !== venueFilter) continue;
      try {
        await revertPositionToOpen(userId, p.id);
        await insertOrderLog(userId, {
          positionId: p.id,
          stockCode: p.stockCode,
          side: 'sell',
          action: 'reject',
          venue: p.venue || 'KRX',
          priceType: 'limit',
          orderPrice: p.sellOrderPrice,
          qty: p.sellQty || p.buyFilledQty || p.buyQty || 0,
          orderNo: null,
          reason: meta.rejectReason,
          rawMessage: `${meta.rawOk} (주문번호 없음)`,
        });
      } catch (_) {
        /* ignore */
      }
      continue;
    }
    byOrd.set(String(p.sellOrderNo), {
      stockCode: p.stockCode,
      orderNo: p.sellOrderNo,
      qty: p.sellQty || p.buyFilledQty || p.buyQty || 0,
      venue: p.venue || 'KRX',
      positionId: p.id,
      orderPrice: p.sellOrderPrice,
      reason: p.sellReason || null,
    });
  }

  let cancelled = 0;
  let failed = 0;
  let filled = 0;
  const logs = [];
  let considered = 0;

  for (const item of byOrd.values()) {
    const venue = item.venue || 'KRX';
    if (venueFilter && venue !== venueFilter) continue;
    considered += 1;

    if (tryFillFirst && item.positionId && item.orderNo) {
      try {
        const executionResult = await kiwoomAPI.checkOrderExecution(
          kiwoomInfo.accessToken,
          kiwoomInfo.appKey,
          kiwoomInfo.appSecret,
          kiwoomInfo.accountNo,
          item.orderNo,
          venue
        );
        if (executionResult.isExecuted && executionResult.acnt_ord_cntr_prst_array?.length > 0) {
          const fill = aggregateRestExecutions(
            executionResult.acnt_ord_cntr_prst_array,
            item.orderPrice
          );
          if (fill && fill.execQty > 0) {
            const checkKey = sellCheckKeyOf(userId, item.positionId, item.orderNo);
            await completeIndicatorSellFill({
              checkKey,
              userId,
              positionId: item.positionId,
              stockCode: item.stockCode,
              orderNo: item.orderNo,
              orderPrice: item.orderPrice,
              qty: item.qty,
              execPrice: fill.execPrice,
              execQty: fill.execQty,
              reason: item.reason || 'recovery',
              venue,
              priceType: 'limit',
              source: 'eod_rest',
            });
            filled += 1;
            logs.push(`[${item.stockCode}] 장마감 전 체결 반영 ord=${item.orderNo}`);
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
        }
      } catch (err) {
        console.warn(
          `[지표기반매매매도] ${meta.logTag} 체결확인 실패 ${item.stockCode}:`,
          err.message || err
        );
      }
    }

    try {
      await kiwoomAPI.cancelOrder(
        {
          symbol: item.stockCode,
          orderNo: item.orderNo,
          quantity: item.qty || 0,
        },
        kiwoomInfo.accessToken,
        kiwoomInfo.appKey,
        kiwoomInfo.appSecret,
        kiwoomInfo.accountNo,
        venue
      );
      cancelled += 1;
      logs.push(`[${item.stockCode}] 미체결 매도 취소 ord=${item.orderNo}`);
      await insertOrderLog(userId, {
        positionId: item.positionId,
        stockCode: item.stockCode,
        side: 'sell',
        action: 'reject',
        venue,
        priceType: 'limit',
        orderPrice: item.orderPrice,
        qty: item.qty,
        orderNo: item.orderNo,
        reason: meta.rejectReason,
        rawMessage: meta.rawOk,
      });
      if (item.positionId) {
        await revertPositionToOpen(userId, item.positionId);
      }
      console.log(
        `[지표기반매매매도] ${meta.logTag} 매도취소 성공: ${item.stockCode} ord=${item.orderNo}`
      );
    } catch (err) {
      failed += 1;
      const msg = err.message || String(err);
      logs.push(`[${item.stockCode}] 매도취소 실패 ord=${item.orderNo}: ${msg}`);
      console.error(
        `[지표기반매매매도] ${meta.logTag} 매도취소 실패: ${item.stockCode}`,
        msg
      );
      try {
        await insertOrderLog(userId, {
          positionId: item.positionId,
          stockCode: item.stockCode,
          side: 'sell',
          action: 'reject',
          venue,
          priceType: 'limit',
          orderPrice: item.orderPrice,
          qty: item.qty,
          orderNo: item.orderNo,
          reason: meta.cancelFailedReason,
          rawMessage: msg,
        });
        if (item.positionId) {
          await revertPositionToOpen(userId, item.positionId);
        }
      } catch (_) {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // 정리 대상 venue의 메모리 pending만 제거 (NXT 장중 KRX EOD 시 NXT pending 유지)
  for (const [k, info] of [...pendingSellChecks.entries()]) {
    if (info.userId !== String(userId)) continue;
    if (venueFilter && (info.venue || 'KRX') !== venueFilter) continue;
    clearSellPending(k);
  }

  return { cancelled, failed, filled, logs, total: considered };
};

/** 자동매매 OFF — 미체결 매도 취소, selling 포지션은 open으로 복귀 */
const cancelPendingIndicatorSellsOnStop = async (userId) =>
  settleUnfilledIndicatorSells(userId, {
    reason: 'auto_trading_off',
    venueFilter: null,
    tryFillFirst: true,
  });

/**
 * 장마감 후 미체결 매도 정리 (전 사용자)
 * @param {'KRX'|'NXT'|null} [venueFilter]
 */
const runEodUnfilledIndicatorSellsForAllUsers = async (venueFilter = null) => {
  const { isWeekend, isHolidaySync } = require('../utils/stockUtils');
  if (isWeekend() || isHolidaySync()) {
    console.log('[지표기반매매매도] EOD 미체결정리 — 주말·휴일 생략');
    return { users: 0, cancelled: 0, failed: 0, filled: 0 };
  }

  const userIds = await listUserIdsWithSellingPositions();
  if (userIds.length === 0) {
    console.log(
      `[지표기반매매매도] EOD 미체결정리${venueFilter ? `(${venueFilter})` : ''} — selling 없음`
    );
    return { users: 0, cancelled: 0, failed: 0, filled: 0 };
  }

  let cancelled = 0;
  let failed = 0;
  let filled = 0;

  for (const uid of userIds) {
    try {
      const r = await settleUnfilledIndicatorSells(uid, {
        reason: 'eod_unfilled',
        venueFilter,
        tryFillFirst: true,
      });
      cancelled += r.cancelled || 0;
      failed += r.failed || 0;
      filled += r.filled || 0;
    } catch (err) {
      console.error(`[지표기반매매매도] EOD 미체결정리 오류 user=${uid}:`, err.message || err);
    }
  }

  console.log(
    `[지표기반매매매도] EOD 미체결정리${venueFilter ? `(${venueFilter})` : ''} 완료 — ` +
      `사용자 ${userIds.length}명, 체결반영 ${filled}, 취소 ${cancelled}, 실패후복귀 ${failed}`
  );
  return { users: userIds.length, cancelled, failed, filled };
};

module.exports = {
  startIndicatorSellMonitor,
  stopIndicatorSellMonitor,
  evaluateIndicatorSellsForUser,
  evaluateSellSignal,
  processIndicatorSellOnTick,
  listIndicatorOpenSymbolsForWs,
  fetchCurrentPrice,
  registerIndicatorSellPending,
  completeIndicatorSellFill,
  findPendingSellByOrderNo,
  settleUnfilledIndicatorSells,
  cancelPendingIndicatorSellsOnStop,
  recoverPendingIndicatorSells,
  runEodUnfilledIndicatorSellsForAllUsers,
};

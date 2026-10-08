/**
 * 지표기반매매 — 매수 주문 체결 대기/확인
 * 체결 전에는 indicator_positions 행을 만들지 않음
 */

const kiwoomAPI = require('../services/kiwoomApi');
const { aggregateRestExecutions } = require('./orderExecutionPrice');
const {
  REST_BACKUP_FIRST_MS,
  REST_BACKUP_INTERVAL_MS,
  shouldRunRestFillPoll,
  markRestFillPolled,
} = require('./orderFillRestBackup');
const {
  createFilledBuyPosition,
  addBuyFillToOpenPosition,
  insertOrderLog,
  getActivePositionByCode,
} = require('./indicatorPositionStore');

const isUniqueViolation = (err) =>
  err?.code === '23505' || /uq_indicator_pos_open|unique/i.test(String(err?.message || ''));

/** @type {Map<string, object>} */
const pendingBuyChecks = new Map();

/** @type {Map<string, number>} */
const lastRecoverPollAt = new Map();

const BUY_PENDING_UI = '주문 완료';

const checkKeyOf = (userId, stockCode, orderNo) =>
  `ind_${userId}_${String(stockCode).substring(0, 6)}_${orderNo}`;

const hasPendingIndicatorBuy = (userId, stockCode) => {
  const code6 = String(stockCode || '').substring(0, 6);
  const uid = String(userId);
  for (const info of pendingBuyChecks.values()) {
    if (info.userId === uid && String(info.stockCode).substring(0, 6) === code6) {
      return true;
    }
  }
  return false;
};

const countPendingIndicatorBuys = (userId) => {
  const uid = String(userId);
  let n = 0;
  let used = 0;
  for (const info of pendingBuyChecks.values()) {
    if (info.userId !== uid) continue;
    n += 1;
    used += Number(info.buyAmount) || 0;
  }
  return { pendingCount: n, pendingUsedAmount: used };
};

/** UI 병합용 — 체결 대기 매수 목록 */
const listPendingIndicatorBuys = (userId) => {
  const uid = String(userId);
  const out = [];
  for (const info of pendingBuyChecks.values()) {
    if (info.userId !== uid) continue;
    out.push({
      stockCode: String(info.stockCode).substring(0, 6),
      stockName: info.stockName || '',
      stockMarket: info.stockMarket || 'KRX',
      buyOrderNo: info.orderNo,
      buyPrice: info.orderPrice,
      buyQty: info.buyQty,
      buyOrderStatus: BUY_PENDING_UI,
      sellOrderStatus: '대기',
      pendingFill: true,
    });
  }
  return out;
};

const clearPending = (checkKey) => {
  const existing = pendingBuyChecks.get(checkKey);
  if (existing?.intervalId) clearInterval(existing.intervalId);
  pendingBuyChecks.delete(checkKey);
};

/**
 * 매수 체결 완료 → positions(open) 생성
 */
const completeIndicatorBuyFill = async ({
  checkKey,
  userId,
  stockCode,
  stockName,
  venue,
  buyConditionSeq,
  orderNo,
  orderPrice,
  buyQty,
  execPrice,
  execQty,
  priceType = 'limit',
  source = 'rest',
}) => {
  const existing = pendingBuyChecks.get(checkKey);
  if (existing?.completing) return null;
  if (existing) {
    existing.completing = true;
    pendingBuyChecks.set(checkKey, existing);
  }

  const price = Math.round(Number(execPrice || orderPrice) || 0);
  const qty = parseInt(execQty || buyQty, 10) || 0;
  if (!(price > 0) || qty < 1) {
    clearPending(checkKey);
    return null;
  }

  const mergeIntoOpen = async (pos) => {
    if (!pos || pos.status !== 'open') {
      console.log(
        `[지표기반매매] 체결 스킵(활성 비-open): ${stockCode} ord=${orderNo} ` +
          `status=${pos?.status || '-'} id=${pos?.id || '-'}`
      );
      return pos || null;
    }
    console.log(
      `[지표기반매매] 매수 합산(${source}): ${stockCode} ord=${orderNo} ` +
        `price=${price} qty=${qty} → pos=${pos.id}`
    );
    return addBuyFillToOpenPosition(userId, pos.id, {
      stockCode,
      venue: venue || pos.venue || 'KRX',
      orderNo,
      orderPrice: orderPrice || price,
      buyQty: buyQty || qty,
      filledPrice: price,
      filledQty: qty,
      priceType,
    });
  };

  const already = await getActivePositionByCode(userId, stockCode);
  if (already) {
    const merged = await mergeIntoOpen(already);
    clearPending(checkKey);
    try {
      const { requestSymbolRefreshSoon } = require('../services/indicatorWsMonitor');
      requestSymbolRefreshSoon();
    } catch (_) {
      /* ignore */
    }
    return merged;
  }

  console.log(
    `[지표기반매매] 매수 체결(${source}): ${stockCode} ord=${orderNo} ` +
      `price=${price} qty=${qty}`
  );

  let position;
  try {
    position = await createFilledBuyPosition(userId, {
      stockCode,
      stockName: stockName || existing?.stockName || '',
      venue: venue || existing?.venue || 'KRX',
      buyConditionSeq: buyConditionSeq || existing?.buyConditionSeq || '',
      buyOrderNo: orderNo,
      buyOrderPrice: orderPrice || price,
      buyFilledPrice: price,
      buyQty: buyQty || qty,
      buyFilledQty: qty,
      priceType,
    });
  } catch (err) {
    // 분할 레그 동시 체결 레이스 → 유니크 충돌 시 open에 합산
    if (isUniqueViolation(err)) {
      const raced = await getActivePositionByCode(userId, stockCode);
      position = await mergeIntoOpen(raced);
    } else {
      if (existing) existing.completing = false;
      throw err;
    }
  }

  clearPending(checkKey);

  try {
    const { requestSymbolRefreshSoon } = require('../services/indicatorWsMonitor');
    requestSymbolRefreshSoon();
  } catch (_) {
    /* ignore */
  }

  return position;
};

const pollIndicatorBuyFill = async (checkKey, opts = {}) => {
  const state = pendingBuyChecks.get(checkKey);
  if (!state || state.completing) return;
  if (!shouldRunRestFillPoll(state, opts)) return;
  const {
    kiwoomInfo,
    userId,
    stockCode,
    stockMarket,
    orderNo,
    orderPrice,
    buyQty,
    startTime,
  } = state;

  // 최대 6시간
  if (Date.now() - startTime > 6 * 60 * 60 * 1000) {
    console.warn(`[지표기반매매] 매수 체결 대기 타임아웃: ${stockCode} ord=${orderNo}`);
    await insertOrderLog(userId, {
      positionId: null,
      stockCode,
      side: 'buy',
      action: 'reject',
      venue: stockMarket,
      priceType: state.priceType || 'limit',
      orderPrice,
      qty: buyQty,
      orderNo,
      reason: 'fill_timeout',
      rawMessage: '미체결 타임아웃 — positions 미생성',
    }).catch(() => {});
    clearPending(checkKey);
    return;
  }

  try {
    markRestFillPolled(state);
    const executionResult = await kiwoomAPI.checkOrderExecution(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      kiwoomInfo.accountNo,
      orderNo,
      stockMarket
    );

    if (executionResult.isExecuted && executionResult.acnt_ord_cntr_prst_array?.length > 0) {
      const fill = aggregateRestExecutions(
        executionResult.acnt_ord_cntr_prst_array,
        orderPrice
      );
      if (fill && fill.execQty > 0) {
        await completeIndicatorBuyFill({
          checkKey,
          userId,
          stockCode,
          stockName: state.stockName,
          venue: stockMarket,
          buyConditionSeq: state.buyConditionSeq,
          orderNo,
          orderPrice,
          buyQty,
          execPrice: fill.execPrice,
          execQty: fill.execQty,
          priceType: state.priceType,
          source: 'rest',
        });
      }
    }
  } catch (err) {
    console.error(`[지표기반매매] 매수 체결확인 실패 ${stockCode}:`, err.message || err);
  }
};

/**
 * 매수 주문 접수 직후 — positions 없이 체결 감시만 등록
 */
const registerIndicatorBuyPending = (payload) => {
  const {
    kiwoomInfo,
    userId,
    stockCode,
    stockName,
    venue,
    buyConditionSeq,
    orderNo,
    orderPrice,
    buyQty,
    buyAmount,
    priceType,
  } = payload;
  if (!orderNo) return null;

  const checkKey = checkKeyOf(userId, stockCode, orderNo);
  if (pendingBuyChecks.has(checkKey)) return checkKey;

  const startTime = Date.now();
  // WS type 00 체결 우선 — REST(kt00009)는 백업으로 드물게만
  const intervalId = setInterval(() => {
    pollIndicatorBuyFill(checkKey).catch(() => {});
  }, REST_BACKUP_INTERVAL_MS);

  pendingBuyChecks.set(checkKey, {
    intervalId,
    startTime,
    lastRestPollAt: 0,
    kiwoomInfo,
    userId: String(userId),
    stockCode: String(stockCode).substring(0, 6),
    stockName: stockName || '',
    stockMarket: venue || 'KRX',
    buyConditionSeq: buyConditionSeq || '',
    orderNo: String(orderNo),
    orderPrice,
    buyQty,
    buyAmount: buyAmount || 0,
    priceType: priceType || 'limit',
  });

  // 첫 REST 백업은 2분 뒤 (그 전에는 WS 00에 의존)
  setTimeout(() => {
    pollIndicatorBuyFill(checkKey).catch(() => {});
  }, REST_BACKUP_FIRST_MS);

  console.log(
    `[지표기반매매] 매수 체결 대기 등록: ${stockCode} ord=${orderNo} (WS 00 우선, REST 백업 2분/5분)`
  );
  return checkKey;
};

/** WS type 00 매칭용 */
const findPendingByOrderNo = (userId, orderNo, stockCode) => {
  const uid = String(userId);
  const code6 = stockCode ? String(stockCode).substring(0, 6) : null;
  const { normalizeOrderNo } = require('../services/kiwoomRealtimeClient');
  for (const [checkKey, info] of pendingBuyChecks.entries()) {
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

const clearAllPendingForUser = (userId) => {
  const uid = String(userId);
  const keys = [];
  for (const [checkKey, info] of pendingBuyChecks.entries()) {
    if (info.userId === uid) keys.push(checkKey);
  }
  for (const k of keys) clearPending(k);
  return keys.length;
};

/**
 * 미체결 매수 주문 키움 취소 + DB reject 기록 + pending 정리
 * @param {string} userId
 * @param {{ stockCode?: string, reason?: string, rawMessage?: string }} [opts]
 *   stockCode 있으면 해당 종목만, 없으면 사용자 전체
 */
const cancelPendingIndicatorBuys = async (
  userId,
  { stockCode = null, reason = 'auto_trading_off', rawMessage = '미체결 매수 취소' } = {}
) => {
  const { getKiwoomInfo } = require('./kiwoomUtils');
  const { getUnfilledBuyPlacesFromOrders, insertOrderLog } = require('./indicatorPositionStore');
  const kiwoomAPI = require('../services/kiwoomApi');

  const filterCode = stockCode ? String(stockCode).substring(0, 6) : null;
  const failReason = `${reason}_cancel_failed`;

  const kiwoomInfo = await getKiwoomInfo(userId);
  if (!kiwoomInfo?.accessToken) {
    if (filterCode) {
      const keys = [];
      for (const [checkKey, info] of pendingBuyChecks.entries()) {
        if (info.userId === String(userId) && String(info.stockCode).substring(0, 6) === filterCode) {
          keys.push(checkKey);
        }
      }
      for (const k of keys) clearPending(k);
    } else {
      clearAllPendingForUser(userId);
    }
    return { cancelled: 0, failed: 0, skipped: true, reason: 'no_token', logs: [], total: 0 };
  }

  const fromMem = listPendingIndicatorBuys(userId);
  const fromDb = await getUnfilledBuyPlacesFromOrders(userId);
  const byOrd = new Map();
  for (const p of [...fromDb, ...fromMem]) {
    const ord = p.buyOrderNo ? String(p.buyOrderNo) : '';
    const code = String(p.stockCode || '').substring(0, 6);
    if (!ord || !code) continue;
    if (filterCode && code !== filterCode) continue;
    byOrd.set(`${code}_${ord}`, {
      stockCode: code,
      stockName: p.stockName || '',
      orderNo: ord,
      qty: p.buyQty || 0,
      venue: p.stockMarket || 'KRX',
      orderPrice: p.buyPrice,
    });
  }

  let cancelled = 0;
  let failed = 0;
  const logs = [];

  for (const item of byOrd.values()) {
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
        item.venue || 'KRX'
      );
      await insertOrderLog(userId, {
        positionId: null,
        stockCode: item.stockCode,
        side: 'buy',
        action: 'reject',
        venue: item.venue || 'KRX',
        priceType: 'limit',
        orderPrice: item.orderPrice,
        qty: item.qty,
        orderNo: item.orderNo,
        reason,
        rawMessage,
      });
      cancelled += 1;
      logs.push(`[${item.stockCode}] 미체결 매수 취소 ord=${item.orderNo}`);
      console.log(
        `[지표기반매매] 매수취소 성공: ${item.stockCode} ord=${item.orderNo} (${reason})`
      );
    } catch (err) {
      failed += 1;
      const msg = err.message || String(err);
      logs.push(`[${item.stockCode}] 취소 실패 ord=${item.orderNo}: ${msg}`);
      console.error(
        `[지표기반매매] 매수취소 실패: ${item.stockCode} ord=${item.orderNo}`,
        msg
      );
      try {
        await insertOrderLog(userId, {
          positionId: null,
          stockCode: item.stockCode,
          side: 'buy',
          action: 'reject',
          venue: item.venue || 'KRX',
          priceType: 'limit',
          orderPrice: item.orderPrice,
          qty: item.qty,
          orderNo: item.orderNo,
          reason: failReason,
          rawMessage: msg,
        });
      } catch (_) {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (filterCode) {
    const keys = [];
    for (const [checkKey, info] of pendingBuyChecks.entries()) {
      if (info.userId === String(userId) && String(info.stockCode).substring(0, 6) === filterCode) {
        keys.push(checkKey);
      }
    }
    for (const k of keys) clearPending(k);
  } else {
    clearAllPendingForUser(userId);
  }
  return { cancelled, failed, logs, total: byOrd.size };
};

/** 자동매매 OFF — 전체 미체결 매수 취소 */
const cancelPendingIndicatorBuysOnStop = async (userId) =>
  cancelPendingIndicatorBuys(userId, {
    reason: 'auto_trading_off',
    rawMessage: '자동매매 OFF — 미체결 매수 취소',
  });

/**
 * 서버 재시작·WS 재연결 등으로 pendingBuyChecks가 사라진 미체결 매수 복구
 */
const recoverPendingIndicatorBuys = async (userId, { minPollIntervalMs = 0 } = {}) => {
  const uid = String(userId);
  const { getKiwoomInfo } = require('./kiwoomUtils');
  const { getUnfilledBuyPlacesFromOrders } = require('./indicatorPositionStore');
  const { getIndicatorTrading } = require('./indicatorTradingStore');

  const kiwoomInfo = await getKiwoomInfo(uid);
  if (!kiwoomInfo?.accessToken) return { recovered: 0, polled: 0 };

  const state = await getIndicatorTrading(uid);
  const buyConditionSeq = String(state.settings?.buyCondition ?? '').trim();
  const fromDb = await getUnfilledBuyPlacesFromOrders(uid);
  let recovered = 0;
  let polled = 0;

  for (const p of fromDb) {
    const orderNo = p.buyOrderNo ? String(p.buyOrderNo) : '';
    const code6 = String(p.stockCode || '').substring(0, 6);
    if (!orderNo || !code6) continue;

    const existing = await getActivePositionByCode(uid, code6);
    if (existing) continue;

    const checkKey = checkKeyOf(uid, code6, orderNo);
    if (!pendingBuyChecks.has(checkKey)) {
      registerIndicatorBuyPending({
        kiwoomInfo,
        userId: uid,
        stockCode: code6,
        stockName: p.stockName || '',
        venue: p.stockMarket || 'KRX',
        buyConditionSeq,
        orderNo,
        orderPrice: p.buyPrice,
        buyQty: p.buyQty,
        buyAmount: (Number(p.buyPrice) || 0) * (Number(p.buyQty) || 0),
        priceType: 'limit',
      });
      recovered += 1;
      console.log(`[지표기반매매] 매수체결 복구 등록: ${code6} ord=${orderNo}`);
    }

    const last = lastRecoverPollAt.get(checkKey) || 0;
    if (Date.now() - last >= minPollIntervalMs) {
      lastRecoverPollAt.set(checkKey, Date.now());
      polled += 1;
      await pollIndicatorBuyFill(checkKey, { force: true }).catch(() => {});
    }
  }

  return { recovered, polled, total: fromDb.length };
};

module.exports = {
  BUY_PENDING_UI,
  pendingBuyChecks,
  hasPendingIndicatorBuy,
  countPendingIndicatorBuys,
  listPendingIndicatorBuys,
  registerIndicatorBuyPending,
  completeIndicatorBuyFill,
  findPendingByOrderNo,
  clearPending,
  clearAllPendingForUser,
  cancelPendingIndicatorBuys,
  cancelPendingIndicatorBuysOnStop,
  recoverPendingIndicatorBuys,
};

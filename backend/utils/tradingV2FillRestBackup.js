/**
 * Trading V2 — WS(00) 우선, REST 체결 백업
 * - 국내: kt00009 / 미국: ust21510 (당일 주문체결) — 키움 WS 00 은 미국 체결을 주지 않음
 * - 부분체결: fills 적재만 / 완전체결 시에만 stage 진행 → 감시 갱신(매도 arm)
 */

const kiwoomAPI = require('../services/kiwoomApi');
const { aggregateRestExecutions, parseKiwoomNumber } = require('./orderExecutionPrice');
const {
  shouldRunRestFillPoll,
  markRestFillPolled,
  REST_BACKUP_FIRST_MS,
  REST_BACKUP_INTERVAL_MS,
} = require('./orderFillRestBackup');
const { getMsUntilMarketCutoff, isUsMarket } = require('./autoTradingMarket');
const { applyTradingV2RestFill } = require('./tradingV2Fill');
const { findTradingOrderByBrokerNo, listOpenTradingOrdersForUser } = require('./tradingV2Store');
const { isNXTTradingHours } = require('./stockUtils');
const { isNXTStock } = require('./stockListStore');

const LOG = '[TradingV2체결-REST]';

/** @type {Map<string, object>} */
const pendingChecks = new Map();

const checkKeyOf = (userId, orderNo) => `v2:${String(userId)}:${String(orderNo).trim()}`;

const normOrderNo = (raw) => String(raw ?? '').trim().replace(/^0+/, '');

const clearPending = (key) => {
  const state = pendingChecks.get(key);
  if (!state) return;
  if (state.intervalId) clearInterval(state.intervalId);
  if (state.firstTimer) clearTimeout(state.firstTimer);
  pendingChecks.delete(key);
};

const stopTradingV2FillWatch = (userId, orderNo) => {
  if (!orderNo) return;
  clearPending(checkKeyOf(userId, orderNo));
};

const stopAllTradingV2FillWatchesForUser = (userId) => {
  const prefix = `v2:${String(userId)}:`;
  for (const key of [...pendingChecks.keys()]) {
    if (key.startsWith(prefix)) clearPending(key);
  }
};

/** 토큰은 07:50 자동갱신 등으로 바뀌므로 폴링마다 최신값 사용 */
const refreshKiwoomInfo = async (state) => {
  try {
    const { getKiwoomInfo } = require('./kiwoomUtils');
    const info = await getKiwoomInfo(state.userId);
    if (info?.accessToken) {
      state.kiwoomInfo = {
        accessToken: info.accessToken,
        appKey: info.appKey,
        appSecret: info.appSecret,
        accountNo: info.accountNo,
      };
    }
  } catch {
    /* 기존 kiwoomInfo 유지 */
  }
  return state.kiwoomInfo;
};

const US_ORDER_NO_KEYS = ['ord_no', 'order_no', 'orderNo', 'ordno', '주문번호'];
const US_EXEC_QTY_KEYS = ['cntr_qty', 'tot_cntr_qty', 'exec_qty', 'cntr_qty_sum', '체결수량'];
const US_EXEC_PRICE_KEYS = ['cntr_uv', 'avg_cntr_uv', 'cntr_pric', 'exec_uv', 'exec_prc', '체결단가'];

const pickField = (row, keys) => {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return row[k];
  }
  return null;
};

/** ust21510 행 중 해당 주문번호 체결 합산 (미국 가격은 소수 — 반올림 금지) */
const aggregateUsExecutions = (rows, orderNo) => {
  const want = normOrderNo(orderNo);
  let totalQty = 0;
  let totalAmt = 0;
  let matchedRows = 0;
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    if (normOrderNo(pickField(row, US_ORDER_NO_KEYS)) !== want) continue;
    matchedRows += 1;
    const qty = Math.abs(parseKiwoomNumber(pickField(row, US_EXEC_QTY_KEYS)));
    const price = Math.abs(parseKiwoomNumber(pickField(row, US_EXEC_PRICE_KEYS)));
    if (qty > 0 && price > 0) {
      totalQty += qty;
      totalAmt += qty * price;
    }
  }
  if (!(totalQty > 0)) return { matchedRows, fill: null };
  return { matchedRows, fill: { execQty: totalQty, execPrice: totalAmt / totalQty } };
};

const fetchUsFill = async (state) => {
  const { kiwoomInfo, userId, stockCode, orderNo } = state;
  const res = await kiwoomAPI.getUsOrderExecutions(kiwoomInfo.accessToken, {
    slbyTp: '0',
    stexTp: '',
    stkCd: '',
  });
  const rows = res?.rows || [];
  const { matchedRows, fill } = aggregateUsExecutions(rows, orderNo);
  if (!matchedRows && rows.length && !state.loggedUsShape) {
    // 응답 필드명 확인용 (주문번호 매칭 실패 시 1회)
    state.loggedUsShape = true;
    console.warn(
      `${LOG}[${userId}] US 체결조회 주문번호 매칭 없음: ${stockCode} ord=${orderNo} ` +
        `rows=${rows.length} keys=${Object.keys(rows[0] || {}).join(',')}`
    );
  }
  return fill;
};

const fetchKrFill = async (state) => {
  const { kiwoomInfo, stockMarket, orderNo, orderPrice } = state;
  const executionResult = await kiwoomAPI.checkOrderExecution(
    kiwoomInfo.accessToken,
    kiwoomInfo.appKey,
    kiwoomInfo.appSecret,
    kiwoomInfo.accountNo,
    orderNo,
    stockMarket === 'NXT' ? 'NXT' : 'KRX'
  );
  if (!executionResult.isExecuted || !executionResult.acnt_ord_cntr_prst_array?.length) {
    return null;
  }
  return aggregateRestExecutions(executionResult.acnt_ord_cntr_prst_array, orderPrice);
};

const pollOnce = async (key, opts = {}) => {
  const state = pendingChecks.get(key);
  if (!state || state.completing) return;
  if (!shouldRunRestFillPoll(state, opts)) return;

  const { userId, stockCode, stockMarket, orderNo, orderQty } = state;

  const maxMs = getMsUntilMarketCutoff(stockMarket);
  if (maxMs <= 0) {
    console.warn(`${LOG}[${userId}] 장종료: ${stockCode} ord=${orderNo}`);
    clearPending(key);
    return;
  }

  // 주문이 이미 종료됐으면 중단
  try {
    const matched = await findTradingOrderByBrokerNo(userId, orderNo);
    if (!matched?.order) {
      clearPending(key);
      return;
    }
  } catch {
    /* continue poll */
  }

  try {
    markRestFillPolled(state);
    console.log(`${LOG}[${userId}] 폴링 ${stockCode} ord=${orderNo}`);

    await refreshKiwoomInfo(state);
    if (!state.kiwoomInfo?.accessToken) return;

    const fill = stockMarket === 'US' ? await fetchUsFill(state) : await fetchKrFill(state);
    if (!fill || !(fill.execQty > 0)) return;

    state.completing = true;
    const out = await applyTradingV2RestFill({
      userId,
      orderNo,
      restExecQty: fill.execQty,
      restExecPrice: fill.execPrice,
    });
    state.completing = false;

    const done =
      out?.complete ||
      (orderQty > 0 && fill.execQty >= orderQty);
    if (done) {
      console.log(
        `${LOG}[${userId}] 완결: ${stockCode} ord=${orderNo} qty=${fill.execQty}@${fill.execPrice}`
      );
      clearPending(key);
    }
  } catch (err) {
    state.completing = false;
    console.error(`${LOG}[${userId}] 실패 ${stockCode} ord=${orderNo}:`, err.message);
  }
};

/**
 * 주문 접수 후 호출 — WS 우선, REST는 2분/5분 백업 (미국은 REST가 사실상 주 경로)
 */
const startTradingV2FillWatch = (payload) => {
  const {
    kiwoomInfo,
    userId,
    stockCode,
    stockMarket = 'KRX',
    orderNo,
    orderPrice,
    orderQty,
    planId,
    orderId,
    resumed = false,
  } = payload || {};

  if (!userId || !orderNo) return;

  const key = checkKeyOf(userId, orderNo);
  if (pendingChecks.has(key)) return;

  const startTime = Date.now();
  const state = {
    intervalId: null,
    firstTimer: null,
    startTime,
    lastRestPollAt: 0,
    completing: false,
    kiwoomInfo: kiwoomInfo || null,
    userId: String(userId),
    stockCode,
    stockMarket,
    orderNo: String(orderNo),
    orderPrice,
    orderQty: Number(orderQty) || 0,
    planId,
    orderId,
  };

  pendingChecks.set(key, state);

  state.firstTimer = setTimeout(() => {
    state.firstTimer = null;
    pollOnce(key, { force: false });
  }, REST_BACKUP_FIRST_MS);

  state.intervalId = setInterval(() => {
    pollOnce(key, {});
  }, REST_BACKUP_INTERVAL_MS);

  console.log(
    `${LOG}[${userId}] 감시${resumed ? '복구' : '등록'}: ${stockCode} ord=${orderNo} plan=${planId} ` +
      `(${stockMarket === 'US' ? 'ust21510' : 'WS우선'}, REST ${REST_BACKUP_FIRST_MS / 60000}분/${REST_BACKUP_INTERVAL_MS / 60000}분)`
  );
};

const RESUME_THROTTLE_MS = 5 * 60 * 1000;
/** @type {Map<string, number>} */
const lastResumeAt = new Map();

/**
 * 서버 재시작 등으로 메모리 감시가 사라진 미체결 V2 주문을 다시 등록
 * (세션 컷오프가 지난 시장은 제외 — 장종료 직후 등록/해제 반복 방지)
 */
const resumeOpenTradingV2FillWatches = async (userId) => {
  const uid = String(userId);
  const now = Date.now();
  if (now - (lastResumeAt.get(uid) || 0) < RESUME_THROTTLE_MS) return;
  lastResumeAt.set(uid, now);

  let rows = [];
  try {
    rows = await listOpenTradingOrdersForUser(uid);
  } catch (err) {
    console.error(`${LOG}[${uid}] 미체결 주문 복구 조회 실패:`, err.message);
    return;
  }

  for (const row of rows) {
    const order = row.order || {};
    const orderNo = String(order.brokerOrderNo || '').trim();
    if (!orderNo || pendingChecks.has(checkKeyOf(uid, orderNo))) continue;
    let stockMarket =
      String(row.market || '').toUpperCase() === 'US' || isUsMarket(row.market, row.symbol)
        ? 'US'
        : String(row.exchange || '').toUpperCase() === 'NXT'
          ? 'NXT'
          : 'KRX';
    if (stockMarket === 'KRX' && isNXTTradingHours()) {
      try {
        if (await isNXTStock(row.symbol)) stockMarket = 'NXT';
      } catch {
        /* stock_list_nxt 조회 실패 시 KRX 유지 */
      }
    }
    if (getMsUntilMarketCutoff(stockMarket) <= 0) continue;
    startTradingV2FillWatch({
      userId: uid,
      stockCode: row.symbol,
      stockMarket,
      orderNo,
      orderPrice: Number(order.requestedPrice) || 0,
      orderQty: Number(order.requestedQty) || 0,
      planId: row.planId,
      orderId: order.id,
      resumed: true,
    });
  }
};

module.exports = {
  startTradingV2FillWatch,
  stopTradingV2FillWatch,
  stopAllTradingV2FillWatchesForUser,
  resumeOpenTradingV2FillWatches,
  aggregateUsExecutions,
  pendingChecks,
};

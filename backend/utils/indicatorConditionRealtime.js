/**
 * 지표기반매매 — 조건검색 실시간 구독 (CNSRREQ search_type=1)
 * 편입/이탈 이벤트로 tracking_stocks 증분 갱신
 */

const { normalizeConditionStocks } = require('./kiwoomConditionList');
const {
  getIndicatorTrading,
  getTrackingStocks,
  saveTrackingStocks,
} = require('./indicatorTradingStore');
const {
  ensurePositionTables,
  getActivePositionByCode,
  getActivePositionsMap,
  stripOrderFieldsFromTracking,
} = require('./indicatorPositionStore');
const {
  buildTrackingRow,
  tryIndicatorBuyForStock,
  createBuyHoldingState,
  attemptBuysForStocks,
} = require('./indicatorTradingTracker');
const { getKiwoomInfo } = require('./kiwoomUtils');
const { isNXTStock } = require('./stockListStore');
const { isConditionRealtimeSubscribeTime, getKoreaDateString } = require('./stockUtils');

/** @type {Map<string, { seq: string, subscribing: boolean }>} */
const subscriptionState = new Map();

/** 사용자별 당일(KST) 조건식 스냅샷 교체 성공일 YYYY-MM-DD */
const lastSnapshotKstByUser = new Map();
/** 강제 재구독 시도 throttle (ms) — reused/미수신 시 연타 방지 */
const lastForceSubscribeAt = new Map();
const FORCE_SUBSCRIBE_COOLDOWN_MS = 5 * 60 * 1000;

/** 스킵 사유 로그 throttle (30초) */
const skipLogLastAt = new Map();
const SKIP_LOG_INTERVAL_MS = 30000;

const logSubscribeSkip = (uid, reason, detail = '') => {
  const key = `${uid}:${reason}`;
  const now = Date.now();
  const last = skipLogLastAt.get(key) || 0;
  if (now - last < SKIP_LOG_INTERVAL_MS) return;
  skipLogLastAt.set(key, now);
  const extra = detail ? ` (${detail})` : '';
  console.log(`[조건검색실시간][${uid}] 구독 스킵: ${reason}${extra}`);
};

const code6Of = (code) => String(code || '').substring(0, 6);

const enrichStockName = async (userId, stock) => {
  const { resolveIndicatorStockName } = require('./indicatorPositionStore');
  const stockName = await resolveIndicatorStockName(
    userId,
    stock?.stockCode,
    stock?.stockName || ''
  );
  return { ...stock, stockName };
};

const isConditionRealtimeActive = (userId) => {
  const uid = String(userId);
  try {
    const { getConnectedRealtimeClient } = require('../services/indicatorWsMonitor');
    const client = getConnectedRealtimeClient(uid);
    return !!client?.isConditionRealtimeActive?.();
  } catch {
    return false;
  }
};

const getSubscribedSeq = (userId) => {
  const uid = String(userId);
  try {
    const { getConnectedRealtimeClient } = require('../services/indicatorWsMonitor');
    const client = getConnectedRealtimeClient(uid);
    return client?.getConditionRealtimeSeq?.() || '';
  } catch {
    return '';
  }
};

/**
 * 초기 스냅샷 → tracking_stocks 저장
 * replace=true: 스냅샷 기준으로 갱신, 미보유(활성 포지션 없음) 종목은 제거. 보유 포지션은 유지.
 * markSnapshot=false: 장전 정리 등 — 당일 실스냅샷으로 기록하지 않음
 */
const applyConditionSnapshot = async (
  userId,
  stocks,
  conditionSeq,
  { replace = false, markSnapshot = true } = {}
) => {
  await ensurePositionTables();
  const uid = String(userId);
  const seq = String(conditionSeq || '').trim();
  const state = await getIndicatorTrading(uid);
  const settings = state.settings || {};
  const maxTrack = Math.max(1, Number(settings.maxTrackingStocks) || 90);

  const prevList = await getTrackingStocks(uid);
  const prevMap = new Map(prevList.map((s) => [code6Of(s.stockCode), s]));

  const rows = [];
  const rowCodes = new Set();
  const sliced = (Array.isArray(stocks) ? stocks : []).slice(0, maxTrack);
  for (const s of sliced) {
    const code6 = code6Of(s.stockCode);
    if (!code6) continue;
    const prev = prevMap.get(code6) || null;
    const enriched = await enrichStockName(uid, s);
    const isNxt = await isNXTStock(enriched.stockCode);
    rows.push(buildTrackingRow(enriched, prev, seq, isNxt ? 'NXT' : 'KRX'));
    rowCodes.add(code6);
    if (!replace) prevMap.delete(code6);
  }

  if (!replace) {
    // 증분 모드: 스냅샷에 없는 기존 종목 유지
    for (const prev of prevMap.values()) {
      rows.push(stripOrderFieldsFromTracking(prev));
    }
  } else {
    // replace: 스냅샷에 없어도 활성 포지션·수동추가 종목은 목록에 유지
    const posMap = await getActivePositionsMap(uid);
    for (const [code, pos] of posMap.entries()) {
      const c6 = code6Of(code);
      if (!c6 || rowCodes.has(c6)) continue;
      const prev = prevMap.get(c6) || null;
      const venue = pos.venue === 'NXT' ? 'NXT' : 'KRX';
      rows.push(
        buildTrackingRow(
          {
            stockCode: c6,
            stockName: pos.stockName,
            price: pos.lastPrice ?? pos.buyFilledPrice ?? prev?.price,
            source: prev?.source || pos.entrySource || null,
          },
          prev?.source === 'manual' || pos.entrySource === 'manual'
            ? prev || { source: 'manual', stockCode: c6, stockName: pos.stockName }
            : prev,
          seq,
          venue
        )
      );
      rowCodes.add(c6);
    }
    for (const prev of prevMap.values()) {
      const c6 = code6Of(prev.stockCode);
      if (!c6 || rowCodes.has(c6)) continue;
      if (prev.source !== 'manual') continue;
      rows.push(stripOrderFieldsFromTracking(prev));
      rowCodes.add(c6);
    }
  }

  const slim = rows.map(stripOrderFieldsFromTracking);
  await saveTrackingStocks(uid, slim);

  // 조건에서 이탈한 종목은 시세 대기 큐에서도 제거
  try {
    const { prunePendingBuys } = require('./indicatorPendingBuys');
    prunePendingBuys(uid, new Set(slim.map((r) => code6Of(r.stockCode))));
  } catch {
    /* ignore */
  }

  if (replace && markSnapshot) {
    lastSnapshotKstByUser.set(uid, getKoreaDateString());
  }

  const pruned = replace ? Math.max(0, prevList.length - slim.length) : 0;
  console.log(
    `[조건검색실시간][${uid}] 스냅샷 ${sliced.length}건 → tracking ${slim.length}건` +
      (replace ? ` (replace, 정리 ${pruned}건)` : '')
  );
  return slim;
};

/** 당일(KST) 조건식 스냅샷 교체 여부 */
const hasFreshSnapshotToday = (userId) => {
  const uid = String(userId);
  return lastSnapshotKstByUser.get(uid) === getKoreaDateString();
};

/**
 * 조건식 출처 종목만 제거 (활성 포지션·수동추가 유지)
 * — 주말/장전 잔존 목록 정리, reused(스냅샷 없음) 시 폴백
 */
const pruneConditionTrackingKeepingSticky = async (userId, conditionSeq = '') => {
  const uid = String(userId);
  const seq = String(conditionSeq || '').trim();
  const state = await getIndicatorTrading(uid);
  const effectiveSeq = seq || String(state.settings?.buyCondition ?? '').trim();
  return applyConditionSnapshot(uid, [], effectiveSeq, {
    replace: true,
    markSnapshot: false,
  });
};

const clearSnapshotMark = (userId) => {
  lastSnapshotKstByUser.delete(String(userId));
};

const upsertTrackingStock = async (userId, stock, conditionSeq) => {
  const uid = String(userId);
  const code6 = code6Of(stock.stockCode);
  if (!code6) return null;

  const state = await getIndicatorTrading(uid);
  const settings = state.settings || {};
  const maxTrack = Math.max(1, Number(settings.maxTrackingStocks) || 90);
  const list = await getTrackingStocks(uid);
  const idx = list.findIndex((r) => code6Of(r.stockCode) === code6);

  const isNxt = await isNXTStock(stock.stockCode);
  const enriched = await enrichStockName(uid, stock);
  const row = buildTrackingRow(
    enriched,
    idx >= 0 ? list[idx] : null,
    conditionSeq,
    isNxt ? 'NXT' : 'KRX'
  );

  let next;
  if (idx >= 0) {
    next = [...list];
    next[idx] = stripOrderFieldsFromTracking({ ...next[idx], ...row });
  } else {
    if (list.length >= maxTrack) {
      console.warn(`[조건검색실시간][${uid}] maxTrackingStocks(${maxTrack}) 초과 — ${code6} 스킵`);
      return null;
    }
    next = [...list, stripOrderFieldsFromTracking(row)];
  }

  await saveTrackingStocks(uid, next);
  return row;
};

const removeTrackingStock = async (userId, stockCode) => {
  const uid = String(userId);
  const code6 = code6Of(stockCode);
  if (!code6) return;

  const openPos = await getActivePositionByCode(uid, stockCode);
  if (openPos) {
    console.log(`[조건검색실시간][${uid}] 이탈 ${code6} — 보유 포지션 유지`);
    return;
  }

  const list = await getTrackingStocks(uid);
  const hit = list.find((r) => code6Of(r.stockCode) === code6);
  if (hit?.source === 'manual') {
    console.log(`[조건검색실시간][${uid}] 이탈 ${code6} — 수동추가 유지`);
    return;
  }

  const next = list.filter((r) => code6Of(r.stockCode) !== code6);
  if (next.length === list.length) return;

  await saveTrackingStocks(uid, next);
  try {
    const { clearStopRebuyBelow } = require('./indicatorTradingTracker');
    await clearStopRebuyBelow(uid, code6);
  } catch {
    /* ignore */
  }
  console.log(`[조건검색실시간][${uid}] 이탈 ${code6} — tracking 제거`);
};

/**
 * 편입 종목 매수 시도 (자동매매 ON일 때만)
 */
const tryBuyOnEnter = async (userId, row, conditionSeq) => {
  const uid = String(userId);
  const state = await getIndicatorTrading(uid);
  if (!state.autoTradingEnabled) return;

  const kiwoomInfo = await getKiwoomInfo(uid);
  if (!kiwoomInfo?.accessToken) return;

  const holdingState = await createBuyHoldingState(uid);
  const result = await tryIndicatorBuyForStock(uid, row, {
    settings: state.settings || {},
    seq: conditionSeq,
    kiwoomInfo,
    holdingState,
    // 편입 이벤트에 실린 현재가
    priceFresh: true,
  });
  if (result.log) {
    console.log(`[조건검색실시간][${uid}] ${result.log}`);
  }
};

/**
 * WS REAL 편입/이탈 이벤트
 */
const handleConditionRealtimeEvent = async (userId, evt) => {
  if (!evt?.stockCode || !evt.action) return;

  const uid = String(userId);
  const state = await getIndicatorTrading(uid);
  if (!state.autoTradingEnabled) return;

  const seq = String(state.settings?.buyCondition ?? '').trim();
  if (!seq) return;

  const stock = await enrichStockName(uid, {
    stockCode: evt.stockCode,
    stockName: evt.stockName || '',
    price: evt.price,
  });

  if (evt.action === 'enter') {
    const code6 = code6Of(stock.stockCode);
    console.log(`[조건검색실시간][${uid}] 편입 ${code6}${stock.stockName ? ` ${stock.stockName}` : ''}`);
    const row = await upsertTrackingStock(uid, stock, seq);
    if (row) {
      try {
        const { requestSymbolRefreshSoon } = require('../services/indicatorWsMonitor');
        requestSymbolRefreshSoon();
      } catch {
        /* ignore */
      }
      await tryBuyOnEnter(uid, row, seq);
    }
    return;
  }

  if (evt.action === 'exit') {
    await removeTrackingStock(uid, evt.stockCode);
    try {
      const { requestSymbolRefreshSoon } = require('../services/indicatorWsMonitor');
      requestSymbolRefreshSoon();
    } catch {
      /* ignore */
    }
  }
};

/**
 * 자동매매 ON + WS 연결 시 조건검색 실시간 구독
 * — 당일 스냅샷이 없으면 강제 CLR+재구독으로 목록 교체
 */
const ensureConditionRealtimeSubscribed = async (userId, client) => {
  const uid = String(userId);
  const state = await getIndicatorTrading(uid);
  if (!state.autoTradingEnabled) {
    logSubscribeSkip(uid, 'auto_off');
    return { subscribed: false, reason: 'auto_off' };
  }

  const seq = String(state.settings?.buyCondition ?? '').trim();
  if (!seq) {
    logSubscribeSkip(uid, 'no_condition');
    return { subscribed: false, reason: 'no_condition' };
  }

  if (!client?.isConnected?.()) {
    logSubscribeSkip(uid, 'ws_disconnected');
    return { subscribed: false, reason: 'ws_disconnected' };
  }

  // 08:58 전 — 키움 CNSRREQ 무응답이 잦아 구독 보류 (시세 REG는 예열 구간에서 유지)
  if (!isConditionRealtimeSubscribeTime()) {
    logSubscribeSkip(uid, 'before_0858', '조건검색 구독 08:58 이후');
    return { subscribed: false, reason: 'before_0858' };
  }

  const retryAfter = client.getConditionRetryAfter?.() || 0;
  if (retryAfter > Date.now()) {
    const waitSec = Math.ceil((retryAfter - Date.now()) / 1000);
    logSubscribeSkip(uid, 'backoff', `${waitSec}s`);
    return { subscribed: false, reason: 'backoff' };
  }

  if (client.isConditionRealtimeSubscribing?.()) {
    logSubscribeSkip(uid, 'in_progress', 'client');
    return { subscribed: false, reason: 'in_progress' };
  }

  const needsDailySnapshot = !hasFreshSnapshotToday(uid);
  const currentSeq = client.getConditionRealtimeSeq?.() || '';
  if (
    !needsDailySnapshot &&
    client.isConditionRealtimeActive?.() &&
    currentSeq === seq
  ) {
    return { subscribed: true, reason: 'already' };
  }

  if (needsDailySnapshot && client.isConditionRealtimeActive?.() && currentSeq === seq) {
    const lastForce = lastForceSubscribeAt.get(uid) || 0;
    if (Date.now() - lastForce < FORCE_SUBSCRIBE_COOLDOWN_MS) {
      logSubscribeSkip(uid, 'force_cooldown', '당일 스냅샷 재시도 대기');
      return { subscribed: true, reason: 'force_cooldown' };
    }
    console.log(`[조건검색실시간][${uid}] 당일 스냅샷 없음 — 강제 재구독 seq=${seq}`);
  }

  const prev = subscriptionState.get(uid);
  if (prev?.subscribing) {
    logSubscribeSkip(uid, 'in_progress', 'state');
    return { subscribed: false, reason: 'in_progress' };
  }
  subscriptionState.set(uid, { seq, subscribing: true });

  const applySnapshotAndBuy = async (stocks) => {
    await applyConditionSnapshot(uid, stocks, seq, { replace: true });
    const buyLogs = await attemptBuysForStocks(uid, stocks, seq, { priceFresh: true });
    for (const log of buyLogs) {
      console.log(`[조건검색실시간][${uid}] ${log}`);
    }
    return buyLogs;
  };

  try {
    if (needsDailySnapshot) {
      lastForceSubscribeAt.set(uid, Date.now());
    }

    let msg = await client.subscribeConditionRealtime(seq, 'K', {
      force: needsDailySnapshot,
    });

    // alreadyActive인데 당일 스냅샷이 필요한 경우는 force로 막혀야 함. 방어적 처리.
    if (msg?.alreadyActive && needsDailySnapshot) {
      await client.unsubscribeConditionRealtime(seq);
      await new Promise((r) => setTimeout(r, 500));
      msg = await client.subscribeConditionRealtime(seq, 'K', { force: true });
    }

    if (msg?.alreadyActive && !needsDailySnapshot) {
      subscriptionState.set(uid, { seq, subscribing: false });
      return { subscribed: true, reason: 'already', initialCount: 0, buyLogs: [] };
    }

    // 기존 서버 등록 재사용 — 스냅샷 없음 → CLR 1회 더 시도 후, 실패 시 sticky만 유지하고 조건식 종목 정리
    if (msg?.reusedExisting) {
      console.warn(
        `[조건검색실시간][${uid}] 기존 등록 재사용 — CNSRCLR 후 1회 재시도 seq=${seq}`
      );
      await client.unsubscribeConditionRealtime(seq);
      await new Promise((r) => setTimeout(r, 700));
      msg = await client.subscribeConditionRealtime(seq, 'K', { force: true });
    }

    if (msg?.reusedExisting) {
      console.warn(
        `[조건검색실시간][${uid}] 재구독도 스냅샷 없음 — 조건식 잔존 종목 정리(포지션·수동 유지)`
      );
      await pruneConditionTrackingKeepingSticky(uid, seq);
      // 실스냅샷으로 치지 않음 → 쿨다운 후 재시도
      clearSnapshotMark(uid);
      subscriptionState.set(uid, { seq, subscribing: false });
      return { subscribed: true, reason: 'reused_pruned', initialCount: 0, buyLogs: [] };
    }

    const stocks = normalizeConditionStocks(msg?.data);
    const buyLogs = await applySnapshotAndBuy(stocks);

    subscriptionState.set(uid, { seq, subscribing: false });
    console.log(`[조건검색실시간][${uid}] 구독 완료 seq=${seq}, 초기 ${stocks.length}건`);
    return { subscribed: true, reason: 'ok', initialCount: stocks.length, buyLogs };
  } catch (err) {
    subscriptionState.delete(uid);
    console.error(`[조건검색실시간][${uid}] 구독 실패:`, err.message);
    // 연결 끊김 등 일시 오류 — desired 유지해 재연결 시 재시도
    return { subscribed: false, reason: 'error', error: err.message };
  }
};

/**
 * 자동매매 OFF 시 조건검색 실시간 해제
 */
const stopConditionRealtime = async (userId, client) => {
  const uid = String(userId);
  subscriptionState.delete(uid);

  const wsClient =
    client ||
    (() => {
      try {
        const { getConnectedRealtimeClient } = require('../services/indicatorWsMonitor');
        return getConnectedRealtimeClient(uid);
      } catch {
        return null;
      }
    })();

  // active가 아니어도 seq가 남아 있으면 CNSRCLR을 보내야 한다.
  // (응답 타임아웃 등으로 서버에만 등록이 남으면 "이미 등록됨"으로 재구독이 계속 막힘)
  const staleSeq =
    wsClient?.getConditionRealtimeSeq?.() ||
    wsClient?.getConditionRealtimeDesiredSeq?.() ||
    wsClient?.conditionRealtime?.seq ||
    '';

  if (wsClient && staleSeq) {
    await wsClient.unsubscribeConditionRealtime(staleSeq);
    console.log(`[조건검색실시간][${uid}] 구독 해제 seq=${staleSeq}`);
  }
};

/**
 * 조건식 변경·당일 강제 갱신 시 재구독
 * @param {string} userId
 * @param {{ forceDaily?: boolean }} [opts]
 */
const resubscribeConditionRealtime = async (userId, opts = {}) => {
  const uid = String(userId);
  if (opts.forceDaily) {
    lastSnapshotKstByUser.delete(uid);
    lastForceSubscribeAt.delete(uid);
  }
  await stopConditionRealtime(uid);
  try {
    const { getConnectedRealtimeClient, requestSubscribeRefreshSoon } = require('../services/indicatorWsMonitor');
    requestSubscribeRefreshSoon();
    const client = getConnectedRealtimeClient(uid);
    if (client) {
      return ensureConditionRealtimeSubscribed(uid, client);
    }
  } catch {
    /* ignore */
  }
  return { subscribed: false, reason: 'no_client' };
};

module.exports = {
  isConditionRealtimeActive,
  getSubscribedSeq,
  applyConditionSnapshot,
  handleConditionRealtimeEvent,
  ensureConditionRealtimeSubscribed,
  stopConditionRealtime,
  resubscribeConditionRealtime,
  hasFreshSnapshotToday,
  pruneConditionTrackingKeepingSticky,
  clearSnapshotMark,
};

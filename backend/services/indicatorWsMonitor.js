/**
 * 지표기반매매 WS — 조건검색·트래킹·포지션 시세 / 틱 매도·대기매수
 * 레지스트리 key: indicator (auto_v2 / hub 와 공유 연결)
 * 레거시 분할매매(auto) 와 분리
 */

const wsRegistry = require('./kiwoomUserWsRegistry');
const { getKiwoomInfo } = require('../utils/kiwoomUtils');
const { getAllUsers } = require('../utils/userStore');
const {
  isNXTTradingHours,
  isKRXSessionOpen,
  isPreMarketWarmup,
} = require('../utils/stockUtils');
const { listAutoTradingUserIds } = require('../utils/indicatorTradingStore');
const { normalizeAutoCode } = require('../utils/autoTradingMarket');

const LOG = '[지표WS]';
const REGISTRY_KEY = 'indicator';

const SUBSCRIBE_REFRESH_MS = 30000;
const OFF_MARKET_CHECK_MS = 60000;
const WARMUP_REFRESH_MS = 5000;
const TICK_DEBOUNCE_MS = 800;
const SUBSCRIBE_SOON_MS = 2000;

/** @type {Map<string, object>} */
const monitors = new Map();

let refreshTimer = null;
let soonRefreshTimer = null;
let started = false;

const mergePriority = (prev, next) => {
  if (prev?.priority == null) return next;
  if (next == null) return prev.priority;
  return Math.min(prev.priority, next);
};

async function getValidUsers() {
  const users = await getAllUsers();
  const valid = [];
  for (const user of users) {
    try {
      const info = await getKiwoomInfo(user.id);
      if (info?.accessToken && info?.appKey && info?.appSecret && info?.accountNo) {
        valid.push(user);
      }
    } catch {
      /* skip */
    }
  }
  return valid;
}

/** open 포지션 → 구독 */
async function mergeIndicatorOpenPositions(userId, codes, isKRXTime, isNXTTime) {
  try {
    const { listIndicatorOpenSymbolsForWs } = require('./indicatorSellMonitor');
    const list = await listIndicatorOpenSymbolsForWs(userId);
    for (const item of list) {
      const code6 = String(item.stockCode || '').substring(0, 6);
      if (!code6) continue;
      const stockMarket = item.stockMarket === 'NXT' ? 'NXT' : 'KRX';
      if (isNXTTime && stockMarket === 'NXT') {
        /* ok */
      } else if (isKRXTime || isPreMarketWarmup()) {
        /* ok */
      } else {
        continue;
      }
      const prev = codes.get(code6);
      codes.set(code6, {
        stockName: (prev && prev.stockName) || item.stockName || code6,
        stockMarket:
          (prev && prev.stockMarket === 'NXT') || stockMarket === 'NXT' ? 'NXT' : 'KRX',
        priority: mergePriority(prev, wsRegistry.PRIORITY.POSITION),
      });
    }
  } catch (err) {
    console.error(`${LOG} 포지션 구독 병합 실패:`, err.message);
  }
  return codes;
}

/** tracking_stocks → 구독 */
async function mergeIndicatorTrackingStocks(userId, codes) {
  try {
    const { getTrackingStocks } = require('../utils/indicatorTradingStore');
    const list = await getTrackingStocks(userId);
    for (const item of list) {
      const code6 = String(item.stockCode || '').substring(0, 6);
      if (!code6) continue;
      const prev = codes.get(code6);
      codes.set(code6, {
        stockName: (prev && prev.stockName) || item.stockName || code6,
        stockMarket:
          (prev && prev.stockMarket) || (item.stockMarket === 'NXT' ? 'NXT' : 'KRX'),
        priority: mergePriority(prev, wsRegistry.PRIORITY.TRACKING),
      });
    }
  } catch (err) {
    console.error(`${LOG} 트래킹 구독 병합 실패:`, err.message);
  }
  return codes;
}

/** 지표 매수/매도 체결만 처리 (V1/V2 분할은 각 모니터 담당) */
async function handleIndicatorOrderFill(userId, evt) {
  if (!evt?.orderNo || !evt.execQty || evt.execQty <= 0) return;

  const looksComplete =
    evt.fullyFilled ||
    (evt.unexecQty === 0 && evt.execQty > 0) ||
    (evt.orderQty > 0 && evt.execQty >= evt.orderQty);
  if (!looksComplete && evt.unexecQty != null && evt.unexecQty > 0) {
    return;
  }

  const uid = String(userId);
  const { parseAbsPrice } = require('../utils/orderExecutionPrice');
  const { roundFillPrice, isUsMarket } = require('../utils/autoTradingMarket');

  try {
    const { findPendingByOrderNo, completeIndicatorBuyFill } = require('../utils/indicatorBuyFill');
    const ind = findPendingByOrderNo(uid, evt.orderNo, evt.stockCode);
    if (ind && (evt.side === 'buy' || !evt.side)) {
      const fillMarket =
        ind.info.stockMarket || (isUsMarket(null, ind.info.stockCode) ? 'US' : 'KRX');
      const execPriceRaw =
        parseAbsPrice(evt.execPrice) > 0 ? parseAbsPrice(evt.execPrice) : ind.info.orderPrice;
      const execPrice = roundFillPrice(execPriceRaw, fillMarket) || ind.info.orderPrice;
      await completeIndicatorBuyFill({
        checkKey: ind.checkKey,
        userId: ind.info.userId,
        stockCode: ind.info.stockCode,
        stockName: ind.info.stockName,
        venue: ind.info.stockMarket,
        buyConditionSeq: ind.info.buyConditionSeq,
        orderNo: ind.info.orderNo,
        orderPrice: ind.info.orderPrice,
        buyQty: ind.info.buyQty,
        execPrice,
        execQty: evt.execQty,
        priceType: ind.info.priceType,
        source: 'ws00',
      });
      try {
        require('./dashboardStatusHub').notifyDashboardStatus(uid);
      } catch {
        /* ignore */
      }
      return;
    }
  } catch (err) {
    console.error(`${LOG}[${uid}] 매수체결 처리 오류:`, err.message);
  }

  try {
    const {
      findPendingSellByOrderNo,
      completeIndicatorSellFill,
    } = require('./indicatorSellMonitor');
    const indSell = findPendingSellByOrderNo(uid, evt.orderNo, evt.stockCode);
    if (indSell && (evt.side === 'sell' || !evt.side)) {
      const fillMarket =
        indSell.info.venue || (isUsMarket(null, indSell.info.stockCode) ? 'US' : 'KRX');
      const execPriceRaw =
        parseAbsPrice(evt.execPrice) > 0
          ? parseAbsPrice(evt.execPrice)
          : indSell.info.orderPrice;
      const execPrice = roundFillPrice(execPriceRaw, fillMarket) || indSell.info.orderPrice;
      await completeIndicatorSellFill({
        checkKey: indSell.checkKey,
        userId: indSell.info.userId,
        positionId: indSell.info.positionId,
        stockCode: indSell.info.stockCode,
        orderNo: indSell.info.orderNo,
        orderPrice: indSell.info.orderPrice,
        qty: indSell.info.qty,
        execPrice,
        execQty: evt.execQty,
        reason: indSell.info.reason,
        venue: indSell.info.venue,
        priceType: indSell.info.priceType,
        source: 'ws00',
      });
      try {
        require('./dashboardStatusHub').notifyDashboardStatus(uid);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.error(`${LOG}[${uid}] 매도체결 처리 오류:`, err.message);
  }
}

function ensureMonitor(userId) {
  let m = monitors.get(userId);
  if (m) return m;

  m = {
    userId,
    kiwoomInfo: null,
    lastPrices: new Map(),
    metaByCode: new Map(),
    debounceTimers: new Map(),
    processingCodes: new Set(),
    client: null,
  };

  m.client = wsRegistry.acquire(userId, REGISTRY_KEY, {
    onTick: (tick) => onUserTick(m, tick),
    onOrder: (evt) => {
      handleIndicatorOrderFill(m.userId, evt).catch((err) => {
        console.error(`${LOG}[${m.userId}] 주문체결 처리 오류:`, err.message);
      });
    },
    onCondition: (evt) => {
      const { handleConditionRealtimeEvent } = require('../utils/indicatorConditionRealtime');
      handleConditionRealtimeEvent(m.userId, evt).catch((err) => {
        console.error(`${LOG}[${m.userId}] 조건검색 실시간:`, err.message);
      });
    },
    onStatus: (info) => {
      if (info.status === 'error') {
        console.error(`${LOG}[${userId}] ${info.message || info.status}`);
      } else if (info.status === 'subscribed' || info.status === 'kiwoom_connected') {
        console.log(
          `${LOG}[${userId}] ${info.status}${info.message ? ` ${info.message}` : ''}`
        );
        if (info.status === 'kiwoom_connected') {
          setTimeout(() => {
            const { ensureConditionRealtimeSubscribed } = require('../utils/indicatorConditionRealtime');
            ensureConditionRealtimeSubscribed(userId, m.client).catch((err) => {
              console.error(`${LOG}[${userId}] 조건검색 구독:`, err.message);
            });
          }, 1500);
          const { recoverPendingIndicatorSells } = require('./indicatorSellMonitor');
          recoverPendingIndicatorSells(userId, { minPollIntervalMs: 0 }).catch((err) => {
            console.error(`${LOG}[${userId}] 매도체결 복구:`, err.message);
          });
          const { recoverPendingIndicatorBuys } = require('../utils/indicatorBuyFill');
          recoverPendingIndicatorBuys(userId, { minPollIntervalMs: 0 }).catch((err) => {
            console.error(`${LOG}[${userId}] 매수체결 복구:`, err.message);
          });
          const { hydrateStopRebuyPendings } = require('../utils/indicatorTradingTracker');
          hydrateStopRebuyPendings(userId).catch((err) => {
            console.error(`${LOG}[${userId}] 손절재매수 대기 복구:`, err.message);
          });
        }
      }
    },
  });

  monitors.set(userId, m);
  return m;
}

function destroyMonitor(userId) {
  const m = monitors.get(userId);
  if (!m) return;
  try {
    const { stopConditionRealtime } = require('../utils/indicatorConditionRealtime');
    stopConditionRealtime(userId, m.client).catch(() => {});
  } catch {
    /* ignore */
  }
  for (const t of m.debounceTimers.values()) clearTimeout(t);
  m.debounceTimers.clear();
  try {
    require('../utils/indicatorPendingBuys').clearPendingBuys(userId);
  } catch {
    /* ignore */
  }
  wsRegistry.release(userId, REGISTRY_KEY);
  monitors.delete(userId);
}

function destroyAllMonitors() {
  for (const userId of [...monitors.keys()]) {
    destroyMonitor(userId);
  }
}

function onUserTick(m, tick) {
  const raw = String(tick.stockCode || '').trim();
  if (!raw || !tick.price) return;

  const metaHint = m.metaByCode.get(raw) || m.metaByCode.get(raw.toUpperCase()) || {};
  const market = metaHint.stockMarket || 'KRX';
  const codeKey = normalizeAutoCode(raw, market);
  if (!codeKey) return;

  const meta = m.metaByCode.get(codeKey) || metaHint;
  const priceRow = {
    stockCode: codeKey,
    stockName: meta.stockName || codeKey,
    stockMarket: meta.stockMarket || market,
    price: tick.price,
    change: tick.change,
    changeRate: tick.changeRate,
    ts: Date.now(),
  };
  m.lastPrices.set(codeKey, priceRow);

  if (priceRow.stockMarket !== 'US') {
    try {
      const { hasPendingBuy } = require('../utils/indicatorPendingBuys');
      if (hasPendingBuy(m.userId, codeKey)) {
        const { retryPendingBuyOnTick } = require('../utils/indicatorTradingTracker');
        retryPendingBuyOnTick(m.userId, codeKey, priceRow.price)
          .then((logs) => {
            logs.forEach((line) => console.log(`[시세대기매수][${m.userId}] ${line}`));
          })
          .catch((err) => {
            console.error(`[시세대기매수][${m.userId}] ${codeKey} 재시도 오류:`, err.message);
          });
      }
    } catch {
      /* ignore */
    }
  }

  const existing = m.debounceTimers.get(codeKey);
  if (existing) clearTimeout(existing);

  m.debounceTimers.set(
    codeKey,
    setTimeout(() => {
      m.debounceTimers.delete(codeKey);
      runChecksForTick(m, codeKey).catch((err) => {
        console.error(`${LOG}[${m.userId}] 처리 오류 ${codeKey}:`, err.message);
      });
    }, TICK_DEBOUNCE_MS)
  );
}

async function runChecksForTick(m, codeKey) {
  if (m.processingCodes.has(codeKey)) return;
  const priceRow = m.lastPrices.get(codeKey);
  if (!priceRow) return;

  let kiwoomInfo = m.kiwoomInfo;
  if (!kiwoomInfo?.accessToken) {
    const info = await getKiwoomInfo(m.userId);
    if (!info?.accessToken) return;
    kiwoomInfo = {
      accessToken: info.accessToken,
      appKey: info.appKey,
      appSecret: info.appSecret,
      accountNo: info.accountNo,
    };
    m.kiwoomInfo = kiwoomInfo;
  }

  m.processingCodes.add(codeKey);
  try {
    if (priceRow.stockMarket === 'US') return;
    const { processIndicatorSellOnTick } = require('./indicatorSellMonitor');
    await processIndicatorSellOnTick(m.userId, codeKey, priceRow.price, kiwoomInfo);
  } catch (indErr) {
    console.error(`${LOG}[${m.userId}] 지표기반매도 ${codeKey}:`, indErr.message || indErr);
  } finally {
    m.processingCodes.delete(codeKey);
  }
}

async function refreshSubscriptions(opts = {}) {
  const { symbolsOnly = false } = opts;
  try {
    const isKRXTime = isKRXSessionOpen();
    const isNXTTime = isNXTTradingHours();
    const isWarmup = !isKRXTime && !isNXTTime && isPreMarketWarmup();
    const isKrSession = isKRXTime || isNXTTime || isWarmup;

    if (!isKrSession) {
      destroyAllMonitors();
      scheduleRefresh(OFF_MARKET_CHECK_MS);
      return;
    }

    const users = await getValidUsers();
    const indicatorAutoSet = new Set(await listAutoTradingUserIds());
    if (users.length === 0 && indicatorAutoSet.size === 0) {
      // 장중인데 대상이 없으면 토큰 만료·계좌번호 누락 등 곧 풀릴 수 있는 상황
      destroyAllMonitors();
      scheduleRefresh(OFF_MARKET_CHECK_MS);
      return;
    }

    const activeUserIds = new Set();

    for (const user of users) {
      const userId = String(user.id);
      const isIndicatorAuto = indicatorAutoSet.has(userId);
      if (!isIndicatorAuto) {
        destroyMonitor(userId);
        continue;
      }

      let codeMap = new Map();
      codeMap = await mergeIndicatorOpenPositions(userId, codeMap, isKRXTime, isNXTTime);
      codeMap = await mergeIndicatorTrackingStocks(userId, codeMap);

      activeUserIds.add(userId);
      const m = ensureMonitor(userId);
      m.kiwoomInfo = await getKiwoomInfo(user.id);
      m.metaByCode = codeMap;

      for (const code of [...m.lastPrices.keys()]) {
        if (!codeMap.has(code)) m.lastPrices.delete(code);
      }

      wsRegistry.setSymbols(
        userId,
        REGISTRY_KEY,
        [...codeMap.entries()].map(([code, meta]) => {
          const code6 = String(code).substring(0, 6);
          const symbol = isNXTTime && meta.stockMarket === 'NXT' ? `${code6}_NX` : code6;
          return { code: symbol, priority: meta.priority ?? wsRegistry.PRIORITY.TRACKING };
        }),
        wsRegistry.PRIORITY.TRACKING
      );

      if (!symbolsOnly) {
        const { ensureConditionRealtimeSubscribed } = require('../utils/indicatorConditionRealtime');
        const { getIndicatorTrading } = require('../utils/indicatorTradingStore');
        const indState = await getIndicatorTrading(userId);
        const wantSeq = String(indState.settings?.buyCondition ?? '').trim();
        const activeSeq = m.client.getConditionRealtimeSeq?.() || '';
        const isActive = m.client.isConditionRealtimeActive?.();
        const retryAfter = m.client.getConditionRetryAfter?.() || 0;
        const needsSubscribe = wantSeq && (!isActive || activeSeq !== wantSeq);
        if (needsSubscribe && Date.now() >= retryAfter) {
          ensureConditionRealtimeSubscribed(userId, m.client).catch((err) => {
            console.error(`${LOG}[${userId}] 조건검색 실시간:`, err.message);
          });
        }
      }

      if (codeMap.size > 0) {
        const sessionLabel =
          isNXTTime && !isKRXTime ? 'NXT' : isKRXTime ? 'KRX' : isWarmup ? 'warmup' : 'KR';
        console.log(
          `${LOG}[${userId}] 구독 ${codeMap.size}종목 (${sessionLabel}): ${[...codeMap.entries()]
            .map(([code, meta]) =>
              isNXTTime && meta.stockMarket === 'NXT' ? `${code}_NX` : code
            )
            .join(', ')}`
        );
      } else {
        console.log(
          `${LOG}[${userId}] 조건검색 실시간 대기 (시세 구독 0)` +
            (isWarmup ? ' — 개장 예열' : '')
        );
      }
    }

    for (const userId of [...monitors.keys()]) {
      if (!activeUserIds.has(userId)) destroyMonitor(userId);
    }

    scheduleRefresh(isWarmup ? WARMUP_REFRESH_MS : SUBSCRIBE_REFRESH_MS);
  } catch (err) {
    console.error(`${LOG} 구독 갱신 오류:`, err.message);
    scheduleRefresh(OFF_MARKET_CHECK_MS);
  }
}

function scheduleRefresh(ms) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshSubscriptions();
  }, ms);
}

function requestSymbolRefreshSoon() {
  if (!started) return;
  if (soonRefreshTimer) clearTimeout(soonRefreshTimer);
  soonRefreshTimer = setTimeout(() => {
    soonRefreshTimer = null;
    refreshSubscriptions({ symbolsOnly: true });
  }, SUBSCRIBE_SOON_MS);
}

function requestSubscribeRefreshSoon() {
  if (!started) return;
  if (soonRefreshTimer) clearTimeout(soonRefreshTimer);
  soonRefreshTimer = setTimeout(() => {
    soonRefreshTimer = null;
    refreshSubscriptions({ symbolsOnly: false });
  }, SUBSCRIBE_SOON_MS);
}

function startIndicatorWsMonitor() {
  if (started) return;
  started = true;
  console.log(
    `${LOG} 감시 시작 (시세=키움 WS 0B, 주문체결=00, 조건검색=CNSRREQ, 구독갱신=${SUBSCRIBE_REFRESH_MS / 1000}s)`
  );
  refreshSubscriptions();
}

function stopIndicatorWsMonitor() {
  started = false;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (soonRefreshTimer) {
    clearTimeout(soonRefreshTimer);
    soonRefreshTimer = null;
  }
  destroyAllMonitors();
}

function isUserWsConnected(userId) {
  const m = monitors.get(String(userId));
  return !!(m?.client?.isConnected && m.client.isConnected());
}

module.exports = {
  startIndicatorWsMonitor,
  stopIndicatorWsMonitor,
  requestSubscribeRefreshSoon,
  requestSymbolRefreshSoon,
  isUserWsConnected,
  getLastPrices(userId) {
    const uid = String(userId);
    const m = monitors.get(uid) || monitors.get(userId) || monitors.get(Number(userId));
    if (!m?.lastPrices) return new Map();
    return m.lastPrices;
  },
  getConnectedRealtimeClient(userId) {
    const m = monitors.get(userId) || monitors.get(String(userId)) || monitors.get(Number(userId));
    if (m?.client?.isConnected?.()) return m.client;
    return null;
  },
};

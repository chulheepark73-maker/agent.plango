/**
 * Dashboard Trailing / 주문번호 상태 스냅샷 빌더
 * (REST · WebSocket 푸시 공용)
 */

const { readStockListFile } = require('./stockListStore');
const { buyTrailingStopIntervals } = require('./autoTradingBuyTrailingStop');
const { trailingStopIntervals } = require('./autoTradingTrailingStop');
const { isUsMarket, normalizeAutoCode } = require('./autoTradingMarket');
const { getUsStockByTicker } = require('./usStockListStore');

/** 레거시 `userId_stockCode_stage` / V2 `userId_stockCode_stage_v2p{planId}` */
const parseTrailingCheckKey = (checkKey) => {
  const key = String(checkKey || '');
  const v2Match = /^([^_]+)_(.+)_(\d+)_v2p(\d+)$/.exec(key);
  if (v2Match) {
    return {
      userId: v2Match[1],
      stockCode: v2Match[2],
      stage: parseInt(v2Match[3], 10) || 0,
      planId: parseInt(v2Match[4], 10) || null,
    };
  }
  const firstUnderscoreIndex = key.indexOf('_');
  const lastUnderscoreIndex = key.lastIndexOf('_');
  if (firstUnderscoreIndex <= 0 || lastUnderscoreIndex <= firstUnderscoreIndex) {
    return null;
  }
  return {
    userId: key.substring(0, firstUnderscoreIndex),
    stockCode: key.substring(firstUnderscoreIndex + 1, lastUnderscoreIndex),
    stage: parseInt(key.substring(lastUnderscoreIndex + 1), 10) || 0,
    planId: null,
  };
};

let stockNameMapCache = { at: 0, map: null };
const STOCK_NAME_CACHE_MS = 60 * 1000;

const buildStockNameMap = async () => {
  const now = Date.now();
  if (stockNameMapCache.map && now - stockNameMapCache.at < STOCK_NAME_CACHE_MS) {
    return stockNameMapCache.map;
  }
  const stockList = await readStockListFile();
  const stockNameMap = new Map();
  stockList.forEach((stock) => {
    if (stock.stockCode) {
      stockNameMap.set(stock.stockCode, stock.stockName || stock.stockCode);
      const code6 = String(stock.stockCode).substring(0, 6);
      if (code6) stockNameMap.set(code6, stock.stockName || stock.stockCode);
    }
  });
  stockNameMapCache = { at: now, map: stockNameMap };
  return stockNameMap;
};

const resolveDisplayName = async (stockCode, stockNameMap, fallback = '') => {
  const code = String(stockCode || '').trim();
  if (!code) return fallback || '';
  const fromMap =
    stockNameMap.get(code) ||
    stockNameMap.get(code.toUpperCase()) ||
    stockNameMap.get(code.substring(0, 6));
  if (fromMap) return fromMap;
  if (isUsMarket(null, code)) {
    try {
      const master = await getUsStockByTicker(code);
      if (master?.stockName) return master.stockName;
    } catch {
      /* ignore */
    }
    return code.toUpperCase();
  }
  return fallback || code;
};

const buildV2OrderStatuses = async (userId) => {
  let openRows = [];
  try {
    const { listOpenTradingOrdersForUser } = require('./tradingV2Store');
    openRows = await listOpenTradingOrdersForUser(userId);
  } catch (err) {
    console.warn('[DashboardStatus] V2 미체결 주문 조회 실패:', err.message);
    return [];
  }

  const stockNameMap = await buildStockNameMap();
  const orderStatuses = [];

  for (const row of openRows) {
    const marketRaw = String(row.market || '').toUpperCase();
    const exchange = String(row.exchange || '').toUpperCase();
    const stockMarket =
      marketRaw === 'US' || isUsMarket(marketRaw, row.symbol)
        ? 'US'
        : exchange === 'NXT'
          ? 'NXT'
          : 'KRX';
    const stockCode = normalizeAutoCode(row.symbol, stockMarket);
    const stockName = await resolveDisplayName(
      stockCode,
      stockNameMap,
      row.name || stockCode
    );
    const side = String(row.order?.side || '').toUpperCase() === 'SELL' ? 'sell' : 'buy';
    const statusRaw = String(row.order?.status || '').toLowerCase();
    const statusLabel =
      statusRaw === 'partial' ? '부분체결' : statusRaw === 'pending' ? '주문대기' : '주문접수';

    orderStatuses.push({
      stockCode,
      stockName,
      stockMarket,
      stage: row.stageNo || 1,
      side,
      orderNo: row.order?.brokerOrderNo || null,
      orderPrice: parseFloat(row.order?.requestedPrice || 0),
      status: statusLabel,
      source: 'v2',
      planId: row.planId || null,
      updatedAt: row.order?.updatedAt || null,
    });
  }

  return orderStatuses;
};

const buildOrderStatuses = async (userId) => buildV2OrderStatuses(userId);

const resolveTrailingIdentity = (checkKey, info, stageField) => {
  const fromState = {
    userId: info.userId != null ? String(info.userId) : null,
    stockCode: info.stockCode || null,
    stage: info[stageField] != null ? Number(info[stageField]) : null,
    planId: info.v2Meta?.planId != null ? Number(info.v2Meta.planId) : null,
  };
  const parsed = parseTrailingCheckKey(checkKey);
  return {
    userId: fromState.userId || parsed?.userId || null,
    stockCode: fromState.stockCode || parsed?.stockCode || null,
    stage: Number.isFinite(fromState.stage) && fromState.stage > 0
      ? fromState.stage
      : parsed?.stage || 0,
    planId: fromState.planId || parsed?.planId || null,
  };
};

const buildTrailingStatuses = async (userId) => {
  const stockNameMap = await buildStockNameMap();
  const uid = String(userId);

  const buyStatuses = [];
  for (const [checkKey, info] of buyTrailingStopIntervals.entries()) {
    const identity = resolveTrailingIdentity(checkKey, info, 'buyStage');
    if (!identity.userId || String(identity.userId) !== uid) continue;
    if (!identity.stockCode) continue;

    const lowPrice = parseFloat(info.lowPrice || 0);
    const curPrice = parseFloat(info.curPrice || 0);
    const trailingPercent = parseFloat(info.trailingPercent || 0);
    const risePercent = lowPrice > 0 ? ((curPrice - lowPrice) / lowPrice) * 100 : 0;
    const stockMarket =
      info.stockMarket === 'US' || isUsMarket(info.stockMarket, identity.stockCode)
        ? 'US'
        : info.stockMarket || 'KRX';
    const stockCode =
      stockMarket === 'US' ? normalizeAutoCode(identity.stockCode, 'US') : identity.stockCode;
    const stockName = await resolveDisplayName(
      stockCode,
      stockNameMap,
      info.stockName || stockCode
    );

    buyStatuses.push({
      stockCode,
      stockName,
      stockMarket,
      stage: identity.stage,
      planId: identity.planId,
      checkKey,
      lowPrice,
      curPrice,
      risePercent,
      trailingPercent,
      targetPrice: info.buyXPrice != null ? parseFloat(info.buyXPrice) : null,
    });
  }

  const sellStatuses = [];
  for (const [checkKey, info] of trailingStopIntervals.entries()) {
    const identity = resolveTrailingIdentity(checkKey, info, 'sellStage');
    if (!identity.userId || String(identity.userId) !== uid) continue;
    if (!identity.stockCode) continue;

    const highPrice = parseFloat(info.highPrice || 0);
    const curPrice = parseFloat(info.curPrice || 0);
    const trailingPercent = parseFloat(info.trailingPercent || 0);
    const dropPercent = highPrice > 0 ? ((highPrice - curPrice) / highPrice) * 100 : 0;
    const stockMarket =
      info.stockMarket === 'US' || isUsMarket(info.stockMarket, identity.stockCode)
        ? 'US'
        : info.stockMarket || 'KRX';
    const stockCode =
      stockMarket === 'US' ? normalizeAutoCode(identity.stockCode, 'US') : identity.stockCode;
    const stockName = await resolveDisplayName(
      stockCode,
      stockNameMap,
      info.stockName || stockCode
    );

    sellStatuses.push({
      stockCode,
      stockName,
      stockMarket,
      stage: identity.stage,
      planId: identity.planId,
      checkKey,
      highPrice,
      curPrice,
      dropPercent,
      trailingPercent,
      targetPrice: info.sellXPrice != null ? parseFloat(info.sellXPrice) : null,
    });
  }

  return { buyStatuses, sellStatuses };
};

const buildDashboardStatusSnapshot = async (userId) => {
  const [trailingStatus, orderStatuses] = await Promise.all([
    buildTrailingStatuses(userId),
    buildOrderStatuses(userId),
  ]);
  return {
    type: 'dashboard_status',
    trailingStatus,
    orderStatuses,
    timestamp: new Date().toISOString(),
  };
};

module.exports = {
  parseTrailingCheckKey,
  buildStockNameMap,
  buildOrderStatuses,
  buildTrailingStatuses,
  buildDashboardStatusSnapshot,
};

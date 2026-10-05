/**
 * 키움 실전투자 / 모의투자 선택 (broker_accounts.trading_mode)
 *
 * 에이전트는 주인 1명이므로 모드는 에이전트 전체에 하나다.
 * REST·토큰·WebSocket 주소는 모두 여기서 현재 모드에 맞춰 고른다.
 */
const { db } = require('./tradingDb');
const { getOwnerUserId } = require('./agentIdentity');

const TRADING_MODES = ['live', 'mock'];

const HOSTS = {
  live: {
    rest: 'https://api.kiwoom.com',
    ws: 'wss://api.kiwoom.com:10000/api/dostk/websocket',
  },
  mock: {
    rest: 'https://mockapi.kiwoom.com',
    ws: 'wss://mockapi.kiwoom.com:10000/api/dostk/websocket',
  },
};

let cachedMode = null;

const normalizeTradingMode = (mode) => (mode === 'mock' ? 'mock' : 'live');

const readModeFromDb = () => {
  const owner = getOwnerUserId();
  const row = owner
    ? db
        .prepare(
          `SELECT trading_mode FROM broker_accounts
           WHERE user_id = ? AND broker = 'kiwoom'
           ORDER BY is_active DESC, id ASC LIMIT 1`
        )
        .get(String(owner))
    : null;
  return normalizeTradingMode(row?.trading_mode);
};

/** @returns {'live'|'mock'} */
const getTradingMode = () => {
  if (!cachedMode) cachedMode = readModeFromDb();
  return cachedMode;
};

const isMockMode = () => getTradingMode() === 'mock';

/** broker_accounts 저장 후 호출해 캐시를 맞춘다 */
const setCachedTradingMode = (mode) => {
  cachedMode = normalizeTradingMode(mode);
};

/** 실전 모드에서만 .env 의 KIWOOM_BASE_URL / KIWOOM_TOKEN_URL / KIWOOM_WS_URL 로 덮어쓸 수 있다 */
const getKiwoomRestBase = () =>
  isMockMode() ? HOSTS.mock.rest : process.env.KIWOOM_BASE_URL || HOSTS.live.rest;

const getKiwoomTokenUrl = () =>
  isMockMode()
    ? `${HOSTS.mock.rest}/oauth2/token`
    : process.env.KIWOOM_TOKEN_URL || `${getKiwoomRestBase()}/oauth2/token`;

const getKiwoomWsUrl = () =>
  isMockMode() ? HOSTS.mock.ws : process.env.KIWOOM_WS_URL || HOSTS.live.ws;

module.exports = {
  TRADING_MODES,
  normalizeTradingMode,
  getTradingMode,
  isMockMode,
  setCachedTradingMode,
  getKiwoomRestBase,
  getKiwoomTokenUrl,
  getKiwoomWsUrl,
};

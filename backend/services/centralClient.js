/**
 * PlanGo 중앙 서버(plango.today) API 클라이언트
 *
 * 공개
 *   GET    /api/agent/public-key            → { alg: 'RS256', publicKey }
 * 사용자 토큰 (Authorization: Bearer)
 *   POST   /api/auth/login                  { email, password, client } → { token, user }
 *   POST   /api/auth/logout
 *   POST   /api/auth/verify-password        { password } → { verified }
 *   POST   /api/agent/register              { name, version } → { agentId, agentSecret }
 * 에이전트 자격 (X-Agent-Id / X-Agent-Secret)
 *   GET    /api/agent/owner                 → { user, subscription, telegram }
 *   POST   /api/agent/notify                { text } → { ok }
 *   POST   /api/agent/telegram/deep-link    → { botUrl, botUsername, linkExpiresAt, telegramLinkPending }
 *   DELETE /api/agent/telegram/link         → { message }
 */
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const { loadAgentIdentity } = require('../utils/agentIdentity');

const OWNER_CACHE_TTL_MS = 60 * 1000;

const getCentralApiUrl = () =>
  String(process.env.CENTRAL_API_URL || 'https://plango.today').replace(/\/+$/, '');

const http = axios.create({ timeout: 15000 });
http.interceptors.request.use((config) => {
  config.baseURL = getCentralApiUrl();
  return config;
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const agentHeaders = () => {
  const a = loadAgentIdentity();
  if (!a.agentId || !a.agentSecret) {
    const e = new Error('에이전트가 중앙 서버에 페어링되지 않았습니다.');
    e.status = 401;
    e.code = 'AGENT_NOT_PAIRED';
    throw e;
  }
  return { 'X-Agent-Id': a.agentId, 'X-Agent-Secret': a.agentSecret };
};

/** 중앙 응답 에러를 { status, data } 를 가진 Error 로 변환 */
const wrap = async (fn) => {
  try {
    const res = await fn();
    return res.data;
  } catch (error) {
    const e = new Error(
      error.response?.data?.error || error.message || '중앙 서버 요청 실패'
    );
    e.status = error.response?.status || 502;
    e.data = error.response?.data || null;
    e.network = !error.response;
    throw e;
  }
};

/* ---------- 공개키 ---------- */

let publicKeyCache = null;

const readConfiguredPublicKey = () => {
  if (process.env.CENTRAL_JWT_PUBLIC_KEY) {
    return process.env.CENTRAL_JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
  }
  if (process.env.CENTRAL_JWT_PUBLIC_KEY_FILE) {
    return fs.readFileSync(process.env.CENTRAL_JWT_PUBLIC_KEY_FILE, 'utf8');
  }
  return null;
};

const getPublicKey = async ({ force = false } = {}) => {
  if (publicKeyCache && !force) return publicKeyCache;
  const configured = readConfiguredPublicKey();
  if (configured) {
    publicKeyCache = configured;
    return publicKeyCache;
  }
  const data = await wrap(() => http.get('/api/agent/public-key'));
  if (!data?.publicKey) throw new Error('중앙 서버 공개키를 받지 못했습니다.');
  publicKeyCache = data.publicKey;
  return publicKeyCache;
};

/* ---------- 사용자 토큰 ---------- */

const login = (body) => wrap(() => http.post('/api/auth/login', body));

const logout = (token) => wrap(() => http.post('/api/auth/logout', {}, { headers: bearer(token) }));

const verifyPassword = async (token, password) => {
  const data = await wrap(() =>
    http.post('/api/auth/verify-password', { password }, { headers: bearer(token) })
  );
  return !!data?.verified;
};

const registerAgent = (token) =>
  wrap(() =>
    http.post(
      '/api/agent/register',
      { name: process.env.AGENT_NAME || os.hostname(), version: require('../package.json').version },
      { headers: bearer(token) }
    )
  );

/* ---------- 에이전트 자격 ---------- */

let ownerCache = { at: 0, data: null };

/** 주인 프로필·구독·텔레그램 상태 (60초 캐시). 실패 시 마지막 캐시 반환, 없으면 throw */
const getOwnerStatus = async ({ force = false } = {}) => {
  if (!force && ownerCache.data && Date.now() - ownerCache.at < OWNER_CACHE_TTL_MS) {
    return ownerCache.data;
  }
  try {
    const data = await wrap(() => http.get('/api/agent/owner', { headers: agentHeaders() }));
    ownerCache = { at: Date.now(), data };
    return data;
  } catch (error) {
    if (ownerCache.data && error.network) return ownerCache.data;
    throw error;
  }
};

const getCachedOwnerStatus = () => ownerCache.data;

const invalidateOwnerStatus = () => {
  ownerCache = { at: 0, data: null };
};

const notify = (text) => wrap(() => http.post('/api/agent/notify', { text }, { headers: agentHeaders() }));

const createTelegramDeepLink = () =>
  wrap(() => http.post('/api/agent/telegram/deep-link', {}, { headers: agentHeaders() }));

const unlinkTelegram = () =>
  wrap(() => http.delete('/api/agent/telegram/link', { headers: agentHeaders() }));

module.exports = {
  getCentralApiUrl,
  getPublicKey,
  login,
  logout,
  verifyPassword,
  registerAgent,
  getOwnerStatus,
  getCachedOwnerStatus,
  invalidateOwnerStatus,
  notify,
  createTelegramDeepLink,
  unlinkTelegram,
};

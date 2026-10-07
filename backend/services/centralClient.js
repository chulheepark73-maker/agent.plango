/**
 * PlanGo 중앙 서버(plango.today) API 클라이언트
 *
 * 공개
 *   GET    /api/agent/public-key            → { alg: 'RS256', publicKey }
 *   GET    /api/auth/plans                  → { plans }
 * 사용자 토큰 (Authorization: Bearer)
 *   POST   /api/auth/login                  { email, password, client } → { token, user }
 *   POST   /api/auth/logout
 *   POST   /api/auth/verify-password        { password } → { verified }
 *   PUT    /api/auth/profile                { username, phoneNumber } → { message, user }
 *   PUT    /api/auth/change-password        { currentPassword, newPassword } → { message }
 *   GET    /api/auth/me                     → { id, email, ..., subscription... }
 *   POST   /api/auth/subscription           { planCode } → { message, subscription... }
 *   POST   /api/agent/register              { name, version } → { agentId, agentSecret }
 * 에이전트 자격 (X-Agent-Id / X-Agent-Secret, X-Agent-Version 은 중앙 목록의 버전 갱신용)
 *   GET    /api/agent/owner                 → { user, subscription, telegram }
 *   POST   /api/agent/notify                { text } → { ok }
 *   POST   /api/agent/telegram/deep-link    → { botUrl, botUsername, linkExpiresAt, telegramLinkPending }
 *   DELETE /api/agent/telegram/link         → { message }
 */
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const { loadAgentIdentity } = require('../utils/agentIdentity');
const { appVersion } = require('../utils/appVersion');

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
    const message = '이 서버가 PlanGo.Today 에 등록되지 않았습니다. 서버 등록 메뉴에서 등록하세요.';
    const e = new Error(message);
    // 401 은 프론트에서 로그아웃 처리되므로 사용하지 않는다
    e.status = 409;
    e.code = 'AGENT_NOT_REGISTERED';
    e.data = { error: message, code: e.code };
    throw e;
  }
  return { 'X-Agent-Id': a.agentId, 'X-Agent-Secret': a.agentSecret, 'X-Agent-Version': appVersion };
};

/** 화면에 내려줄 연결 실패 문구 (실제 설정된 중앙 주소 표시) */
const centralUnavailableMessage = () => `중앙 서버(${getCentralApiUrl()})에 연결할 수 없습니다.`;

/** 응답 없는 네트워크 오류의 원인 코드 (localhost 는 ::1·127.0.0.1 둘 다 실패하면 AggregateError) */
const networkErrorCode = (error) => {
  const codes = [error.code, ...(error.errors || []).map((x) => x?.code)].filter(Boolean);
  return [...new Set(codes)].join('/') || 'NETWORK_ERROR';
};

/** 중앙 응답 에러를 { status, data } 를 가진 Error 로 변환 */
const wrap = async (fn) => {
  try {
    const res = await fn();
    return res.data;
  } catch (error) {
    const e = new Error(
      error.response
        ? error.response.data?.error || error.message || '중앙 서버 요청 실패'
        : `중앙 서버(${getCentralApiUrl()}) 연결 실패: ${networkErrorCode(error)}`
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

const listPlans = () => wrap(() => http.get('/api/auth/plans'));

/* ---------- 사용자 토큰 ---------- */

const login = (body) => wrap(() => http.post('/api/auth/login', body));

const logout = (token) => wrap(() => http.post('/api/auth/logout', {}, { headers: bearer(token) }));

const verifyPassword = async (token, password) => {
  const data = await wrap(() =>
    http.post('/api/auth/verify-password', { password }, { headers: bearer(token) })
  );
  return !!data?.verified;
};

const updateProfile = (token, { username, phoneNumber }) =>
  wrap(() => http.put('/api/auth/profile', { username, phoneNumber }, { headers: bearer(token) }));

const changePassword = (token, { currentPassword, newPassword }) =>
  wrap(() =>
    http.put('/api/auth/change-password', { currentPassword, newPassword }, { headers: bearer(token) })
  );

const getMe = (token) => wrap(() => http.get('/api/auth/me', { headers: bearer(token) }));

const changeSubscription = (token, planCode) =>
  wrap(() => http.post('/api/auth/subscription', { planCode }, { headers: bearer(token) }));

const listMySubscriptions = (token) =>
  wrap(() => http.get('/api/auth/subscriptions', { headers: bearer(token) }));

const registerAgent = (token) =>
  wrap(() =>
    http.post(
      '/api/agent/register',
      { name: process.env.AGENT_NAME || os.hostname(), version: appVersion },
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
  centralUnavailableMessage,
  getPublicKey,
  listPlans,
  login,
  logout,
  verifyPassword,
  updateProfile,
  changePassword,
  getMe,
  changeSubscription,
  listMySubscriptions,
  registerAgent,
  getOwnerStatus,
  getCachedOwnerStatus,
  invalidateOwnerStatus,
  notify,
  createTelegramDeepLink,
  unlinkTelegram,
};

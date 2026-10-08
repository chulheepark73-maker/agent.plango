const jwt = require('jsonwebtoken');
const { getPublicKey } = require('../services/centralClient');
const { hasOwner, isOwner, isRegistered } = require('../utils/agentIdentity');
const { isAccountBlocked, accountBlockMessage } = require('../utils/accountBlock');
const { getAgentRevoked, NOT_REGISTERED_MESSAGE } = require('../utils/agentLock');

const authError = (status, message, code) => {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
};

const verifyWithKey = (token, key) =>
  new Promise((resolve, reject) => {
    const options = { algorithms: ['RS256'] };
    if (process.env.CENTRAL_JWT_ISSUER) options.issuer = process.env.CENTRAL_JWT_ISSUER;
    jwt.verify(token, key, options, (err, decoded) => (err ? reject(err) : resolve(decoded)));
  });

/** 중앙 서버가 RS256 으로 서명한 토큰 검증 (서명만, 사용자 확인 제외) */
const verifyCentralSignature = async (token) => {
  if (!token) throw authError(401, '인증 토큰이 필요합니다.');
  let key;
  try {
    key = await getPublicKey();
  } catch (error) {
    throw authError(503, `중앙 서버 공개키를 가져올 수 없습니다: ${error.message}`, 'CENTRAL_UNAVAILABLE');
  }
  let decoded;
  try {
    decoded = await verifyWithKey(token, key);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw authError(401, '로그인이 만료되었습니다. 다시 로그인해주세요.', 'SESSION_EXPIRED');
    }
    if (err.name === 'JsonWebTokenError' && /signature/i.test(err.message)) {
      // 중앙 키 교체 대비: 공개키를 한 번 다시 받아 재시도
      try {
        decoded = await verifyWithKey(token, await getPublicKey({ force: true }));
      } catch {
        throw authError(403, '유효하지 않은 토큰입니다.');
      }
    } else {
      throw authError(403, '유효하지 않은 토큰입니다.');
    }
  }
  if (!decoded?.userId) throw authError(403, '토큰에 사용자 정보가 없습니다.');
  decoded.userId = String(decoded.userId);
  return decoded;
};

/** 로그아웃한 토큰 (token → exp ms). 메모리 보관이라 재시작 시 초기화됨 */
const revokedTokens = new Map();

const revokeToken = (token, claims) => {
  if (!token) return;
  const now = Date.now();
  for (const [t, exp] of revokedTokens) if (exp < now) revokedTokens.delete(t);
  revokedTokens.set(token, claims?.exp ? claims.exp * 1000 : now + 24 * 3600 * 1000);
};

/** 서명 검증 + 이 에이전트 사용자인지 확인 */
const verifyAgentToken = async (token) => {
  if (token && revokedTokens.has(token)) {
    throw authError(401, '로그아웃된 토큰입니다. 다시 로그인해주세요.', 'SESSION_EXPIRED');
  }
  const user = await verifyCentralSignature(token);
  if (!hasOwner()) {
    throw authError(401, '에이전트 사용자가 정해지지 않았습니다. 다시 로그인해주세요.', 'AGENT_NO_OWNER');
  }
  if (!isOwner(user.userId)) {
    throw authError(403, '이 에이전트에 등록된 계정이 아닙니다.', 'AGENT_OWNER_MISMATCH');
  }
  if (isAccountBlocked()) {
    throw authError(403, accountBlockMessage(), 'ACCOUNT_BLOCKED');
  }
  return user;
};

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  try {
    req.user = await verifyAgentToken(token);
    req.token = token;
    next();
  } catch (error) {
    res.status(error.status || 403).json({ error: error.message, code: error.code });
  }
};

/** 서버 미등록 상태에서도 열어 두는 API (app.use('/api') 기준 경로) */
const UNREGISTERED_ALLOWED = [
  /^\/health$/,
  /^\/auth(\/|$)/,
  /^\/subscription(\/|$)/,
  /^\/settings\/version$/,
  /^\/settings\/user-settings$/,
];

/** 서버 미등록이면 등록·계정·요금제 외 API 를 막는다 */
const requireRegisteredAgent = (req, res, next) => {
  if (isRegistered() || UNREGISTERED_ALLOWED.some((re) => re.test(req.path))) return next();
  const revoked = getAgentRevoked();
  res.status(403).json({
    error: revoked?.message || NOT_REGISTERED_MESSAGE,
    code: 'AGENT_NOT_REGISTERED',
    revoked: !!revoked,
  });
};

module.exports = {
  authenticateToken,
  verifyAgentToken,
  verifyCentralSignature,
  revokeToken,
  requireRegisteredAgent,
};

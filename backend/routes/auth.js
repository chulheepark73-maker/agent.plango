/**
 * 인증 — 중앙 서버(plango.today) 프록시
 * - 회원가입/이메일 인증/비밀번호 변경은 중앙 웹에서 처리
 * - 첫 로그인 시 이 에이전트를 해당 계정에 페어링
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const central = require('../services/centralClient');
const { authenticateToken, verifyCentralSignature, revokeToken } = require('../middleware/auth');
const { loadAgentIdentity, saveAgentIdentity, isPaired, isOwner } = require('../utils/agentIdentity');
const { upsertOwnerUser, getUserById } = require('../utils/userStore');
const { getSubscriptionSummaryForUser } = require('../utils/subscriptionStore');
const { logLogin } = require('../utils/logger');

const getClientIp = (req) => {
  let ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.headers['x-real-ip'] || '').trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'Unknown';
  if (ip === '::1') ip = '127.0.0.1';
  if (ip.startsWith('::ffff:')) ip = ip.substring(7);
  return ip;
};

/** web / app 구분 (body.client 또는 X-Client 헤더) */
const resolveLoginClient = (req) => {
  const raw = String(req.body?.client || req.headers['x-client'] || req.headers['x-client-type'] || '')
    .trim()
    .toLowerCase();
  if (!raw) return 'unknown';
  if (['app', 'mobile', 'ios', 'android'].includes(raw)) return 'app';
  if (raw === 'web' || raw === 'browser') return 'web';
  return raw.slice(0, 32);
};

const maskEmail = (email) => {
  if (!email || !email.includes('@')) return email || null;
  const [id, domain] = email.split('@');
  return `${id.slice(0, 2)}${'*'.repeat(Math.max(1, id.length - 2))}@${domain}`;
};

/** 로그인 화면용: 페어링 여부 (인증 불필요) */
router.get('/agent-status', (req, res) => {
  const a = loadAgentIdentity();
  res.json({
    paired: isPaired(),
    ownerEmail: maskEmail(a.ownerEmail),
    pairedAt: a.pairedAt || null,
  });
});

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('유효한 이메일 주소를 입력하세요.'),
    body('password').notEmpty().withMessage('비밀번호가 필요합니다.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { email, password } = req.body;
    const clientIp = getClientIp(req);
    const client = resolveLoginClient(req);

    let data;
    try {
      data = await central.login({ email, password, client });
    } catch (error) {
      logLogin('LOGIN', null, email, clientIp, false, error.message, client);
      return res
        .status(error.network ? 503 : error.status)
        .json(
          error.network
            ? { error: '중앙 서버(plango.today)에 연결할 수 없습니다.', code: 'CENTRAL_UNAVAILABLE' }
            : error.data || { error: error.message }
        );
    }

    try {
      const claims = await verifyCentralSignature(data.token);
      const userId = claims.userId;
      const profile = { ...(data.user || {}), id: userId };

      if (!isPaired()) {
        const reg = await central.registerAgent(data.token);
        if (!reg?.agentId || !reg?.agentSecret) {
          throw new Error('중앙 서버에서 에이전트 등록 정보를 받지 못했습니다.');
        }
        saveAgentIdentity({
          ownerUserId: userId,
          ownerUsername: profile.username || claims.username || null,
          ownerEmail: profile.email || email,
          agentId: reg.agentId,
          agentSecret: reg.agentSecret,
          pairedAt: new Date().toISOString(),
        });
        console.log(`[에이전트] 페어링 완료 owner=${userId} agentId=${reg.agentId}`);
      } else if (!isOwner(userId)) {
        central.logout(data.token).catch(() => {});
        logLogin('LOGIN', userId, email, clientIp, false, '에이전트 주인 아님', client);
        return res.status(403).json({
          error: '이 에이전트는 다른 계정에 등록되어 있습니다.',
          code: 'AGENT_OWNER_MISMATCH',
        });
      }

      await upsertOwnerUser({
        id: userId,
        email: profile.email || email,
        username: profile.username || claims.username,
        phoneNumber: profile.phoneNumber,
      });
      central.invalidateOwnerStatus();

      logLogin('LOGIN', userId, profile.username || email, clientIp, true, '', client);
      res.json({
        message: '로그인 성공',
        token: data.token,
        user: { id: userId, email: profile.email || email, username: profile.username || claims.username },
      });
    } catch (error) {
      console.error('[로그인] 처리 오류:', error);
      logLogin('LOGIN', null, email, clientIp, false, error.message, client);
      res.status(error.status && error.status < 500 ? error.status : 500).json({
        error: error.message || '로그인 중 오류가 발생했습니다.',
        code: error.code,
      });
    }
  }
);

router.post('/logout', authenticateToken, async (req, res) => {
  logLogin('LOGOUT', req.user.userId, req.user.username, getClientIp(req), true, '', resolveLoginClient(req));
  revokeToken(req.token, req.user);
  try {
    await central.logout(req.token);
  } catch (error) {
    console.warn('[로그아웃] 중앙 로그아웃 실패:', error.message);
  }
  res.json({ message: '로그아웃되었습니다.' });
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await getUserById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }
    const sub = await getSubscriptionSummaryForUser(req.user.userId);
    res.json({
      id: user.id,
      email: user.email,
      username: user.username,
      phoneNumber: user.phoneNumber || null,
      subscription: sub.subscription,
      subscriptionPlanCode: sub.subscriptionPlanCode,
      subscriptionPlanName: sub.subscriptionPlanName,
      subscriptionCycle: sub.subscriptionCycle,
      subscriptionStartedAt: sub.subscriptionStartedAt,
      subscriptionExpiresAt: sub.subscriptionExpiresAt,
      subscriptionNextPaymentDate: sub.subscriptionNextPaymentDate,
      maxWatchlist: sub.maxWatchlist,
      maxAutoTrading: sub.maxAutoTrading,
      createdAt: user.createdAt,
    });
  } catch (error) {
    console.error('[me] 오류:', error);
    res.status(500).json({ error: '사용자 정보 조회 중 오류가 발생했습니다.' });
  }
});

router.post('/verify-password', authenticateToken, async (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: '비밀번호를 입력해주세요.' });
  }
  try {
    res.json({ verified: await central.verifyPassword(req.token, String(password)) });
  } catch (error) {
    console.error('[비밀번호 확인] 중앙 오류:', error.message);
    res.status(error.network ? 503 : 502).json({ error: '비밀번호 확인 중 오류가 발생했습니다.' });
  }
});

module.exports = router;

/**
 * 인증 — 중앙 서버(plango.today) 프록시
 * - 회원가입/이메일 인증은 중앙 웹에서 처리, 개인정보·비밀번호 변경은 중앙 API 프록시
 * - 첫 로그인 시 이 에이전트를 해당 계정에 페어링
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const central = require('../services/centralClient');
const { authenticateToken, verifyCentralSignature, revokeToken } = require('../middleware/auth');
const {
  loadAgentIdentity,
  saveAgentIdentity,
  hasOwner,
  isRegistered,
  isOwner,
} = require('../utils/agentIdentity');
const { upsertOwnerUser, getUserById } = require('../utils/userStore');
const { applyAccountBlock, clearAccountBlock, getAccountBlock } = require('../utils/accountBlock');
const { getAgentRevoked, onAgentRegistered } = require('../utils/agentLock');
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

/** 등록 해제 안내 (화면 표시용, 비밀값 제외) */
const revokedInfo = () => {
  const r = getAgentRevoked();
  return r ? { at: r.at, code: r.code, message: r.message } : null;
};

/** 로그인 화면용: 사용자·서버 등록 여부 (인증 불필요) */
router.get('/agent-status', (req, res) => {
  const a = loadAgentIdentity();
  const block = getAccountBlock();
  res.json({
    hasOwner: hasOwner(),
    registered: isRegistered(),
    ownerEmail: maskEmail(a.ownerEmail),
    registeredAt: a.registeredAt || a.pairedAt || null,
    accountBlocked: block ? { status: block.status, message: block.message } : null,
    agentRevoked: revokedInfo(),
  });
});

/** 서버 등록 상태 */
router.get('/server-registration', authenticateToken, (req, res) => {
  const a = loadAgentIdentity();
  res.json({
    registered: isRegistered(),
    agentId: a.agentId || null,
    registeredAt: a.registeredAt || a.pairedAt || null,
    lastSyncedAt: a.lastSyncedAt || null,
    centralUrl: central.getCentralApiUrl(),
    agentRevoked: revokedInfo(),
  });
});

/**
 * 서버 등록 — 비밀번호 재확인 후 중앙에서 에이전트 키 발급
 * 중앙 정책상 같은 계정의 기존 등록 서버는 폐기된다.
 */
router.post('/server-registration', authenticateToken, async (req, res) => {
  const password = String(req.body?.password || '');
  if (!password) return res.status(400).json({ error: '비밀번호를 입력해주세요.' });

  try {
    if (!(await central.verifyPassword(req.token, password))) {
      return res.status(400).json({ error: '비밀번호가 일치하지 않습니다.', code: 'PASSWORD_MISMATCH' });
    }
    const reg = await central.registerAgent(req.token);
    if (!reg?.agentId || !reg?.agentSecret) {
      throw new Error('중앙 서버에서 에이전트 등록 정보를 받지 못했습니다.');
    }
    const registeredAt = new Date().toISOString();
    saveAgentIdentity({ agentId: reg.agentId, agentSecret: reg.agentSecret, registeredAt });
    central.invalidateOwnerStatus();
    onAgentRegistered();
    console.log(`[에이전트] 서버 등록 완료 owner=${req.user.userId} agentId=${reg.agentId}`);

    let subscription = null;
    try {
      const { runSubscriptionSync } = require('../utils/subscriptionSyncScheduler');
      subscription = (await runSubscriptionSync('server-registration'))?.subscription || null;
    } catch (e) {
      console.warn('[서버 등록] 구독 동기화 실패:', e.message);
    }

    res.json({ message: '서버 등록이 완료되었습니다.', registered: true, agentId: reg.agentId, registeredAt, subscription });
  } catch (error) {
    console.error('[서버 등록] 오류:', error.message);
    if (error.network) {
      return res.status(503).json({ error: central.centralUnavailableMessage(), code: 'CENTRAL_UNAVAILABLE' });
    }
    res.status(error.status && error.status < 500 ? error.status : 502).json({
      error: error.data?.error || error.message || '서버 등록 중 오류가 발생했습니다.',
      code: error.data?.code || error.code,
    });
  }
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
      const ownerEmail = String(loadAgentIdentity().ownerEmail || '').toLowerCase();
      if (error.data?.code === 'ACCOUNT_BLOCKED' && ownerEmail && ownerEmail === String(email).toLowerCase()) {
        await applyAccountBlock({ message: error.data.error, source: 'login' });
      }
      return res
        .status(error.network ? 503 : error.status)
        .json(
          error.network
            ? { error: central.centralUnavailableMessage(), code: 'CENTRAL_UNAVAILABLE' }
            : error.data || { error: error.message }
        );
    }

    try {
      const claims = await verifyCentralSignature(data.token);
      const userId = claims.userId;
      const profile = { ...(data.user || {}), id: userId };

      // 첫 로그인 계정을 사용자로만 정한다. 중앙 에이전트 키 발급은 '서버 등록' 메뉴에서.
      if (!hasOwner()) {
        saveAgentIdentity({
          ownerUserId: userId,
          ownerUsername: profile.username || claims.username || null,
          ownerEmail: profile.email || email,
          ownerSince: new Date().toISOString(),
        });
        console.log(`[에이전트] 사용자 지정 owner=${userId} (서버 등록 전)`);
      } else if (!isOwner(userId)) {
        central.logout(data.token).catch(() => {});
        logLogin('LOGIN', userId, email, clientIp, false, '에이전트 사용자 아님', client);
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
      await clearAccountBlock({ source: 'login' });

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

/** 중앙 오류를 그대로 전달 (중앙 401 은 프론트 로그아웃을 유발하므로 그대로 둔다) */
const sendCentralError = (res, error, fallback) => {
  if (error.network) {
    return res.status(503).json({ error: central.centralUnavailableMessage(), code: 'CENTRAL_UNAVAILABLE' });
  }
  res.status(error.status && error.status < 500 ? error.status : 502).json({
    error: error.data?.error || error.data?.errors?.[0]?.msg || error.message || fallback,
    code: error.data?.code,
  });
};

/** 개인정보(사용자명·휴대폰) 수정 — 중앙에 반영 후 로컬 사본 갱신 */
router.put('/profile', authenticateToken, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const phoneNumber = String(req.body?.phoneNumber || '').trim();
  if (!username) return res.status(400).json({ error: '이름을 입력해주세요.' });
  if (!phoneNumber) return res.status(400).json({ error: '휴대폰 번호를 입력해주세요.' });

  try {
    const data = await central.updateProfile(req.token, { username, phoneNumber });
    const u = data?.user || {};
    const current = await getUserById(req.user.userId);
    await upsertOwnerUser({
      id: req.user.userId,
      email: u.email || current?.email,
      username: u.username || username,
      phoneNumber: u.phoneNumber || phoneNumber.replace(/[-\s]/g, ''),
    });
    central.invalidateOwnerStatus();
    res.json({ message: data?.message || '개인정보가 수정되었습니다.', user: u });
  } catch (error) {
    console.error('[개인정보 수정] 오류:', error.message);
    sendCentralError(res, error, '개인정보 수정 중 오류가 발생했습니다.');
  }
});

router.put('/change-password', authenticateToken, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (!currentPassword) return res.status(400).json({ error: '현재 비밀번호를 입력해주세요.' });
  if (newPassword.length < 6) return res.status(400).json({ error: '새 비밀번호는 최소 6자 이상이어야 합니다.' });

  try {
    const data = await central.changePassword(req.token, { currentPassword, newPassword });
    res.json({ message: data?.message || '비밀번호가 변경되었습니다.' });
  } catch (error) {
    console.error('[비밀번호 변경] 오류:', error.message);
    sendCentralError(res, error, '비밀번호 변경 중 오류가 발생했습니다.');
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

/**
 * 구독 — 중앙 서버(member_plans, subscriptions) 프록시
 */
const express = require('express');
const router = express.Router();
const central = require('../services/centralClient');
const { authenticateToken } = require('../middleware/auth');
const { runSubscriptionSync } = require('../utils/subscriptionSyncScheduler');
const { isRegistered } = require('../utils/agentIdentity');

router.get('/plans', authenticateToken, async (req, res) => {
  try {
    const data = await central.listPlans();
    res.json({ plans: Array.isArray(data?.plans) ? data.plans : [] });
  } catch (error) {
    console.error('[구독 플랜] 중앙 오류:', error.message);
    if (error.network) {
      return res.status(503).json({ error: central.centralUnavailableMessage(), code: 'CENTRAL_UNAVAILABLE' });
    }
    res.status(502).json({ error: error.data?.error || '구독 플랜을 불러오지 못했습니다.' });
  }
});

/**
 * 중앙에 저장된 내 구독 (사용자 토큰으로 조회 — 서버 미등록이어도 확인 가능)
 * registered=false 이면 이 서버에는 아직 구독 한도가 적용되지 않는다(무료 한도)
 */
router.get('/current', authenticateToken, async (req, res) => {
  try {
    const me = await central.getMe(req.token);
    res.json({
      registered: isRegistered(),
      subscription: me?.subscription === 'Y' ? 'Y' : 'N',
      subscriptionPlanCode: me?.subscriptionPlanCode || 'free',
      subscriptionPlanName: me?.subscriptionPlanName || '무료',
      subscriptionCycle: me?.subscriptionCycle || null,
      subscriptionStartedAt: me?.subscriptionStartedAt || null,
      subscriptionExpiresAt: me?.subscriptionExpiresAt || null,
    });
  } catch (error) {
    console.error('[구독 조회] 중앙 오류:', error.message);
    if (error.network) {
      return res.status(503).json({ error: central.centralUnavailableMessage(), code: 'CENTRAL_UNAVAILABLE' });
    }
    res.status(error.status && error.status < 500 ? error.status : 502).json({
      error: error.data?.error || '구독 정보를 불러오지 못했습니다.',
    });
  }
});

/** 구독 플랜 변경 { planCode } — 중앙에서 처리 후 즉시 동기화(무료 전환 시 자동매매 OFF 포함) */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const planCode = String(req.body?.planCode || '').trim();
    if (!planCode) return res.status(400).json({ error: '플랜을 선택해주세요.' });

    const data = await central.changeSubscription(req.token, planCode);
    central.invalidateOwnerStatus();
    await runSubscriptionSync('plan-change').catch((e) =>
      console.warn('[구독 변경] 동기화 실패:', e.message)
    );
    res.json(data);
  } catch (error) {
    console.error('[구독 변경] 중앙 오류:', error.message);
    if (error.network) {
      return res.status(503).json({ error: central.centralUnavailableMessage(), code: 'CENTRAL_UNAVAILABLE' });
    }
    res.status(error.status && error.status < 500 ? error.status : 502).json({
      error: error.data?.error || '구독 변경에 실패했습니다.',
    });
  }
});

module.exports = router;

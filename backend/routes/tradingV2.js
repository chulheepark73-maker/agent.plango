const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  ensureTradingV2Tables,
  ensureBrokerAccountForUser,
  upsertInstrument,
  createTradingPlan,
  listTradingPlans,
  getTradingPlanById,
  updateTradingPlan,
  deleteTradingPlan,
  openNewCycle,
  createTradingOrder,
  createTradingFill,
  STRATEGY_TYPES,
  PLAN_STATUSES,
} = require('../utils/tradingV2Store');

const notifyV2MonitorRefresh = () => {
  try {
    const { requestSubscribeRefreshSoon } = require('../services/autoTradingWsMonitor_v2');
    requestSubscribeRefreshSoon();
  } catch {
    /* monitor not started */
  }
};
router.use(authenticateToken);

router.get('/meta', async (_req, res) => {
  res.json({
    strategyTypes: STRATEGY_TYPES,
    planStatuses: PLAN_STATUSES,
    note: 'Trading V2 sandbox — legacy auto_tradings untouched',
  });
});

/** 보유종목 일괄청산 — body: { password, planIds: number[], limitPrice?: number(미국 지정가) } */
router.post('/liquidate', async (req, res) => {
  try {
    const { password, planIds, limitPrice } = req.body || {};
    if (!password) return res.status(400).json({ error: '비밀번호를 입력해주세요.' });
    if (!Array.isArray(planIds) || planIds.length === 0) {
      return res.status(400).json({ error: '청산할 플랜이 없습니다.' });
    }
    const { verifyPassword } = require('../services/centralClient');
    if (!(await verifyPassword(req.token, String(password)))) {
      return res.status(403).json({ error: '비밀번호가 일치하지 않습니다.' });
    }

    const { liquidatePlans } = require('../utils/tradingV2Liquidation');
    const results = await liquidatePlans(req.user.userId, planIds, {
      limitPrice: limitPrice != null ? Number(limitPrice) : null,
    });
    res.json({ ok: results.some((r) => r.ok), results });
  } catch (error) {
    console.error('[TradingV2] 일괄청산 실패:', error.message);
    res.status(error.status || 500).json({ error: error.message || '일괄청산 실패' });
  }
});

router.post('/bootstrap', async (req, res) => {
  try {
    await ensureTradingV2Tables();
    const account = await ensureBrokerAccountForUser(req.user.userId);
    res.json({ ok: true, brokerAccount: account });
  } catch (error) {
    console.error('[TradingV2] bootstrap 실패:', error);
    res.status(500).json({ error: error.message || '부트스트랩 실패' });
  }
});

router.post('/instruments', async (req, res) => {
  try {
    const result = await upsertInstrument(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || '종목 등록 실패' });
  }
});

router.get('/plans', async (req, res) => {
  try {
    const plans = await listTradingPlans(req.user.userId, {
      status: req.query.status || undefined,
    });
    res.json({ plans });
  } catch (error) {
    console.error('[TradingV2] list plans:', error);
    res.status(500).json({ error: error.message || '플랜 목록 조회 실패' });
  }
});

router.post('/plans', async (req, res) => {
  try {
    const plan = await createTradingPlan(req.user.userId, req.body || {});
    notifyV2MonitorRefresh();
    res.status(201).json({ plan });
  } catch (error) {
    console.error('[TradingV2] create plan:', error?.message || error);
    const status = error.status || 400;
    res.status(status).json({
      error: error.message || '플랜 생성 실패',
      code: error.code || undefined,
    });
  }
});

router.get('/plans/:id', async (req, res) => {
  try {
    const plan = await getTradingPlanById(req.user.userId, req.params.id);
    if (!plan) return res.status(404).json({ error: '플랜을 찾을 수 없습니다.' });
    res.json({ plan });
  } catch (error) {
    res.status(400).json({ error: error.message || '플랜 조회 실패' });
  }
});

router.put('/plans/:id', async (req, res) => {
  try {
    const plan = await updateTradingPlan(req.user.userId, req.params.id, req.body || {});
    if (!plan) return res.status(404).json({ error: '플랜을 찾을 수 없습니다.' });
    notifyV2MonitorRefresh();
    res.json({ plan });
  } catch (error) {
    console.error('[TradingV2] update plan:', error);
    const status = error.status || 400;
    res.status(status).json({
      error: error.message || '플랜 수정 실패',
      code: error.code || undefined,
    });
  }
});

router.delete('/plans/:id', async (req, res) => {
  try {
    const ok = await deleteTradingPlan(req.user.userId, req.params.id);
    if (!ok) return res.status(404).json({ error: '플랜을 찾을 수 없습니다.' });
    notifyV2MonitorRefresh();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || '플랜 삭제 실패' });
  }
});

router.post('/plans/:id/cycles', async (req, res) => {
  try {
    const plan = await openNewCycle(req.user.userId, req.params.id);
    res.json({ plan });
  } catch (error) {
    res.status(400).json({ error: error.message || '사이클 생성 실패' });
  }
});

router.post('/plans/:id/orders', async (req, res) => {
  try {
    const order = await createTradingOrder(req.user.userId, req.params.id, req.body || {});
    res.status(201).json({ order });
  } catch (error) {
    res.status(400).json({ error: error.message || '주문 기록 실패' });
  }
});

router.post('/plans/:planId/orders/:orderId/fills', async (req, res) => {
  try {
    const fill = await createTradingFill(
      req.user.userId,
      req.params.planId,
      req.params.orderId,
      req.body || {}
    );
    res.status(201).json({ fill });
  } catch (error) {
    res.status(400).json({ error: error.message || '체결 기록 실패' });
  }
});

module.exports = router;

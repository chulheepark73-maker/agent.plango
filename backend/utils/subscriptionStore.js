/**
 * 구독 상태 — 원본은 중앙 서버(GET /api/agent/owner 의 subscription).
 * 로컬은 한도 검사와 만료 시 자동매매 OFF 만 담당.
 */
const pool = require('./tradingDb');
const { isOwner, isRegistered, loadAgentIdentity } = require('./agentIdentity');

const FREE_SUMMARY = {
  subscription: 'N',
  subscriptionPlanCode: 'free',
  subscriptionPlanName: '무료',
  subscriptionCycle: null,
  subscriptionStartedAt: null,
  subscriptionExpiresAt: null,
  subscriptionNextPaymentDate: null,
  maxWatchlist: 1,
  maxAutoTrading: 1,
  planCode: 'free',
  unlimited: false,
};

const normalizeSummary = (sub) => {
  if (!sub) return { ...FREE_SUMMARY };
  const merged = { ...FREE_SUMMARY, ...sub };
  merged.subscription = merged.subscription === 'Y' ? 'Y' : 'N';
  merged.planCode = merged.planCode || merged.subscriptionPlanCode || 'free';
  merged.maxWatchlist = merged.maxWatchlist == null ? null : Number(merged.maxWatchlist);
  merged.maxAutoTrading = merged.maxAutoTrading == null ? null : Number(merged.maxAutoTrading);
  merged.unlimited = merged.maxWatchlist == null && merged.maxAutoTrading == null;
  return merged;
};

/**
 * 중앙 조회 → 실패 시 마지막으로 저장된 구독(agent.json) → 그것도 없으면 무료
 * 서버 등록 전에는 구독을 확인할 수 없으므로 무료
 */
const getSubscriptionSummaryForUser = async (userId) => {
  if (!isOwner(userId) || !isRegistered()) return { ...FREE_SUMMARY };
  try {
    const { getOwnerStatus } = require('../services/centralClient');
    const status = await getOwnerStatus();
    return normalizeSummary(status?.subscription);
  } catch (error) {
    const last = loadAgentIdentity().lastSubscription;
    if (last) return normalizeSummary(last);
    console.warn('[구독] 중앙 조회 실패, 무료 한도 적용:', error.message);
    return { ...FREE_SUMMARY };
  }
};

/** 현재 플랜 한도 (null = 무제한) */
const getUserPlanLimits = async (userId) => {
  const s = await getSubscriptionSummaryForUser(userId);
  return {
    maxWatchlist: s.maxWatchlist,
    maxAutoTrading: s.maxAutoTrading,
    planCode: s.planCode,
    unlimited: s.unlimited,
  };
};

/** 유료 구독 중이면 요약 객체, 아니면 null */
const getActiveSubscription = async (userId) => {
  const s = await getSubscriptionSummaryForUser(userId);
  if (s.subscription !== 'Y') return null;
  return {
    userId: String(userId),
    planCode: s.subscriptionPlanCode,
    planName: s.subscriptionPlanName,
    billingCycleLabel: s.subscriptionCycle,
    startedAt: s.subscriptionStartedAt,
    expiresAt: s.subscriptionExpiresAt,
    status: 'active',
  };
};

/** trading_plans status=active 인 종목(instrument) 수 */
const countUserTradingV2ActiveInstruments = async (userId, excludeInstrumentId = null) => {
  const uid = String(userId);
  const exclude =
    excludeInstrumentId != null && Number.isFinite(Number(excludeInstrumentId))
      ? Number(excludeInstrumentId)
      : null;

  try {
    const result = await pool.query(
      exclude
        ? `SELECT COUNT(DISTINCT instrument_id)::int AS cnt
           FROM trading_plans
           WHERE user_id = $1 AND status = 'active' AND instrument_id <> $2`
        : `SELECT COUNT(DISTINCT instrument_id)::int AS cnt
           FROM trading_plans
           WHERE user_id = $1 AND status = 'active'`,
      exclude ? [uid, exclude] : [uid]
    );
    return Number(result.rows[0]?.cnt || 0);
  } catch (e) {
    if (e.code === '42P01') return 0;
    throw e;
  }
};

/**
 * Trading V2 — 자동매매 ON(active) 가능 여부
 * free: maxAutoTrading(기본 1)개 종목만 active 허용
 */
const assertCanActivateTradingV2 = async (userId, { instrumentId } = {}) => {
  const limits = await getUserPlanLimits(userId);
  if (limits.maxAutoTrading == null) return limits;

  const count = await countUserTradingV2ActiveInstruments(userId, instrumentId);
  if (count >= limits.maxAutoTrading) {
    const err = new Error(
      `일반회원은 자동매매 ON 종목을 ${limits.maxAutoTrading}개까지 사용할 수 있습니다. 다른 종목 자동매매를 OFF 하거나 프리미엄을 구독해주세요.`
    );
    err.status = 403;
    err.code = 'PLAN_LIMIT_AUTO_ENABLED';
    err.limit = limits.maxAutoTrading;
    err.count = count;
    throw err;
  }
  return { ...limits, count };
};

/**
 * 구독 종료(취소/만료) 시 자동매매 전부 OFF — 데이터는 유지
 */
const disableTradingForUser = async (userId) => {
  const uid = String(userId);
  const result = {
    indicatorOff: false,
    tradingV2Paused: 0,
  };

  try {
    const ind = await pool.query(
      `UPDATE indicator_trading
       SET auto_trading_enabled = false, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND auto_trading_enabled = true`,
      [uid]
    );
    result.indicatorOff = (ind.rowCount || 0) > 0;
  } catch (e) {
    console.warn(`[구독] indicator_trading OFF 실패 user=${uid}:`, e.message);
  }

  try {
    const v2 = await pool.query(
      `UPDATE trading_plans
       SET status = 'paused', updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND status = 'active'`,
      [uid]
    );
    result.tradingV2Paused = v2.rowCount || 0;
    if (result.tradingV2Paused > 0) {
      try {
        const { stopV2BuyTrailingsForUser } = require('./autoTradingBuyTrailingStop');
        const { stopV2SellTrailingsForUser } = require('./autoTradingTrailingStop');
        stopV2BuyTrailingsForUser(uid);
        stopV2SellTrailingsForUser(uid);
        require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
      } catch (e) {
        console.warn(`[구독] V2 trailing 중지 실패 user=${uid}:`, e.message);
      }
    }
  } catch (e) {
    if (e.code !== '42P01') {
      console.warn(`[구독] trading_plans pause 실패 user=${uid}:`, e.message);
    }
  }

  return result;
};

module.exports = {
  FREE_SUMMARY,
  normalizeSummary,
  getSubscriptionSummaryForUser,
  getUserPlanLimits,
  getActiveSubscription,
  assertCanActivateTradingV2,
  countUserTradingV2ActiveInstruments,
  disableTradingForUser,
};

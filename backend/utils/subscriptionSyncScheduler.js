/**
 * 중앙 서버 구독/주인 정보 동기화
 * - 유료(Y) → 무료(N) 전환이 확인되면 자동매매 전부 OFF
 * - 마지막 구독 상태는 agent.json(lastSubscription)에 보관 → 재시작·중앙 장애 시에도 유지
 * - 중앙 연결 실패는 상태 변경으로 보지 않음
 */
const { getOwnerUserId, loadAgentIdentity, saveAgentIdentity, isRegistered } = require('./agentIdentity');
const { normalizeSummary, disableTradingForUser } = require('./subscriptionStore');

const SYNC_INTERVAL_MS = 10 * 60 * 1000;

const runSubscriptionSync = async (label = '') => {
  if (!isRegistered()) return { skipped: 'not-registered' };
  const tag = label ? ` (${label})` : '';
  const ownerId = getOwnerUserId();
  const { getOwnerStatus } = require('../services/centralClient');

  let status;
  try {
    status = await getOwnerStatus({ force: true });
  } catch (error) {
    console.warn(`[구독동기화]${tag} 중앙 조회 실패: ${error.message}`);
    return { skipped: 'central-error' };
  }

  if (status?.user) {
    try {
      const { upsertOwnerUser } = require('./userStore');
      await upsertOwnerUser({ ...status.user, id: ownerId });
      saveAgentIdentity({
        ownerUsername: status.user.username || null,
        ownerEmail: status.user.email || null,
      });
    } catch (error) {
      console.warn(`[구독동기화]${tag} 주인 정보 반영 실패: ${error.message}`);
    }
  }

  const sub = normalizeSummary(status?.subscription);
  const prev = loadAgentIdentity().lastSubscription;
  let tradingOff = null;
  if (prev?.subscription === 'Y' && sub.subscription === 'N') {
    tradingOff = await disableTradingForUser(ownerId);
    console.log(
      `[구독동기화]${tag} 구독 종료 → 자동매매 OFF user=${ownerId} ` +
        `indicatorOff=${tradingOff.indicatorOff}, v2Paused=${tradingOff.tradingV2Paused || 0}`
    );
  }
  saveAgentIdentity({ lastSubscription: sub, lastSyncedAt: new Date().toISOString() });
  return { subscription: sub.subscription, tradingOff };
};

function startScheduler() {
  runSubscriptionSync('startup').catch((e) => console.error('[구독동기화] 오류:', e.message));
  setInterval(() => {
    runSubscriptionSync().catch((e) => console.error('[구독동기화] 오류:', e.message));
  }, SYNC_INTERVAL_MS);
  console.log('[구독동기화 스케줄러] 시작됨 (10분 간격)');
}

module.exports = { runSubscriptionSync, startScheduler };

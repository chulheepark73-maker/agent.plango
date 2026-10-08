/**
 * 회원 정지·탈퇴 잠금 (agent.json accountBlocked)
 * - 감지: 구독 동기화(user.status !== 'active'), 로그인 시 중앙 ACCOUNT_BLOCKED
 * - 잠금: 자동매매 OFF(지표 auto, V2 플랜 paused), 키움 WS 감시 해제, API·화면 WS 차단, 텔레그램 알림
 *   키움에 이미 접수된 미체결 주문과 보유 종목은 건드리지 않는다.
 * - 해제: 엔진은 다시 대상을 잡지만 꺼진 자동매매는 사용자가 직접 켠다.
 */
const { loadAgentIdentity, saveAgentIdentity, getOwnerUserId } = require('./agentIdentity');

const LOG = '[계정정지]';

const BLOCK_MESSAGES = {
  suspended: '이용이 정지된 계정입니다. 고객센터에 문의해주세요.',
  withdrawn: '탈퇴 처리된 계정입니다.',
};

const getAccountBlock = () => loadAgentIdentity().accountBlocked || null;

const isAccountBlocked = () => !!getAccountBlock();

const accountBlockMessage = () => {
  const b = getAccountBlock();
  return b?.message || BLOCK_MESSAGES[b?.status] || '사용할 수 없는 계정입니다.';
};

const refreshKiwoomMonitors = () => {
  for (const load of [
    () => require('../services/autoTradingWsMonitor_v2'),
    () => require('../services/indicatorWsMonitor'),
  ]) {
    try {
      load().requestSubscribeRefreshSoon();
    } catch {
      /* 모니터 미기동 */
    }
  }
};

const notifyOwner = async (userId, text) => {
  try {
    const { sendTelegramToUserById } = require('../services/telegramService');
    await sendTelegramToUserById(userId, text);
  } catch (e) {
    console.warn(`${LOG} 텔레그램 알림 실패: ${e.message}`);
  }
};

/**
 * @param {{ status?: string, message?: string, source: string }} p
 * @returns {Promise<boolean>} 이번 호출로 새로 잠겼으면 true
 */
const applyAccountBlock = async ({ status, message, source }) => {
  const ownerId = getOwnerUserId();
  if (!ownerId) return false;

  const prev = getAccountBlock();
  const nextStatus = status || prev?.status || 'blocked';
  saveAgentIdentity({
    accountBlocked: {
      status: nextStatus,
      message: message || BLOCK_MESSAGES[nextStatus] || prev?.message || BLOCK_MESSAGES.suspended,
      since: prev?.since || new Date().toISOString(),
    },
  });
  if (prev) return false;

  let tradingOff = {};
  try {
    const { disableTradingForUser } = require('./subscriptionStore');
    tradingOff = await disableTradingForUser(ownerId);
  } catch (e) {
    console.error(`${LOG} 자동매매 OFF 실패 user=${ownerId}: ${e.message}`);
  }
  console.log(
    `${LOG} 자동매매 중지 user=${ownerId} status=${nextStatus} source=${source} ` +
      `indicatorOff=${!!tradingOff.indicatorOff} v2Paused=${tradingOff.tradingV2Paused || 0}`
  );

  refreshKiwoomMonitors();
  try {
    require('../services/watchlistPriceWsHub').disconnectAllClients(4403, 'ACCOUNT_BLOCKED');
  } catch {
    /* hub 미기동 */
  }

  await notifyOwner(
    ownerId,
    '[PlanGo] 계정이 이용 정지되어 이 서버의 자동매매를 중지했습니다.\n' +
      '접수된 미체결 주문과 보유 종목은 그대로 유지됩니다. 고객센터에 문의해주세요.'
  );
  return true;
};

/** @returns {Promise<boolean>} 잠겨 있다가 이번 호출로 풀렸으면 true */
const clearAccountBlock = async ({ source }) => {
  const prev = getAccountBlock();
  if (!prev) return false;
  saveAgentIdentity({ accountBlocked: null });

  const ownerId = getOwnerUserId();
  console.log(`${LOG} 해제 user=${ownerId} source=${source} (정지 시각 ${prev.since})`);
  refreshKiwoomMonitors();

  if (ownerId) {
    await notifyOwner(
      ownerId,
      '[PlanGo] 계정 이용 정지가 해제되었습니다.\n' +
        '정지 때 꺼진 자동매매는 자동으로 다시 켜지지 않으니 화면에서 직접 켜주세요.'
    );
  }
  return true;
};

module.exports = {
  getAccountBlock,
  isAccountBlocked,
  accountBlockMessage,
  applyAccountBlock,
  clearAccountBlock,
  refreshKiwoomMonitors,
};

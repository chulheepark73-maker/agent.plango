/**
 * 텔레그램 알림 — 중앙 서버 중계 (POST /api/agent/notify)
 * 봇 토큰과 chat_id 는 중앙에만 있다.
 */
const { isOwner } = require('../utils/agentIdentity');

async function sendTelegramToUserById(userId, text) {
  if (!isOwner(userId)) {
    console.warn('[텔레그램] 전송 스킵: 에이전트 주인이 아님', { userId: String(userId) });
    return;
  }
  try {
    const { notify } = require('./centralClient');
    const data = await notify(String(text));
    if (data && data.ok === false) {
      console.warn('[텔레그램] 중앙 중계 스킵:', data.reason || data.error || data);
    }
    return data;
  } catch (e) {
    console.warn('[텔레그램] 중앙 중계 실패:', { userId: String(userId), status: e.status, message: e.message });
  }
}

module.exports = {
  sendTelegramToUserById,
};

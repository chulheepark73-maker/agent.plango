/**
 * WS(00) 연결 시 kt00009 REST 체결 백업 호출 최소화
 */

const REST_BACKUP_FIRST_MS = 2 * 60 * 1000;
const REST_BACKUP_INTERVAL_MS = 5 * 60 * 1000;

function isWsFillPrimary(userId) {
  try {
    // auto / auto_v2 / hub 공유 클라이언트 — 로그인되어 있으면 WS 체결 우선
    const { getConnectedClient } = require('../services/kiwoomUserWsRegistry');
    return !!getConnectedClient(userId);
  } catch {
    return false;
  }
}

/**
 * @param {{ startTime: number, lastRestPollAt?: number, userId: string }} state
 * @param {{ force?: boolean }} [opts] force=true — 복구 직후 1회 등
 */
function shouldRunRestFillPoll(state, opts = {}) {
  if (opts.force) return true;
  if (!state?.startTime) return true;

  const now = Date.now();
  const elapsed = now - state.startTime;
  const sinceLast = state.lastRestPollAt ? now - state.lastRestPollAt : elapsed;

  if (isWsFillPrimary(state.userId)) {
    // WS 우선: 첫 백업 2분 후, 이후 5분 간격만
    if (elapsed < REST_BACKUP_FIRST_MS) return false;
    return sinceLast >= REST_BACKUP_INTERVAL_MS;
  }

  // WS 미연결: 2분 후부터 5분 간격
  if (elapsed < REST_BACKUP_FIRST_MS) return false;
  return sinceLast >= REST_BACKUP_INTERVAL_MS;
}

function markRestFillPolled(state) {
  if (state) state.lastRestPollAt = Date.now();
}

module.exports = {
  REST_BACKUP_FIRST_MS,
  REST_BACKUP_INTERVAL_MS,
  isWsFillPrimary,
  shouldRunRestFillPoll,
  markRestFillPolled,
};

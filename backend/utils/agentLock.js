/**
 * 서버 미등록·등록 해제 잠금
 * - 미등록(agentId/agentSecret 없음)이면 매매 엔진·API 를 막는다. 플랜 상태는 그대로 두므로 등록하면 바로 재개된다.
 * - 중앙이 에이전트 자격을 거부(401: AGENT_REVOKED / AGENT_UNAUTHORIZED)하면 키를 지워 미등록으로 돌린다.
 */
const { loadAgentIdentity, saveAgentIdentity, isRegistered } = require('./agentIdentity');
const { isAccountBlocked, refreshKiwoomMonitors } = require('./accountBlock');

const LOG = '[서버등록]';

const NOT_REGISTERED_MESSAGE = '서버 등록 후 이용할 수 있습니다. 서버 등록 메뉴에서 이 서버를 등록하세요.';

/** 계정 정지 또는 서버 미등록 — 매매 엔진을 돌리지 않는다 */
const isAgentLocked = () => isAccountBlocked() || !isRegistered();

const getAgentRevoked = () => loadAgentIdentity().agentRevoked || null;

const revokedMessage = ({ code, reason }) => {
  if (code === 'AGENT_REVOKED' && /교체/.test(reason || '')) {
    return '같은 계정으로 다른 서버가 등록되어 이 서버의 등록이 해제되었습니다.';
  }
  if (code === 'AGENT_REVOKED') return '관리자에 의해 이 서버의 등록이 해제되었습니다.';
  return '서버 인증에 실패해 이 서버의 등록이 해제되었습니다.';
};

const disconnectPriceClients = () => {
  try {
    require('../services/watchlistPriceWsHub').disconnectAllClients(4409, 'AGENT_NOT_REGISTERED');
  } catch {
    /* hub 미기동 */
  }
};

/** 중앙이 에이전트 자격을 거부했을 때 (중앙 /api/agent/* 401) */
const handleAgentRevoked = ({ code, reason, revokedAt, source }) => {
  if (!isRegistered()) return false;
  const prev = loadAgentIdentity();
  const finalCode = code || 'AGENT_UNAUTHORIZED';
  const message = revokedMessage({ code: finalCode, reason });
  saveAgentIdentity({
    agentId: null,
    agentSecret: null,
    registeredAt: null,
    agentRevoked: {
      at: revokedAt || new Date().toISOString(),
      code: finalCode,
      reason: reason || null,
      message,
      agentId: prev.agentId || null,
    },
  });
  console.log(
    `${LOG} 등록 해제 감지 agentId=${prev.agentId} code=${finalCode} reason=${reason || '-'} source=${source} — 매매 엔진 중지`
  );
  refreshKiwoomMonitors();
  disconnectPriceClients();
  return true;
};

/** 서버 등록 성공 직후 — 해제 기록을 지우고 엔진을 바로 다시 잡는다 */
const onAgentRegistered = () => {
  saveAgentIdentity({ agentRevoked: null });
  refreshKiwoomMonitors();
};

module.exports = {
  NOT_REGISTERED_MESSAGE,
  isAgentLocked,
  getAgentRevoked,
  handleAgentRevoked,
  onAgentRegistered,
};

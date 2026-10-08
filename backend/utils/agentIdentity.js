/**
 * 에이전트 사용자·서버 등록 정보 (backend/data/agent.json)
 * - 사용자: 첫 로그인 계정 { ownerUserId, ownerUsername, ownerEmail, ownerSince }
 * - 서버 등록: '서버 등록' 메뉴에서 중앙 발급 { agentId, agentSecret, registeredAt }
 * - 등록 해제: 중앙이 폐기·인증 실패를 알리면 키를 지우고 { agentRevoked: { at, code, reason, message } }
 * - { lastSubscription, lastSyncedAt, accountBlocked }
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./appPaths');

const AGENT_FILE = process.env.AGENT_DATA_FILE
  ? path.resolve(process.env.AGENT_DATA_FILE)
  : path.join(DATA_DIR, 'agent.json');

let cache = null;

const loadAgentIdentity = () => {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
};

const saveAgentIdentity = (patch) => {
  const next = { ...loadAgentIdentity(), ...patch };
  fs.mkdirSync(path.dirname(AGENT_FILE), { recursive: true });
  fs.writeFileSync(AGENT_FILE, JSON.stringify(next, null, 2), 'utf8');
  cache = next;
  return next;
};

const clearAgentIdentity = () => {
  try {
    fs.unlinkSync(AGENT_FILE);
  } catch {
    /* 없음 */
  }
  cache = {};
};

const getOwnerUserId = () => {
  const id = loadAgentIdentity().ownerUserId;
  return id != null && id !== '' ? String(id) : null;
};

const hasOwner = () => !!getOwnerUserId();

/** 중앙 서버에 에이전트 키가 등록되어 있는지 */
const isRegistered = () => {
  const a = loadAgentIdentity();
  return !!(a.ownerUserId && a.agentId && a.agentSecret);
};

const isOwner = (userId) => {
  const owner = getOwnerUserId();
  return !!owner && userId != null && String(userId) === owner;
};

module.exports = {
  AGENT_FILE,
  loadAgentIdentity,
  saveAgentIdentity,
  clearAgentIdentity,
  getOwnerUserId,
  hasOwner,
  isRegistered,
  isOwner,
};

/**
 * 에이전트 페어링 정보 (backend/data/agent.json)
 * { ownerUserId, ownerUsername, ownerEmail, agentId, agentSecret, pairedAt, lastSubscription }
 */
const fs = require('fs');
const path = require('path');

const AGENT_FILE = process.env.AGENT_DATA_FILE
  ? path.resolve(process.env.AGENT_DATA_FILE)
  : path.join(__dirname, '..', 'data', 'agent.json');

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

const isPaired = () => {
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
  isPaired,
  isOwner,
};

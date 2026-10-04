/**
 * 모의 중앙 서버 (개발/테스트용) — services/centralClient.js 계약 구현
 *
 *   node scripts/mock_central_server.js
 *   에이전트 .env: CENTRAL_API_URL=http://localhost:4100
 *
 * 환경변수: MOCK_CENTRAL_PORT(4100), MOCK_USER_ID(1), MOCK_USER_EMAIL, MOCK_USER_PASSWORD, MOCK_USER_NAME
 * 테스트용 조작: POST /mock/subscription { subscription: 'Y'|'N' }, GET /mock/notifications
 */
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.MOCK_CENTRAL_PORT || 4100);
const STATE_FILE = path.join(__dirname, '..', 'data', 'mock_central_state.json');

const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const state = loadState();
if (!state.publicKey || !state.privateKey) {
  Object.assign(
    state,
    crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
  );
}
const { publicKey, privateKey } = state;
const saveState = () => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ publicKey, privateKey, agents: Object.fromEntries(agents) }, null, 2)
  );
};

const users = [
  {
    id: String(process.env.MOCK_USER_ID || '1'),
    email: process.env.MOCK_USER_EMAIL || 'owner@plango.test',
    password: process.env.MOCK_USER_PASSWORD || 'test1234',
    username: process.env.MOCK_USER_NAME || 'owner',
    phoneNumber: null,
  },
  { id: '2', email: 'other@plango.test', password: 'test1234', username: 'other', phoneNumber: null },
];

const PREMIUM = {
  subscription: 'Y',
  subscriptionPlanCode: 'premium_month',
  subscriptionPlanName: '프리미엄',
  subscriptionCycle: '월간',
  subscriptionStartedAt: new Date().toISOString(),
  subscriptionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  subscriptionNextPaymentDate: new Date(Date.now() + 30 * 86400000).toISOString(),
  maxWatchlist: null,
  maxAutoTrading: null,
};
const FREE = {
  subscription: 'N',
  subscriptionPlanCode: 'free',
  subscriptionPlanName: '무료',
  subscriptionCycle: null,
  subscriptionStartedAt: null,
  subscriptionExpiresAt: null,
  subscriptionNextPaymentDate: null,
  maxWatchlist: 1,
  maxAutoTrading: 1,
};

const subscriptions = new Map(users.map((u) => [u.id, u.id === users[0].id ? PREMIUM : FREE]));
const agents = new Map(Object.entries(state.agents || {})); // agentId → { secret, userId }
const revoked = new Set();
const telegram = new Map(); // userId → { chatId, pending }
const notifications = [];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[mock-central] ${req.method} ${req.path}`);
  next();
});

const requireUser = (req, res, next) => {
  const token = (req.headers.authorization || '').split(' ')[1];
  try {
    if (!token || revoked.has(token)) throw new Error('revoked');
    req.claims = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
    req.token = token;
    next();
  } catch {
    res.status(401).json({ error: '인증이 필요합니다.' });
  }
};

const requireAgent = (req, res, next) => {
  const a = agents.get(req.headers['x-agent-id']);
  if (!a || a.secret !== req.headers['x-agent-secret']) {
    return res.status(401).json({ error: '에이전트 인증 실패' });
  }
  req.agentUserId = a.userId;
  next();
};

app.get('/api/agent/public-key', (_req, res) => res.json({ alg: 'RS256', publicKey }));

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = users.find((x) => x.email === email && x.password === password);
  if (!u) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  const token = jwt.sign({ userId: u.id, username: u.username, email: u.email }, privateKey, {
    algorithm: 'RS256',
    expiresIn: '24h',
  });
  res.json({ token, user: { id: u.id, email: u.email, username: u.username } });
});

app.post('/api/auth/logout', requireUser, (req, res) => {
  revoked.add(req.token);
  res.json({ message: '로그아웃되었습니다.' });
});

app.post('/api/auth/verify-password', requireUser, (req, res) => {
  const u = users.find((x) => x.id === String(req.claims.userId));
  res.json({ verified: !!u && u.password === req.body?.password });
});

app.post('/api/agent/register', requireUser, (req, res) => {
  const agentId = `agt_${crypto.randomBytes(6).toString('hex')}`;
  const agentSecret = crypto.randomBytes(24).toString('hex');
  agents.set(agentId, { secret: agentSecret, userId: String(req.claims.userId), name: req.body?.name });
  saveState();
  res.json({ agentId, agentSecret });
});

app.get('/api/agent/owner', requireAgent, (req, res) => {
  const u = users.find((x) => x.id === req.agentUserId);
  const t = telegram.get(req.agentUserId) || {};
  res.json({
    user: { id: u.id, email: u.email, username: u.username, phoneNumber: u.phoneNumber },
    subscription: subscriptions.get(u.id) || FREE,
    telegram: { hasTelegramChatId: !!t.chatId, telegramLinkPending: !!t.pending, telegramDeepLinkReady: true },
  });
});

app.post('/api/agent/notify', requireAgent, (req, res) => {
  notifications.push({ userId: req.agentUserId, text: req.body?.text, at: new Date().toISOString() });
  res.json({ ok: true });
});

app.post('/api/agent/telegram/deep-link', requireAgent, (req, res) => {
  telegram.set(req.agentUserId, { ...(telegram.get(req.agentUserId) || {}), pending: true });
  const payload = crypto.randomBytes(12).toString('hex');
  res.json({
    botUrl: `https://t.me/PlanGo_mock_bot?start=${payload}`,
    linkExpiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
    telegramLinkPending: true,
  });
});

app.delete('/api/agent/telegram/link', requireAgent, (req, res) => {
  telegram.delete(req.agentUserId);
  res.json({ message: '연결이 해제되었습니다.' });
});

app.post('/mock/subscription', (req, res) => {
  const userId = String(req.body?.userId || users[0].id);
  subscriptions.set(userId, req.body?.subscription === 'Y' ? PREMIUM : FREE);
  res.json({ userId, subscription: subscriptions.get(userId) });
});

app.get('/mock/notifications', (_req, res) => res.json({ notifications }));

saveState();
app.listen(PORT, () => {
  console.log(`[mock-central] http://localhost:${PORT} (login: ${users[0].email} / ${users[0].password})`);
});

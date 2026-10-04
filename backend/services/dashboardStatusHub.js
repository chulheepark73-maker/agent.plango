/**
 * Dashboard Trailing / 주문번호 Status WebSocket 푸시
 * watchlistPriceWsHub 클라이언트 중 subscribe_dashboard 한 소켓에만 전송
 */

const { WebSocket } = require('ws');
const { buildDashboardStatusSnapshot } = require('../utils/dashboardStatusBuilders');

/** @type {Map<string, Set<import('ws')>>} userId → dashboard-subscribed sockets */
const dashboardClients = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const pushTimers = new Map();

const PUSH_INTERVAL_MS = 1000;

function addDashboardClient(userId, ws) {
  const uid = String(userId);
  let set = dashboardClients.get(uid);
  if (!set) {
    set = new Set();
    dashboardClients.set(uid, set);
  }
  set.add(ws);
  ensurePushTimer(uid);
  pushNow(uid).catch(() => {});
}

function removeDashboardClient(userId, ws) {
  const uid = String(userId);
  const set = dashboardClients.get(uid);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    dashboardClients.delete(uid);
    stopPushTimer(uid);
  }
}

function ensurePushTimer(userId) {
  const uid = String(userId);
  if (pushTimers.has(uid)) return;
  const timer = setInterval(() => {
    pushNow(uid).catch((err) => {
      console.error(`[DashboardStatusWS][${uid}] 푸시 오류:`, err.message);
    });
  }, PUSH_INTERVAL_MS);
  pushTimers.set(uid, timer);
}

function stopPushTimer(userId) {
  const uid = String(userId);
  const timer = pushTimers.get(uid);
  if (timer) {
    clearInterval(timer);
    pushTimers.delete(uid);
  }
}

async function pushNow(userId) {
  const uid = String(userId);
  const set = dashboardClients.get(uid);
  if (!set || set.size === 0) return;

  const snapshot = await buildDashboardStatusSnapshot(uid);
  const raw = JSON.stringify(snapshot);
  for (const ws of [...set]) {
    if (ws.readyState !== WebSocket.OPEN) {
      set.delete(ws);
      continue;
    }
    try {
      ws.send(raw);
    } catch {
      set.delete(ws);
    }
  }
  if (set.size === 0) {
    dashboardClients.delete(uid);
    stopPushTimer(uid);
  }
}

/** 체결/주문접수 등 즉시 반영 */
function notifyDashboardStatus(userId) {
  const uid = String(userId);
  if (!dashboardClients.has(uid)) return;
  pushNow(uid).catch(() => {});
}

module.exports = {
  addDashboardClient,
  removeDashboardClient,
  notifyDashboardStatus,
  pushNow,
};

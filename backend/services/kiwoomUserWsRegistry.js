/**
 * 키움 WebSocket 유저별 단일 연결 레지스트리
 *
 * 키움은 App Key당 WS 1개만 허용하므로(중복 접속 시 기존 세션 종료),
 * 자동매매 감시(auto)와 화면 시세 중계(hub)가 하나의 클라이언트를 공유한다.
 *
 * - 구독자(subscriber)는 key로 구분하며, 종목은 우선순위와 함께 등록한다.
 * - REG는 전체 구독자 종목의 합집합을 우선순위 오름차순으로 정렬해 전송한다.
 * - 클라이언트 destroy는 마지막 구독자가 release할 때만 수행한다.
 */

const { KiwoomRealtimeClient } = require('./kiwoomRealtimeClient');
const { getKiwoomInfo } = require('../utils/kiwoomUtils');

/** 키움 REG 0B 등록 상한 */
const MAX_REG_SYMBOLS = 100;

/** 우선순위 — 값이 작을수록 먼저 등록 */
const PRIORITY = {
  POSITION: 0, // 보유 포지션·미체결 주문 (매도 감시 필수)
  TRACKING: 1, // 지표 트래킹·트레일링 감시
  DISPLAY: 2, // 관심종목·대시보드 화면 표시용
};

/**
 * @typedef {object} Subscriber
 * @property {Map<string, number>} codes 정규화 전 종목코드 → priority
 * @property {(tick: object) => void} [onTick]
 * @property {(evt: object) => void} [onOrder]
 * @property {(evt: object) => void} [onCondition]
 * @property {(info: object) => void} [onStatus]
 */

/**
 * @typedef {object} Entry
 * @property {KiwoomRealtimeClient} client
 * @property {Map<string, Subscriber>} subscribers
 * @property {number} lastTruncatedCount 직전 REG에서 상한 초과로 잘린 종목 수
 */

/** @type {Map<string, Entry>} */
const entries = new Map();

const uidOf = (userId) => String(userId);

/** 등록된 모든 구독자에게 콜백 전달 */
const fanout = (entry, method, arg) => {
  for (const [key, sub] of entry.subscribers) {
    const fn = sub[method];
    if (typeof fn !== 'function') continue;
    try {
      fn(arg);
    } catch (err) {
      console.error(`[키움WS레지스트리] ${key}.${method} 오류:`, err.message);
    }
  }
};

/** onOrder 구독자가 하나라도 있으면 주문체결(00) 수신 ON */
function syncOrderFillsEnabled(uid) {
  const entry = entries.get(uidOf(uid));
  if (!entry?.client) return;
  let want = false;
  for (const sub of entry.subscribers.values()) {
    if (typeof sub.onOrder === 'function') {
      want = true;
      break;
    }
  }
  entry.client.setOrderFillsEnabled(want);
}

const createEntry = (uid) => {
  /** @type {Entry} */
  const entry = {
    client: null,
    subscribers: new Map(),
    lastTruncatedCount: 0,
  };

  entry.client = new KiwoomRealtimeClient({
    userId: uid,
    getAccessToken: async () => {
      const info = await getKiwoomInfo(uid);
      return info?.accessToken || null;
    },
    onTick: (tick) => fanout(entry, 'onTick', tick),
    onOrder: (evt) => fanout(entry, 'onOrder', evt),
    onCondition: (evt) => fanout(entry, 'onCondition', evt),
    onStatus: (info) => fanout(entry, 'onStatus', info),
  });

  entries.set(uid, entry);
  return entry;
};

/**
 * 구독자 등록. 이미 연결된 클라이언트가 있으면 재사용한다.
 * @param {string|number} userId
 * @param {string} key 'auto' | 'hub' 등 구독자 식별자
 * @param {Omit<Subscriber, 'codes'>} handlers
 * @returns {KiwoomRealtimeClient}
 */
function acquire(userId, key, handlers = {}) {
  const uid = uidOf(userId);
  const entry = entries.get(uid) || createEntry(uid);

  const prev = entry.subscribers.get(key);
  entry.subscribers.set(key, {
    codes: prev?.codes || new Map(),
    onTick: handlers.onTick,
    onOrder: handlers.onOrder,
    onCondition: handlers.onCondition,
    onStatus: handlers.onStatus,
  });

  syncOrderFillsEnabled(uid);
  return entry.client;
}

/**
 * 구독자별 종목 목록 교체 후 합집합으로 REG 갱신
 * @param {string|number} userId
 * @param {string} key
 * @param {Array<string|{code: string, priority?: number}>} codes 이미 _NX 접미사가 반영된 코드
 * @param {number} [defaultPriority]
 */
function setSymbols(userId, key, codes, defaultPriority = PRIORITY.DISPLAY) {
  const uid = uidOf(userId);
  const entry = entries.get(uid);
  if (!entry) return;

  const sub = entry.subscribers.get(key);
  if (!sub) return;

  const next = new Map();
  for (const item of codes || []) {
    const code = typeof item === 'string' ? item : item?.code;
    if (!code) continue;
    const priority = typeof item === 'object' && item.priority != null ? item.priority : defaultPriority;
    const prev = next.get(code);
    next.set(code, prev == null ? priority : Math.min(prev, priority));
  }
  sub.codes = next;

  syncSymbols(uid);
}

/** 전체 구독자 종목 합집합 → 우선순위 정렬 → client.setSymbols() */
function syncSymbols(uid) {
  const entry = entries.get(uid);
  if (!entry) return;

  /** @type {Map<string, number>} code → 최우선(최솟값) priority */
  const merged = new Map();
  for (const sub of entry.subscribers.values()) {
    for (const [code, priority] of sub.codes) {
      const prev = merged.get(code);
      if (prev == null || priority < prev) merged.set(code, priority);
    }
  }

  const ordered = [...merged.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([code]) => code);

  const truncated = Math.max(0, ordered.length - MAX_REG_SYMBOLS);
  if (truncated > 0 && truncated !== entry.lastTruncatedCount) {
    console.warn(
      `[키움WS레지스트리][${uid}] REG 상한(${MAX_REG_SYMBOLS}) 초과 — ${truncated}종목 미등록 ` +
        `(총 ${ordered.length}, 우선순위 낮은 종목부터 제외)`
    );
  }
  entry.lastTruncatedCount = truncated;

  entry.client.setSymbols(ordered.slice(0, MAX_REG_SYMBOLS));
}

/**
 * 구독자 해제. 남은 구독자가 없을 때만 실제 연결을 끊는다.
 * @param {string|number} userId
 * @param {string} key
 */
function release(userId, key) {
  const uid = uidOf(userId);
  const entry = entries.get(uid);
  if (!entry) return;

  entry.subscribers.delete(key);

  if (entry.subscribers.size === 0) {
    entry.client.destroy();
    entries.delete(uid);
    return;
  }

  syncOrderFillsEnabled(uid);
  syncSymbols(uid);
}

/**
 * 조건검색·주문체결 등 클라이언트 직접 제어용
 * @returns {KiwoomRealtimeClient|null}
 */
function getClient(userId) {
  return entries.get(uidOf(userId))?.client || null;
}

/**
 * 로그인까지 완료된 클라이언트만 반환
 * @returns {KiwoomRealtimeClient|null}
 */
function getConnectedClient(userId) {
  const client = getClient(userId);
  return client?.isConnected?.() ? client : null;
}

function hasSubscriber(userId, key) {
  return !!entries.get(uidOf(userId))?.subscribers.has(key);
}

/** 투자 모드·토큰 변경 시: 소켓을 닫으면 재연결 때 새 주소·토큰으로 다시 LOGIN 한다 */
function reconnectAll() {
  for (const entry of entries.values()) {
    entry.client.softDisconnect();
  }
}

module.exports = {
  PRIORITY,
  MAX_REG_SYMBOLS,
  acquire,
  setSymbols,
  release,
  getClient,
  getConnectedClient,
  hasSubscriber,
  syncOrderFillsEnabled,
  reconnectAll,
};

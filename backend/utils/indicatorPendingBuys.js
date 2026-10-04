/**
 * 지표기반매매 — 시세 대기 매수 큐
 *
 * 조건검색에 편입됐지만 실시간 시세가 아직 없어 매수를 못 낸 종목을 담아둔다.
 * 해당 종목의 첫 틱이 들어오는 순간 indicatorWsMonitor가 꺼내서 매수를 재시도한다.
 */

/** @type {Map<string, Map<string, {stockCode:string, stockName:string, seq:string, addedAt:number}>>} */
const pendingByUser = new Map();

/** 조건 이탈·프룬이 모두 실패해도 무한정 남지 않도록 하는 안전장치 */
const MAX_AGE_MS = 4 * 60 * 60 * 1000;

const getMap = (userId, create = false) => {
  const uid = String(userId);
  let m = pendingByUser.get(uid);
  if (!m && create) {
    m = new Map();
    pendingByUser.set(uid, m);
  }
  return m || null;
};

const addPendingBuy = (userId, code6, { stockCode, stockName, seq } = {}) => {
  const code = String(code6 || '').substring(0, 6);
  if (!code) return false;
  const m = getMap(userId, true);
  if (m.has(code)) return false;
  m.set(code, {
    stockCode: stockCode || code,
    stockName: stockName || '',
    seq: String(seq ?? ''),
    addedAt: Date.now(),
  });
  console.log(`[시세대기매수][${userId}] 등록: ${code}${stockName ? ` ${stockName}` : ''} seq=${seq || '-'}`);
  return true;
};

const hasPendingBuy = (userId, code6) => {
  const m = getMap(userId);
  return !!m?.has(String(code6 || '').substring(0, 6));
};

/** 꺼내면서 제거 — 연속 틱에 중복 주문이 나가지 않도록 반드시 이 함수로 접근한다 */
const takePendingBuy = (userId, code6) => {
  const m = getMap(userId);
  if (!m) return null;
  const code = String(code6 || '').substring(0, 6);
  const entry = m.get(code);
  if (!entry) return null;
  m.delete(code);
  if (m.size === 0) pendingByUser.delete(String(userId));
  if (Date.now() - entry.addedAt > MAX_AGE_MS) return null;
  return entry;
};

const removePendingBuy = (userId, code6) => {
  const m = getMap(userId);
  if (!m) return;
  m.delete(String(code6 || '').substring(0, 6));
  if (m.size === 0) pendingByUser.delete(String(userId));
};

/** 트래킹 목록에 없는 종목(조건 이탈)과 만료 항목 정리 */
const prunePendingBuys = (userId, keepCodes) => {
  const m = getMap(userId);
  if (!m) return 0;
  const keep = keepCodes instanceof Set ? keepCodes : new Set(keepCodes || []);
  const now = Date.now();
  let removed = 0;
  for (const [code, entry] of [...m.entries()]) {
    if (!keep.has(code) || now - entry.addedAt > MAX_AGE_MS) {
      m.delete(code);
      removed += 1;
    }
  }
  if (m.size === 0) pendingByUser.delete(String(userId));
  return removed;
};

const clearPendingBuys = (userId) => {
  pendingByUser.delete(String(userId));
};

const listPendingBuys = (userId) => {
  const m = getMap(userId);
  return m ? [...m.keys()] : [];
};

module.exports = {
  addPendingBuy,
  hasPendingBuy,
  takePendingBuy,
  removePendingBuy,
  prunePendingBuys,
  clearPendingBuys,
  listPendingBuys,
};

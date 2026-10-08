/**
 * 분할매매 체결 로트 — 체결 시각순으로 매수 로트를 쌓고 매도 체결이 로트를 소진
 *
 * 차수 번호별 누적 합(매수 합 - 매도 합)은 매수/매도 차수가 한 번이라도 어긋나면
 * 이미 끝난 거래가 보유로 되살아나고 이후 같은 차수 매수와 섞인다.
 * 로트 방식은 매도 체결 시점에 존재하던 매수만 소진하므로 완료된 거래는 다시 열리지 않는다.
 *
 * 매도 소진 순서: 같은 차수 로트(먼저 산 것부터) → 다른 차수 중 높은 차수부터
 */

const toNum = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

const toTime = (v) => {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
};

const resolveOrderStageNo = (plan, order) => {
  const sn = Number(order?.stageNo);
  if (Number.isInteger(sn) && sn > 0) return sn;
  if (order?.stageId != null) {
    const st = (plan?.stages || []).find((s) => Number(s.id) === Number(order.stageId));
    const n = Number(st?.stage);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
};

const ordersForCycle = (plan, cycleId) => {
  const all = plan?.orders || [];
  if (cycleId == null) return all;
  return all.filter((o) => {
    if (o.cycleId != null) return Number(o.cycleId) === Number(cycleId);
    if (o.stageId != null) {
      const st = (plan.stages || []).find((s) => Number(s.id) === Number(o.stageId));
      if (st) return Number(st.cycleId) === Number(cycleId);
    }
    return true;
  });
};

/**
 * @param {object} plan { orders, fills, stages }
 * @param {{ cycleId?: number|null }} [opts] cycleId 미지정 시 plan.currentCycleId, null 이면 전체
 */
const buildSplitLots = (plan, opts = {}) => {
  const cycleId =
    opts.cycleId !== undefined
      ? opts.cycleId
      : plan?.currentCycleId != null
        ? Number(plan.currentCycleId)
        : null;

  const orders = ordersForCycle(plan, cycleId);
  const orderById = new Map(orders.map((o) => [Number(o.id), o]));
  const filledOrderIds = new Set();

  const events = [];
  for (const f of plan?.fills || []) {
    const ord = orderById.get(Number(f.orderId));
    if (!ord) continue;
    const qty = Math.floor(toNum(f.fillQty));
    if (!(qty > 0)) continue;
    filledOrderIds.add(Number(ord.id));
    // fill_price 는 호가 반올림값일 수 있음 — 정확한 단가는 fill_amount / qty
    const amount = toNum(f.fillAmount);
    events.push({
      order: ord,
      qty,
      price: amount > 0 ? amount / toNum(f.fillQty) : toNum(f.fillPrice),
      at: f.filledAt || f.createdAt || null,
      seq: Number(f.id) || 0,
    });
  }
  // fills 없이 체결 상태만 남은 주문 (레거시)
  for (const o of orders) {
    if (filledOrderIds.has(Number(o.id))) continue;
    const st = String(o.status || '').toLowerCase();
    if (!['partial', 'filled'].includes(st)) continue;
    const qty = Math.floor(toNum(o.requestedQty));
    if (!(qty > 0)) continue;
    events.push({
      order: o,
      qty,
      price: toNum(o.requestedPrice),
      at: o.orderedAt || o.createdAt || null,
      seq: Number.MAX_SAFE_INTEGER,
    });
  }

  events.sort((a, b) => {
    const dt = toTime(a.at) - toTime(b.at);
    if (dt !== 0) return dt;
    const sa = String(a.order.side).toUpperCase() === 'BUY' ? 0 : 1;
    const sb = String(b.order.side).toUpperCase() === 'BUY' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.seq - b.seq || Number(a.order.id) - Number(b.order.id);
  });

  const lots = [];
  /** @type {Map<number, {orderId:number, stageNo:number|null, qty:number, matchedQty:number, cost:number, at:any}>} */
  const sells = new Map();

  for (const ev of events) {
    const side = String(ev.order.side).toUpperCase();
    const stageNo = resolveOrderStageNo(plan, ev.order);
    const orderId = Number(ev.order.id);

    if (side === 'BUY') {
      if (!(ev.price > 0)) continue;
      const open = lots.find((l) => l.orderId === orderId && l.qty > 0);
      if (open) {
        const amt = open.price * open.qty + ev.price * ev.qty;
        open.qty += ev.qty;
        open.price = amt / open.qty;
      } else {
        lots.push({
          orderId,
          stageNo,
          qty: ev.qty,
          price: ev.price,
          at: ev.at,
          orderNo: ev.order.brokerOrderNo || null,
        });
      }
      continue;
    }

    if (side !== 'SELL') continue;
    const rec = sells.get(orderId) || { orderId, stageNo, qty: 0, matchedQty: 0, cost: 0, at: ev.at };
    rec.qty += ev.qty;
    rec.at = ev.at || rec.at;

    const candidates = lots
      .filter((l) => l.qty > 0)
      .sort((a, b) => {
        const sameA = stageNo != null && a.stageNo === stageNo ? 0 : 1;
        const sameB = stageNo != null && b.stageNo === stageNo ? 0 : 1;
        if (sameA !== sameB) return sameA - sameB;
        if (sameA === 0) return toTime(a.at) - toTime(b.at);
        return (Number(b.stageNo) || 0) - (Number(a.stageNo) || 0) || toTime(a.at) - toTime(b.at);
      });

    let remaining = ev.qty;
    for (const lot of candidates) {
      if (!(remaining > 0)) break;
      const take = Math.min(lot.qty, remaining);
      lot.qty -= take;
      remaining -= take;
      rec.matchedQty += take;
      rec.cost += take * lot.price;
    }
    sells.set(orderId, rec);
  }

  const openLots = lots.filter((l) => l.qty > 0);

  /** @type {Map<number|null, {stage:number|null, qty:number, amt:number, avgPrice:number, at:any, orderNo:string|null}>} */
  const positions = new Map();
  for (const lot of openLots) {
    const key = lot.stageNo;
    const p = positions.get(key) || { stage: key, qty: 0, amt: 0, avgPrice: 0, at: null, orderNo: null };
    p.qty += lot.qty;
    p.amt += lot.qty * lot.price;
    if (!p.at || toTime(lot.at) < toTime(p.at)) p.at = lot.at;
    p.orderNo = lot.orderNo || p.orderNo;
    positions.set(key, p);
  }
  for (const p of positions.values()) {
    p.avgPrice = p.qty > 0 ? p.amt / p.qty : 0;
  }

  return { cycleId, lots: openLots, sells, positions };
};

/** 분할 N차 잔량·평단 (열린 로트 기준) */
const splitStagePosition = (plan, stageNo, cycleId) => {
  const n = Number(stageNo);
  if (!Number.isFinite(n) || n < 1) return { qty: 0, avgPrice: 0, at: null, orderNo: null };
  const { positions } = buildSplitLots(plan, { cycleId });
  const p = positions.get(n);
  return p
    ? { qty: Math.floor(p.qty), avgPrice: p.avgPrice, at: p.at, orderNo: p.orderNo }
    : { qty: 0, avgPrice: 0, at: null, orderNo: null };
};

module.exports = {
  buildSplitLots,
  splitStagePosition,
  resolveOrderStageNo,
};

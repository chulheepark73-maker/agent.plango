/**
 * 무한매매 — 평단 대비 단계별 배수 구간
 *
 * UI 라벨(step=s, multipliers 길이 n):
 *   [0] +s%↑
 *   [1] ~+s%          (0 ≤ pct < +s)
 *   [2] -s%~평단      (-s ≤ pct < 0)
 *   [3..] -(k)s% ~ -(k-1)s%
 *   [n-1] -(n-3)s%↓
 */

const DEFAULT_MULTIPLIERS = [0, 0.5, 1, 1.5, 2, 2.5];
const { isEtfLikeMrktTp } = require('./krMrktTp');

const toNum = (v, fallback = NaN) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
};

/**
 * @param {number} currentPrice
 * @param {number} avgCost
 * @returns {number} ((current-avg)/avg)*100
 */
const pctFromAvg = (currentPrice, avgCost) => {
  const p = toNum(currentPrice);
  const a = toNum(avgCost);
  if (!(p > 0) || !(a > 0)) return NaN;
  return ((p - a) / a) * 100;
};

/**
 * @param {number} pct 평단 대비 등락률(%)
 * @param {number} stepPercent buyStepPercent (기본 2)
 * @param {number} bandCount multipliers 길이
 * @returns {number} band index
 */
const bandIndexForPct = (pct, stepPercent = 2, bandCount = DEFAULT_MULTIPLIERS.length) => {
  const s = toNum(stepPercent, 2) || 2;
  const n = Math.max(3, bandCount | 0);
  if (!Number.isFinite(pct)) return 0;

  if (pct >= s) return 0;
  if (pct >= 0) return 1;
  if (pct >= -s) return 2;

  // index i (3..n-2): -((i-1)*s) <= pct < -((i-2)*s)
  for (let i = 3; i < n - 1; i++) {
    const upper = (i - 1) * s; // more negative bound magnitude
    const lower = (i - 2) * s;
    if (pct >= -upper && pct < -lower) return i;
  }
  return n - 1;
};

/**
 * @param {number} currentPrice
 * @param {number} avgCost
 * @param {object} cfg strategyConfig
 * @returns {{ pct:number, bandIndex:number, multiplier:number, buyAmount:number }}
 */
const resolveInfiniteBandBuy = (currentPrice, avgCost, cfg = {}) => {
  const step = toNum(cfg.buyStepPercent, 2) || 2;
  const unit = toNum(cfg.unitBuyAmount, 0) || 0;
  let mults = Array.isArray(cfg.buyMultipliers) ? cfg.buyMultipliers.map((m) => toNum(m, 0)) : null;
  if (!mults || !mults.length) mults = [...DEFAULT_MULTIPLIERS];

  const pct = pctFromAvg(currentPrice, avgCost);
  const bandIndex = bandIndexForPct(pct, step, mults.length);
  const multiplier = toNum(mults[bandIndex], 0) || 0;
  const buyAmount = unit > 0 && multiplier > 0 ? unit * multiplier : 0;

  return { pct, bandIndex, multiplier, buyAmount, stepPercent: step };
};

/**
 * BUY fills → 가중평균 평단 + 순보유수량(매도 체결 차감)
 * fills가 없으면 주문 상태로 잠정 평단 사용 (기본: submitted 포함)
 * @param {object} plan
 * @param {{ cycleId?: number|null, includeSubmitted?: boolean }} [opts]
 * - includeSubmitted 기본 true (시드/배수). false면 partial/filled만 (대시보드 보유)
 */
const avgCostFromPlanFills = (plan, opts = {}) => {
  const cycleId =
    opts.cycleId !== undefined
      ? opts.cycleId
      : plan?.currentCycleId != null
        ? Number(plan.currentCycleId)
        : null;
  const includeSubmitted = opts.includeSubmitted !== false;

  const ordersAll = plan?.orders || [];
  const orders =
    cycleId != null
      ? ordersAll.filter((o) => {
          if (o.cycleId != null) return Number(o.cycleId) === Number(cycleId);
          // legacy: stage → cycle
          if (o.stageId != null) {
            const st = (plan.stages || []).find((s) => Number(s.id) === Number(o.stageId));
            return st && Number(st.cycleId) === Number(cycleId);
          }
          // 저장 후 stage 삭제(ON DELETE SET NULL)된 체결도 잔량에 포함
          return true;
        })
      : ordersAll;
  const orderIdSet = new Set(orders.map((o) => Number(o.id)));
  const fills = (plan?.fills || []).filter((f) => orderIdSet.has(Number(f.orderId)));

  let buyQty = 0;
  let buyAmt = 0;
  let sellQty = 0;
  for (const f of fills) {
    const ord = orders.find((o) => Number(o.id) === Number(f.orderId));
    if (!ord) continue;
    const q = toNum(f.fillQty, 0) || 0;
    const p = toNum(f.fillPrice, 0) || 0;
    const amount = toNum(f.fillAmount, 0) || 0;
    const side = String(ord.side).toUpperCase();
    if (side === 'BUY' && q > 0 && p > 0) {
      buyQty += q;
      buyAmt += amount > 0 ? amount : p * q;
    } else if (side === 'SELL' && q > 0) {
      sellQty += q;
    }
  }

  if (buyQty <= 0) {
    const allowStatuses = includeSubmitted
      ? ['submitted', 'partial', 'filled']
      : ['partial', 'filled'];
    for (const o of orders) {
      const st = String(o.status || '').toLowerCase();
      if (!allowStatuses.includes(st)) continue;
      const q = toNum(o.requestedQty, 0) || 0;
      const p = toNum(o.requestedPrice, 0) || 0;
      const side = String(o.side).toUpperCase();
      if (side === 'BUY' && q > 0 && p > 0) {
        buyQty += q;
        buyAmt += p * q;
      } else if (side === 'SELL' && q > 0) {
        sellQty += q;
      }
    }
  }

  const remQty = Math.max(0, Math.floor(buyQty - sellQty));
  const avgCost = buyQty > 0 ? buyAmt / buyQty : 0;
  return { avgCost, remQty, buyQty, buyAmt, cycleId };
};

/** 분할 N차 순잔량 (체결 로트 기준 — 완료된 매수·매도 짝은 제외) */
const netFilledQtyForSplitStage = (plan, stageNo, cycleId) => {
  const { splitStagePosition } = require('./splitTradeLots');
  return splitStagePosition(plan, stageNo, cycleId).qty;
};

/**
 * 분할 매도 목표가: 매수가 × (1+|매도%|)
 * 저장된 목표가가 매수가 이하면(잘못된 BUY 가격이 붙은 경우) 재계산
 */
const resolveSplitSellTarget = (buyPrice, sellStage, stockMarket = 'KRX') => {
  const { adjustSellPriceToTickSize } = require('./priceUtils');
  const buy = Number(buyPrice) || 0;
  const stored = Number(sellStage?.targetPrice) || 0;
  const pctRaw = Number(sellStage?.percent);
  const pct = Number.isFinite(pctRaw) ? Math.abs(pctRaw) : 0;
  const derived = buy > 0 && pct > 0 ? buy * (1 + pct / 100) : 0;
  let price = stored;
  if (!(buy > 0) || !(price > buy)) {
    if (derived > 0) price = derived;
  }
  if (!(price > 0)) return 0;
  return adjustSellPriceToTickSize(price, stockMarket);
};

/**
 * 무한매매 시드 잔액
 * - seedAmount 미설정(≤0)이면 unlimited
 * - remaining = seed - 누적 BUY 금액(buyAmt)
 */
const infiniteSeedBudget = (plan, opts = {}) => {
  const seed = toNum(plan?.strategyConfig?.seedAmount, 0) || 0;
  const { buyAmt } = avgCostFromPlanFills(plan, opts);
  const spent = toNum(buyAmt, 0) || 0;
  if (!(seed > 0)) {
    return { seed: 0, spent, remaining: null, unlimited: true };
  }
  return {
    seed,
    spent,
    remaining: Math.max(0, seed - spent),
    unlimited: false,
  };
};

/**
 * 시드 잔액으로 매수 수량/금액 제한
 * @returns {{ ok:boolean, qty:number, amount:number, remaining:number|null, reason?:string, capped?:boolean, unlimited?:boolean }}
 */
const clampBuyBySeed = (plan, { price, qty, amount } = {}, opts = {}) => {
  const p = toNum(price, 0) || 0;
  let q = Math.floor(toNum(qty, 0) || 0);
  let wantAmt = toNum(amount, NaN);
  if (!Number.isFinite(wantAmt) || wantAmt <= 0) {
    wantAmt = p > 0 && q > 0 ? p * q : 0;
  }
  const budget = infiniteSeedBudget(plan, opts);
  if (budget.unlimited) {
    return { ok: q > 0 || wantAmt > 0, qty: q, amount: wantAmt, remaining: null, unlimited: true };
  }
  const rem = budget.remaining;
  if (!(rem > 0)) {
    return { ok: false, qty: 0, amount: 0, remaining: 0, reason: 'seed_exhausted' };
  }
  if (!(p > 0)) {
    return { ok: false, qty: 0, amount: 0, remaining: rem, reason: 'invalid_price' };
  }
  if (wantAmt <= rem && q > 0) {
    return { ok: true, qty: q, amount: wantAmt, remaining: rem };
  }
  const cappedQty = Math.floor(rem / p);
  if (!(cappedQty > 0)) {
    return { ok: false, qty: 0, amount: 0, remaining: rem, reason: 'seed_insufficient' };
  }
  return {
    ok: true,
    qty: cappedQty,
    amount: cappedQty * p,
    remaining: rem,
    capped: true,
  };
};

/** 첫 BUY 체결/주문일(YYYY-MM-DD) — 현재 cycle 기준 */
const firstBuyFillDate = (plan, timeZone = 'Asia/Seoul', opts = {}) => {
  const cycleId =
    opts.cycleId !== undefined
      ? opts.cycleId
      : plan?.currentCycleId != null
        ? Number(plan.currentCycleId)
        : null;
  const ordersAll = plan?.orders || [];
  const orders =
    cycleId != null
      ? ordersAll.filter((o) => {
          if (o.cycleId != null) return Number(o.cycleId) === Number(cycleId);
          if (o.stageId != null) {
            const st = (plan.stages || []).find((s) => Number(s.id) === Number(o.stageId));
            return st && Number(st.cycleId) === Number(cycleId);
          }
          return false;
        })
      : ordersAll;
  const orderIdSet = new Set(orders.map((o) => Number(o.id)));
  const fills = (plan?.fills || [])
    .filter((f) => {
      if (!orderIdSet.has(Number(f.orderId))) return false;
      const ord = orders.find((o) => Number(o.id) === Number(f.orderId));
      return ord && String(ord.side).toUpperCase() === 'BUY';
    })
    .sort((a, b) => new Date(a.filledAt || 0) - new Date(b.filledAt || 0));

  let raw = null;
  if (fills.length) {
    raw = fills[0].filledAt || fills[0].createdAt;
  } else {
    const buyOrders = orders
      .filter((o) => {
        const st = String(o.status || '').toLowerCase();
        return (
          String(o.side).toUpperCase() === 'BUY' &&
          ['submitted', 'partial', 'filled'].includes(st)
        );
      })
      .sort((a, b) => new Date(a.orderedAt || 0) - new Date(b.orderedAt || 0));
    if (buyOrders.length) raw = buyOrders[0].orderedAt || buyOrders[0].createdAt;
  }
  if (!raw) return null;
  const d = new Date(raw);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

const ETF_NAME_RE =
  /ETF|ETN|KODEX|TIGER|ACE|SOL |KIWOOM|HANARO|PLUS|TIMEFOLIO|ARIRANG|KOSEF|TREX|BNK |KBSTAR|파워|레버리지|인버스/i;

const isEtfInstrument = (plan) => {
  if (plan?.strategyConfig?.isEtf === true || plan?.strategyConfig?.isETF === true) return true;
  const tp = plan?.instrument?.mrktTp;
  if (tp != null && String(tp).trim() !== '') {
    return isEtfLikeMrktTp(tp);
  }
  const name = String(plan?.instrument?.name || '');
  const symbol = String(plan?.instrument?.symbol || '');
  if (ETF_NAME_RE.test(name) || ETF_NAME_RE.test(symbol)) return true;
  return false;
};

module.exports = {
  DEFAULT_MULTIPLIERS,
  pctFromAvg,
  bandIndexForPct,
  resolveInfiniteBandBuy,
  avgCostFromPlanFills,
  infiniteSeedBudget,
  clampBuyBySeed,
  firstBuyFillDate,
  isEtfInstrument,
  netFilledQtyForSplitStage,
  resolveSplitSellTarget,
};

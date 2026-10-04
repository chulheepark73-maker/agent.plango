/**
 * 스윙 고점(저항) 기반 매도 차수(%) 산출
 *
 * - 일봉 high 로컬 최고(스윙 고점)를 찾아 각 차수 매수가 위 저항을 고른다.
 * - 매도% = (저항가 - 매수가) / 매수가 × 100  (차수별 독립, UI profitRate)
 *
 * 튜닝은 SWING_HIGH_DEFAULTS 위주.
 */

/** @typedef {{ date?: string, open?: number, high?: number, low?: number, close?: number, volume?: number }} OhlcBar */
/** @typedef {{ index: number, date: string, price: number, score?: number, touches?: number, dropPct?: number, volRatio?: number, atrHeight?: number }} SwingHigh */

const SWING_HIGH_DEFAULTS = {
  leftBars: 3,
  rightBars: 3,
  lookbackBars: 180,
  stageCount: 5,
  /** 매수가 대비 최소 상승(%) */
  minRisePercent: 2,
  /** 매수가 대비 최대 상승(%) */
  maxRisePercent: 40,
  /** 저항 후보 간 최소 간격(매수가 대비 %p) — 동일 차수 선정용 */
  minSpacingPercent: 1.2,
  roundDigits: 2,

  atrPeriod: 14,
  useAtrFilter: true,
  atrMinMult: 0.8,
  atrMaxMult: 8,
  atrSpacingMult: 0.4,

  useResistanceScore: true,
  touchTolerancePct: 1.0,
  touchLookbackBars: 60,
  /** 고점 이후 하락 측정 봉 수 */
  dropBars: 10,
  minResistanceScore: 25,
  scoreTouchWeight: 25,
  scoreDropWeight: 35,
  scoreVolumeWeight: 20,
  scoreRecencyWeight: 20,
};

const roundTo = (n, digits) => {
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Wilder ATR */
function calcAtr(bars, period = 14) {
  const p = Math.max(2, Number(period) || 14);
  const list = Array.isArray(bars) ? bars : [];
  if (list.length < p + 1) return 0;

  const trs = [];
  for (let i = 1; i < list.length; i += 1) {
    const high = num(list[i].high) || num(list[i].close);
    const low = num(list[i].low) || num(list[i].close);
    const prevClose = num(list[i - 1].close) || num(list[i - 1].low);
    trs.push(
      Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
    );
  }
  if (trs.length < p) return 0;

  let atr = 0;
  for (let i = 0; i < p; i += 1) atr += trs[i];
  atr /= p;
  for (let i = p; i < trs.length; i += 1) {
    atr = (atr * (p - 1) + trs[i]) / p;
  }
  return atr > 0 ? atr : 0;
}

/**
 * 일봉에서 스윙 고점 후보 추출
 * @param {OhlcBar[]} bars
 * @param {Partial<typeof SWING_HIGH_DEFAULTS>} [opts]
 * @returns {SwingHigh[]}
 */
function findSwingHighs(bars, opts = {}) {
  const left = Math.max(1, Number(opts.leftBars ?? SWING_HIGH_DEFAULTS.leftBars));
  const right = Math.max(1, Number(opts.rightBars ?? SWING_HIGH_DEFAULTS.rightBars));
  const lookback = Math.max(0, Number(opts.lookbackBars ?? SWING_HIGH_DEFAULTS.lookbackBars));

  const list = Array.isArray(bars) ? bars.filter((b) => num(b?.high) > 0) : [];
  if (list.length < left + right + 1) return [];

  const start = lookback > 0 ? Math.max(0, list.length - lookback) : 0;
  const window = list.slice(start);
  const offset = start;

  /** @type {SwingHigh[]} */
  const swings = [];
  for (let i = left; i < window.length - right; i += 1) {
    const hi = num(window[i].high);
    let isSwing = true;
    for (let j = i - left; j <= i + right; j += 1) {
      if (j === i) continue;
      if (num(window[j].high) > hi) {
        isSwing = false;
        break;
      }
    }
    if (!isSwing) continue;
    swings.push({
      index: offset + i,
      date: String(window[i].date || ''),
      price: hi,
    });
  }
  return swings;
}

/**
 * 저항강도 점수 (터치 · 고점 후 하락 · 거래량 · 최근성)
 * @param {OhlcBar[]} bars
 * @param {SwingHigh} swing
 * @param {Partial<typeof SWING_HIGH_DEFAULTS>} [opts]
 * @returns {SwingHigh}
 */
function scoreSwingResistance(bars, swing, opts = {}) {
  const cfg = { ...SWING_HIGH_DEFAULTS, ...opts };
  const list = Array.isArray(bars) ? bars : [];
  const idx = Number(swing.index);
  const price = num(swing.price);
  if (!(price > 0) || idx < 0 || idx >= list.length) {
    return { ...swing, score: 0, touches: 0, dropPct: 0, volRatio: 0 };
  }

  const tol = price * (cfg.touchTolerancePct / 100);
  const look = Math.max(5, cfg.touchLookbackBars);
  const from = Math.max(0, idx - look);
  const to = Math.min(list.length - 1, idx + Math.floor(look / 3));

  let touches = 0;
  for (let i = from; i <= to; i += 1) {
    const hi = num(list[i].high);
    if (hi > 0 && Math.abs(hi - price) <= tol) touches += 1;
  }

  const dropN = Math.max(1, cfg.dropBars);
  let dropLow = num(list[idx].low) || price;
  for (let i = idx; i <= Math.min(list.length - 1, idx + dropN); i += 1) {
    const lo = num(list[i].low);
    if (lo > 0) dropLow = Math.min(dropLow, lo);
  }
  const dropPct = price > 0 ? ((price - dropLow) / price) * 100 : 0;

  let volSum = 0;
  let volCnt = 0;
  for (let i = from; i <= to; i += 1) {
    const v = num(list[i].volume);
    if (v > 0) {
      volSum += v;
      volCnt += 1;
    }
  }
  const avgVol = volCnt > 0 ? volSum / volCnt : 0;
  const swingVol = num(list[idx].volume);
  const volRatio = avgVol > 0 && swingVol > 0 ? swingVol / avgVol : 1;

  const recency =
    list.length > 1 ? Math.max(0, Math.min(1, idx / (list.length - 1))) : 0.5;

  const touchScore = Math.min(1, (touches - 1) / 4) * cfg.scoreTouchWeight;
  const dropScore = Math.min(1, dropPct / 12) * cfg.scoreDropWeight;
  const volScore = Math.min(1, Math.max(0, volRatio - 0.5) / 1.5) * cfg.scoreVolumeWeight;
  const recencyScore = recency * cfg.scoreRecencyWeight;
  const score = roundTo(
    Math.max(0, Math.min(100, touchScore + dropScore + volScore + recencyScore)),
    1
  );

  return {
    ...swing,
    score,
    touches,
    dropPct: roundTo(dropPct, 2),
    volRatio: roundTo(volRatio, 2),
  };
}

/**
 * 기준가(매수가) 위 스윙 고점 필터 + 저항점수
 * @param {OhlcBar[]} bars
 * @param {SwingHigh[]} swings
 * @param {number} basePrice 매수가
 * @param {Partial<typeof SWING_HIGH_DEFAULTS>} [opts]
 */
function enrichAndFilterSwingHighs(bars, swings, basePrice, opts = {}) {
  const cfg = { ...SWING_HIGH_DEFAULTS, ...opts };
  const B = num(basePrice);
  const atr = calcAtr(bars, cfg.atrPeriod);
  if (!(B > 0)) return { candidates: [], atr };

  const minHigh = B * (1 + cfg.minRisePercent / 100);
  const maxHigh = B * (1 + cfg.maxRisePercent / 100);

  let minRise = B * (cfg.minRisePercent / 100);
  let maxRise = B * (cfg.maxRisePercent / 100);
  if (cfg.useAtrFilter && atr > 0) {
    minRise = Math.max(minRise, atr * cfg.atrMinMult);
    maxRise = Math.min(maxRise, atr * cfg.atrMaxMult);
  }

  /** @type {SwingHigh[]} */
  const candidates = [];
  for (const raw of swings || []) {
    const price = num(raw.price);
    if (!(price > 0)) continue;
    const rise = price - B;
    if (rise < minRise || rise > maxRise) continue;
    if (price < minHigh || price > maxHigh) continue;

    let scored = {
      ...raw,
      price,
      atrHeight: atr > 0 ? roundTo(rise / atr, 2) : null,
    };
    if (cfg.useResistanceScore) {
      scored = scoreSwingResistance(bars, scored, cfg);
      if (cfg.minResistanceScore > 0 && (scored.score || 0) < cfg.minResistanceScore) {
        continue;
      }
    } else {
      scored.score = 50;
    }
    candidates.push(scored);
  }

  return { candidates, atr };
}

/**
 * 매수가 위 저항 1개 선정 (가까운 쪽 + 점수)
 * @param {SwingHigh[]} candidates
 * @param {number} basePrice
 * @returns {number|null} 저항 가격
 */
function pickResistanceForBuyPrice(candidates, basePrice) {
  const B = num(basePrice);
  if (!(B > 0)) return null;
  const list = (candidates || [])
    .map((s) => ({ ...s, price: num(s.price), score: num(s.score) }))
    .filter((s) => s.price > B)
    .sort((a, b) => {
      // 가까운 저항 우선, 동률이면 점수↑
      const da = a.price - B;
      const db = b.price - B;
      if (Math.abs(da - db) > 1e-9) return da - db;
      return (b.score || 0) - (a.score || 0);
    });
  return list.length ? list[0].price : null;
}

/**
 * 차수별 매수가 배열 → 각 차수 profitRate(%)
 *
 * @param {{
 *   bars: OhlcBar[],
 *   buyPrices: number[],
 *   options?: Partial<typeof SWING_HIGH_DEFAULTS>,
 * }} args
 */
function computeSwingSellProfitRates({ bars, buyPrices = [], options = {} }) {
  const cfg = { ...SWING_HIGH_DEFAULTS, ...options };
  const list = Array.isArray(bars) ? bars.filter((b) => num(b?.high) > 0) : [];
  const prices = (buyPrices || []).map(num);
  const n = Math.max(1, cfg.stageCount);

  if (!list.length) {
    return {
      ok: false,
      profitRates: [],
      targets: [],
      swings: [],
      atr: 0,
      message: '일봉이 없어 스윙 고점을 계산할 수 없습니다.',
    };
  }

  const swings = findSwingHighs(list, cfg);
  const atr = calcAtr(list, cfg.atrPeriod);

  /** @type {(number|null)[]} */
  const profitRates = [];
  /** @type {(number|null)[]} */
  const targets = [];
  /** @type {SwingHigh[]} */
  const used = [];

  for (let i = 0; i < n; i += 1) {
    const buy = prices[i];
    if (!(buy > 0)) {
      profitRates.push(null);
      targets.push(null);
      continue;
    }

    const { candidates } = enrichAndFilterSwingHighs(list, swings, buy, cfg);
    let resistance = pickResistanceForBuyPrice(candidates, buy);

    // 필터가 너무 빡세면 점수 없이 재시도
    if (!(resistance > 0)) {
      const loose = enrichAndFilterSwingHighs(list, swings, buy, {
        ...cfg,
        minResistanceScore: 0,
        useAtrFilter: false,
        minRisePercent: Math.min(1.5, cfg.minRisePercent),
        maxRisePercent: Math.max(50, cfg.maxRisePercent),
      });
      resistance = pickResistanceForBuyPrice(loose.candidates, buy);
    }

    // 그래도 없으면 최소/기본 상승률로 목표가 생성
    if (!(resistance > buy)) {
      const fallbackPct = Math.max(cfg.minRisePercent, 3);
      resistance = buy * (1 + fallbackPct / 100);
    }

    const rate = ((resistance - buy) / buy) * 100;
    profitRates.push(roundTo(Math.max(0.01, rate), cfg.roundDigits));
    targets.push(resistance);

    const hit = swings.find((s) => Math.abs(num(s.price) - resistance) / resistance < 0.002);
    if (hit) used.push(hit);
  }

  const applied = profitRates.filter((d) => d != null && d > 0).length;
  return {
    ok: applied > 0,
    profitRates,
    targets,
    swings: used.length ? used : swings.slice(0, 10),
    atr: roundTo(atr, 2),
    message:
      applied > 0
        ? `저항 스윙 기반 매도 ${applied}차 % 반영 (ATR ${roundTo(atr, 1)})`
        : '매도 %를 계산하지 못했습니다.',
  };
}

module.exports = {
  SWING_HIGH_DEFAULTS,
  findSwingHighs,
  scoreSwingResistance,
  enrichAndFilterSwingHighs,
  pickResistanceForBuyPrice,
  computeSwingSellProfitRates,
};

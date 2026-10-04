/**
 * 스윙 저점 기반 매수 차수(%) 산출
 *
 * 흐름:
 * 1) 일봉에서 스윙 저점 추출
 * 2) ATR 필터 (현재가 대비 깊이가 ATR 배수 범위인지)
 * 3) 지지강도 점수 (터치·반등·거래량·최근성)
 * 4) 점수·깊이 기준으로 1~5차 목표가 선정
 * 5) UI 누적 dropRate(%) 로 변환
 *
 * 튜닝은 SWING_LOW_DEFAULTS 위주.
 */

/** @typedef {{ date?: string, open?: number, high?: number, low?: number, close?: number, volume?: number }} OhlcBar */
/** @typedef {{ index: number, date: string, price: number, score?: number, touches?: number, bouncePct?: number, volRatio?: number, atrDepth?: number }} SwingLow */

const SWING_LOW_DEFAULTS = {
  /** 스윙 판정: 좌측 봉 개수 */
  leftBars: 3,
  /** 스윙 판정: 우측 봉 개수 */
  rightBars: 3,
  /** 최근 N봉만 사용 (0이면 전체) */
  lookbackBars: 180,
  /** 채울 차수 */
  stageCount: 5,
  /** 현재가 대비 최소 하락(%) — 이보다 얕은 스윙 무시 */
  minDropPercent: 1.5,
  /** 현재가 대비 최대 하락(%) — 이보다 깊은 스윙 무시 */
  maxDropPercent: 35,
  /** 후보 간 최소 간격(현재가 대비 %p) — ATR 간격과 함께 사용 */
  minSpacingPercent: 1.2,
  /** dropRate 소수 자리 */
  roundDigits: 2,

  // --- ATR ---
  /** ATR 기간 */
  atrPeriod: 14,
  /** ATR 필터 사용 */
  useAtrFilter: true,
  /** 최소 깊이 = atrMinMult × ATR (현재가 대비) */
  atrMinMult: 0.8,
  /** 최대 깊이 = atrMaxMult × ATR */
  atrMaxMult: 8,
  /** 차수 간 최소 간격도 ATR 기준 (0이면 %만 사용) */
  atrSpacingMult: 0.4,

  // --- 지지강도 ---
  /** 지지강도 점수 사용 (선정·정렬) */
  useSupportScore: true,
  /** 터치 판정: 스윙가 ± touchTolerancePct% */
  touchTolerancePct: 1.0,
  /** 터치 카운트 룩백(봉) — 스윙 전후 포함 전체 윈도우에서 집계 */
  touchLookbackBars: 60,
  /** 반등 측정: 스윙 이후 bounceBars 봉의 최고가 */
  bounceBars: 10,
  /** 최소 지지점수 — 이하면 후보에서 제외 (0이면 제외 안 함) */
  minSupportScore: 25,
  /** 점수 가중치 */
  scoreTouchWeight: 25,
  scoreBounceWeight: 35,
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

/**
 * Wilder ATR (단순 시드: 초기 SMA, 이후 평활)
 * @param {OhlcBar[]} bars
 * @param {number} period
 * @returns {number} 마지막 ATR (실패 시 0)
 */
function calcAtr(bars, period = 14) {
  const p = Math.max(2, Number(period) || 14);
  const list = Array.isArray(bars) ? bars : [];
  if (list.length < p + 1) return 0;

  const trs = [];
  for (let i = 1; i < list.length; i += 1) {
    const high = num(list[i].high) || num(list[i].close);
    const low = num(list[i].low) || num(list[i].close);
    const prevClose = num(list[i - 1].close) || num(list[i - 1].low);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
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
 * 일봉에서 스윙 저점 후보 추출 (최신이 배열 끝이라고 가정)
 * @param {OhlcBar[]} bars
 * @param {Partial<typeof SWING_LOW_DEFAULTS>} [opts]
 * @returns {SwingLow[]}
 */
function findSwingLows(bars, opts = {}) {
  const left = Math.max(1, Number(opts.leftBars ?? SWING_LOW_DEFAULTS.leftBars));
  const right = Math.max(1, Number(opts.rightBars ?? SWING_LOW_DEFAULTS.rightBars));
  const lookback = Math.max(0, Number(opts.lookbackBars ?? SWING_LOW_DEFAULTS.lookbackBars));

  const list = Array.isArray(bars) ? bars.filter((b) => num(b?.low) > 0) : [];
  if (list.length < left + right + 1) return [];

  const start = lookback > 0 ? Math.max(0, list.length - lookback) : 0;
  const window = list.slice(start);
  const offset = start;

  /** @type {SwingLow[]} */
  const swings = [];
  for (let i = left; i < window.length - right; i += 1) {
    const lo = num(window[i].low);
    let isSwing = true;
    for (let j = i - left; j <= i + right; j += 1) {
      if (j === i) continue;
      if (num(window[j].low) < lo) {
        isSwing = false;
        break;
      }
    }
    if (!isSwing) continue;
    swings.push({
      index: offset + i,
      date: String(window[i].date || ''),
      price: lo,
    });
  }
  return swings;
}

/**
 * 스윙 저점 지지강도 점수 (0~100 근사)
 * - 터치: 유사 가격대 low 출현 횟수
 * - 반등: 스윙 이후 N봉 고가 상승률
 * - 거래량: 스윙 봉 거래량 / 평균
 * - 최근성: 최근 봉에 가까울수록 가점
 *
 * @param {OhlcBar[]} bars 전체(또는 lookback) 일봉
 * @param {SwingLow} swing
 * @param {Partial<typeof SWING_LOW_DEFAULTS>} [opts]
 * @returns {SwingLow}
 */
function scoreSwingSupport(bars, swing, opts = {}) {
  const cfg = { ...SWING_LOW_DEFAULTS, ...opts };
  const list = Array.isArray(bars) ? bars : [];
  const idx = Number(swing.index);
  const price = num(swing.price);
  if (!(price > 0) || idx < 0 || idx >= list.length) {
    return { ...swing, score: 0, touches: 0, bouncePct: 0, volRatio: 0 };
  }

  const tol = price * (cfg.touchTolerancePct / 100);
  const look = Math.max(5, cfg.touchLookbackBars);
  const from = Math.max(0, idx - look);
  const to = Math.min(list.length - 1, idx + Math.floor(look / 3));

  let touches = 0;
  for (let i = from; i <= to; i += 1) {
    const lo = num(list[i].low);
    if (lo > 0 && Math.abs(lo - price) <= tol) touches += 1;
  }

  const bounceN = Math.max(1, cfg.bounceBars);
  let bounceHigh = num(list[idx].high) || price;
  for (let i = idx; i <= Math.min(list.length - 1, idx + bounceN); i += 1) {
    bounceHigh = Math.max(bounceHigh, num(list[i].high) || 0);
  }
  const bouncePct = price > 0 ? ((bounceHigh - price) / price) * 100 : 0;

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

  // 최근성: 마지막 봉에 가까울수록 1 → 0
  const recency =
    list.length > 1 ? Math.max(0, Math.min(1, idx / (list.length - 1))) : 0.5;

  // 점수 정규화 (대략 0~100)
  const touchScore = Math.min(1, (touches - 1) / 4) * cfg.scoreTouchWeight; // 1회=0, 5회+=만점
  const bounceScore = Math.min(1, bouncePct / 12) * cfg.scoreBounceWeight; // ~12% 반등=만점
  const volScore = Math.min(1, Math.max(0, volRatio - 0.5) / 1.5) * cfg.scoreVolumeWeight;
  const recencyScore = recency * cfg.scoreRecencyWeight;
  const score = roundTo(
    Math.max(0, Math.min(100, touchScore + bounceScore + volScore + recencyScore)),
    1
  );

  return {
    ...swing,
    score,
    touches,
    bouncePct: roundTo(bouncePct, 2),
    volRatio: roundTo(volRatio, 2),
  };
}

/**
 * %·ATR 깊이 필터 + 지지점수 부여
 * @param {OhlcBar[]} bars
 * @param {SwingLow[]} swings
 * @param {number} currentPrice
 * @param {Partial<typeof SWING_LOW_DEFAULTS>} [opts]
 * @returns {{ candidates: SwingLow[], atr: number }}
 */
function enrichAndFilterSwings(bars, swings, currentPrice, opts = {}) {
  const cfg = { ...SWING_LOW_DEFAULTS, ...opts };
  const C = num(currentPrice);
  const atr = calcAtr(bars, cfg.atrPeriod);
  if (!(C > 0)) return { candidates: [], atr };

  const minPPct = C * (1 - cfg.maxDropPercent / 100);
  const maxPPct = C * (1 - cfg.minDropPercent / 100);

  let minDepth = C * (cfg.minDropPercent / 100);
  let maxDepth = C * (cfg.maxDropPercent / 100);
  if (cfg.useAtrFilter && atr > 0) {
    minDepth = Math.max(minDepth, atr * cfg.atrMinMult);
    maxDepth = Math.min(maxDepth, atr * cfg.atrMaxMult);
  }

  /** @type {SwingLow[]} */
  const candidates = [];
  for (const raw of swings || []) {
    const price = num(raw.price);
    if (!(price > 0)) continue;
    const depth = C - price;
    if (depth < minDepth || depth > maxDepth) continue;
    if (price > maxPPct || price < minPPct) continue;

    let scored = { ...raw, price, atrDepth: atr > 0 ? roundTo(depth / atr, 2) : null };
    if (cfg.useSupportScore) {
      scored = scoreSwingSupport(bars, scored, cfg);
      if (cfg.minSupportScore > 0 && (scored.score || 0) < cfg.minSupportScore) {
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
 * 현재가 아래 스윙을 골라 stageCount개 목표가 배열 생성 (얕은→깊은)
 * 점수가 있으면 같은 깊이대에서 점수 높은 쪽을 우선.
 *
 * @param {SwingLow[]} swings  (enrichAndFilter 결과 권장)
 * @param {number} currentPrice
 * @param {Partial<typeof SWING_LOW_DEFAULTS>} [opts]
 * @param {number} [atr]
 * @returns {number[]} 목표가
 */
function selectSwingLowTargets(swings, currentPrice, opts = {}, atr = 0) {
  const cfg = { ...SWING_LOW_DEFAULTS, ...opts };
  const C = num(currentPrice);
  const n = Math.max(1, cfg.stageCount);
  if (!(C > 0)) return [];

  // 얕은(가격↑) 우선, 동률이면 점수↑
  const filtered = (swings || [])
    .map((s) => ({ ...s, price: num(s.price), score: num(s.score) }))
    .filter((s) => s.price > 0)
    .sort((a, b) => {
      if (b.price !== a.price) return b.price - a.price;
      return (b.score || 0) - (a.score || 0);
    });

  let minGapPct = cfg.minSpacingPercent;
  if (cfg.atrSpacingMult > 0 && atr > 0 && C > 0) {
    minGapPct = Math.max(minGapPct, ((atr * cfg.atrSpacingMult) / C) * 100);
  }

  // 간격 필터 — 새 후보가 들어오면 점수 더 높으면 교체 검토는 단순화: 이미 정렬된 순으로 간격만
  const spaced = [];
  for (const s of filtered) {
    if (!spaced.length) {
      spaced.push(s);
      continue;
    }
    const prev = spaced[spaced.length - 1];
    const gapPct = ((prev.price - s.price) / C) * 100;
    if (gapPct >= minGapPct) {
      spaced.push(s);
      continue;
    }
    // 너무 가까운데 점수가 확실히 높으면 교체
    if ((s.score || 0) > (prev.score || 0) + 8) {
      spaced[spaced.length - 1] = s;
    }
  }

  if (!spaced.length) return [];

  // 점수 상위도 섞되, 최종은 가격 얕은→깊게 stage 배정
  // 1차: 얕고 점수 괜찮은 것 / 깊은 차는 깊은 쪽 우선하되 점수 하한은 이미 통과
  let picks = spaced.slice(0, n).map((s) => s.price);

  if (picks.length < n) {
    const deepest = Math.min(...spaced.map((s) => s.price));
    const shallow = Math.max(
      ...spaced.map((s) => s.price),
      C * (1 - cfg.minDropPercent / 100)
    );
    const filled = [];
    for (let i = 0; i < n; i += 1) {
      const p = shallow + (deepest - shallow) * (i / Math.max(1, n - 1));
      filled.push(p);
    }
    if (picks.length === 1 && n > 1) {
      picks = filled.map((p, i) => (i === 0 ? picks[0] : p));
      picks[n - 1] = deepest;
    } else {
      picks = filled;
    }
  }

  for (let i = 1; i < picks.length; i += 1) {
    if (picks[i] >= picks[i - 1]) {
      picks[i] = picks[i - 1] * (1 - minGapPct / 200);
    }
  }
  return picks.slice(0, n);
}

/**
 * 목표가 → UI용 누적 dropRate(%)
 * buyEnd='Y' 인 차수는 null 로 두고 건너뛴다.
 */
function targetsToCascadingDropRates(targets, currentPrice, stages = [], opts = {}) {
  const digits = opts.roundDigits ?? SWING_LOW_DEFAULTS.roundDigits;
  const C = num(currentPrice);
  const T = (targets || []).map(num);
  const out = [];

  for (let i = 0; i < T.length; i += 1) {
    const ended = String(stages[i]?.buyEnd || 'N').toUpperCase() === 'Y';
    if (ended) {
      out.push(null);
      continue;
    }
    if (!(T[i] > 0) || !(C > 0)) {
      out.push(null);
      continue;
    }

    let ref = C;
    if (i > 0) {
      const prevEnded = String(stages[i - 1]?.buyEnd || 'N').toUpperCase() === 'Y';
      if (!prevEnded && T[i - 1] > 0) ref = T[i - 1];
      else ref = C;
    }

    if (!(ref > 0) || T[i] >= ref) {
      out.push(null);
      continue;
    }
    const drop = (1 - T[i] / ref) * 100;
    out.push(roundTo(Math.max(0.01, drop), digits));
  }
  return out;
}

/**
 * 메인 엔트리: 일봉 + 현재가 → 1~5차 dropRate
 */
function computeSwingBuyDropRates({ bars, currentPrice, stages = [], options = {} }) {
  const cfg = { ...SWING_LOW_DEFAULTS, ...options };
  const C = num(currentPrice);
  if (!(C > 0)) {
    return {
      ok: false,
      dropRates: [],
      targets: [],
      swings: [],
      atr: 0,
      message: '현재가가 없어 스윙 저점을 계산할 수 없습니다.',
    };
  }

  const list = Array.isArray(bars) ? bars.filter((b) => num(b?.low) > 0) : [];
  const swings = findSwingLows(list, cfg);
  const { candidates, atr } = enrichAndFilterSwings(list, swings, C, cfg);
  const targets = selectSwingLowTargets(candidates, C, cfg, atr);

  if (!targets.length) {
    return {
      ok: false,
      dropRates: [],
      targets: [],
      swings: candidates,
      atr,
      message:
        'ATR/지지강도 필터 후 유효 스윙이 없습니다. (minSupportScore·ATR 배율을 완화해 보세요)',
    };
  }

  const dropRates = targetsToCascadingDropRates(targets, C, stages, cfg);
  const applied = dropRates.filter((d) => d != null && d > 0).length;
  const topScore = candidates.length
    ? Math.max(...candidates.map((c) => num(c.score)))
    : 0;

  return {
    ok: applied > 0,
    dropRates,
    targets,
    swings: candidates,
    atr: roundTo(atr, 2),
    message:
      applied > 0
        ? `스윙 ${swings.length}→필터 ${candidates.length} (ATR ${roundTo(atr, 1)}, 최고점수 ${topScore}) → ${applied}차 % 반영`
        : '적용할 차수 %가 없습니다.',
  };
}

module.exports = {
  SWING_LOW_DEFAULTS,
  calcAtr,
  findSwingLows,
  scoreSwingSupport,
  enrichAndFilterSwings,
  selectSwingLowTargets,
  targetsToCascadingDropRates,
  computeSwingBuyDropRates,
};

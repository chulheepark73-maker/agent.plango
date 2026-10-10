/**
 * 무한매매 — 단계별 배수 스케줄 매수
 * - 매수시간: strategy_config.infiniteBuyTime (KST HH:mm, 1일 1회)
 * - 미설정 시 기본값: KR 주식 19:00 / KR ETF 15:00 / US 04:00
 * - 1회 entry 체결 다음날부터, 평단 대비 배수로 금액 산정 후 현재가 지정가 즉시 주문
 */

const cron = require('node-cron');
const { getAllUsers } = require('./userStore');
const { getKiwoomInfo } = require('./kiwoomUtils');
const { listTradingPlans, getTradingPlanById, updateTradingPlan } = require('./tradingV2Store');
const { executeTradingV2BuyOrder, hasOpenOrderForStage } = require('./tradingV2OrderExec');
const {
  resolveInfiniteBandBuy,
  avgCostFromPlanFills,
  firstBuyFillDate,
  isEtfInstrument,
  clampBuyBySeed,
} = require('./infiniteTradeBands');
const { normalizeAutoCode, isUsMarket } = require('./autoTradingMarket');
const { getKoreaDateString, isWeekend, isHolidaySync } = require('./stockUtils');

const LOG = '[무한매매스케줄]';

/** @type {Set<string>} planId:dateKey */
const ranKeys = new Set();

let started = false;

const kstParts = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hm: `${hour}:${get('minute')}`,
  };
};

const nyParts = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hm: `${hour}:${get('minute')}`,
    weekday: get('weekday'),
  };
};

const resolveMarket = (plan) => {
  const m = String(plan.instrument?.market || '').toUpperCase();
  if (m === 'US') return 'US';
  const ex = String(plan.venue?.exchange || '').toUpperCase();
  if (ex === 'NXT') return 'NXT';
  return 'KRX';
};

const getPriceForPlan = async (userId, stockCode, stockMarket) => {
  const code = normalizeAutoCode(stockCode, stockMarket);
  for (const load of [
    () => require('../services/autoTradingWsMonitor_v2'),
    () => require('../services/indicatorWsMonitor'),
  ]) {
    try {
      const { getLastPrices } = load();
      if (typeof getLastPrices !== 'function') continue;
      const map = getLastPrices(userId);
      const row = map?.get(code) || map?.get(String(code).toUpperCase());
      if (row?.price > 0) return Number(row.price);
    } catch {
      /* ignore */
    }
  }
  return 0;
};

/** KST HH:mm */
const DEFAULT_BUY_TIME = {
  KR_STOCK: '19:00',
  KR_ETF: '15:00',
  US: '04:00',
};

const normalizeBuyTime = (v) => {
  const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};

/** @param {'KR_STOCK'|'KR_ETF'|'US'} slot */
const planBuyTime = (plan, slot) =>
  normalizeBuyTime(plan?.strategyConfig?.infiniteBuyTime) || DEFAULT_BUY_TIME[slot];

/** US는 뉴욕 기준 평일, KR은 KST 평일·휴장일 제외 */
const isTradingDayForSlot = (slot) => {
  if (slot === 'US') {
    const { weekday } = nyParts();
    return weekday !== 'Sat' && weekday !== 'Sun';
  }
  return !isWeekend() && !isHolidaySync();
};

const shouldRunPlanNow = (plan, slot, kstHm = kstParts().hm) =>
  isTradingDayForSlot(slot) && planBuyTime(plan, slot) === kstHm;

const dateKeyForSlot = (slot) => {
  if (slot === 'US') return nyParts().date;
  return getKoreaDateString();
};

/**
 * @returns {'KR_STOCK'|'KR_ETF'|'US'|null}
 */
const planSlot = (plan) => {
  const market = resolveMarket(plan);
  if (market === 'US' || isUsMarket(market, plan.instrument?.symbol)) return 'US';
  if (isEtfInstrument(plan)) return 'KR_ETF';
  return 'KR_STOCK';
};

const markBandBuyDone = async (userId, plan, dateKey) => {
  try {
    await updateTradingPlan(userId, plan.id, {
      strategyConfig: {
        ...(plan.strategyConfig || {}),
        lastBandBuyDate: dateKey,
      },
    });
  } catch (err) {
    console.error(`${LOG} lastBandBuyDate 저장 실패 plan=${plan.id}:`, err.message);
  }
};

const runBandBuyForPlan = async (userId, kiwoomInfo, plan, slot, dateKey) => {
  const runKey = `${plan.id}:${dateKey}`;
  if (ranKeys.has(runKey)) return { skipped: true, reason: 'ran_memory' };

  const cfg = plan.strategyConfig || {};
  if (String(cfg.lastBandBuyDate || '') === dateKey) {
    ranKeys.add(runKey);
    return { skipped: true, reason: 'already_today' };
  }

  const { avgCost, remQty } = avgCostFromPlanFills(plan, { includeSubmitted: false });
  if (!(avgCost > 0) || remQty <= 0) {
    return { skipped: true, reason: 'no_position' };
  }

  const tz = slot === 'US' ? 'America/New_York' : 'Asia/Seoul';
  const entryDate = firstBuyFillDate(plan, tz);
  if (entryDate && entryDate === dateKey) {
    ranKeys.add(runKey);
    await markBandBuyDone(userId, plan, dateKey);
    return { skipped: true, reason: 'entry_day' };
  }

  if (hasOpenOrderForStage(plan, 'BUY', null)) {
    return { skipped: true, reason: 'open_buy_order' };
  }

  const stockMarket = resolveMarket(plan);
  const stockCode = normalizeAutoCode(plan.instrument?.symbol, stockMarket);
  const price = await getPriceForPlan(userId, stockCode, stockMarket);
  if (!(price > 0)) {
    console.warn(`${LOG}[${userId}] 시세 없음 ${stockCode} — 다음 분에 재시도`);
    return { skipped: true, reason: 'no_price' };
  }

  const band = resolveInfiniteBandBuy(price, avgCost, cfg);
  console.log(
    `${LOG}[${userId}] plan=${plan.id} ${stockCode} slot=${slot} pct=${band.pct?.toFixed?.(2)}% ` +
      `band=${band.bandIndex} x${band.multiplier} amount=${band.buyAmount} price=${price}`
  );

  // 0배 — 주문 없이 당일 스킵 확정
  if (!(band.buyAmount > 0) || !(band.multiplier > 0)) {
    ranKeys.add(runKey);
    await markBandBuyDone(userId, plan, dateKey);
    return { skipped: true, reason: 'zero_multiplier', band };
  }

  let qty = Math.floor(band.buyAmount / price);
  if (!(qty > 0)) {
    ranKeys.add(runKey);
    await markBandBuyDone(userId, plan, dateKey);
    return { skipped: true, reason: 'qty_zero', band };
  }

  const capped = clampBuyBySeed(plan, {
    price,
    qty,
    amount: band.buyAmount,
  });
  if (!capped.ok) {
    ranKeys.add(runKey);
    await markBandBuyDone(userId, plan, dateKey);
    console.log(
      `${LOG}[${userId}] plan=${plan.id} 시드 잔액 부족 skip=${capped.reason} ` +
        `remaining=${capped.remaining}`
    );
    return { skipped: true, reason: capped.reason || 'seed_exhausted', band, remaining: capped.remaining };
  }
  qty = capped.qty;
  if (capped.capped) {
    console.log(
      `${LOG}[${userId}] plan=${plan.id} 시드 잔액으로 수량 축소 qty=${qty} remaining=${capped.remaining}`
    );
  }

  const result = await executeTradingV2BuyOrder({
    kiwoomInfo,
    userId,
    stockCode,
    price,
    qty,
    stockMarket,
    planId: plan.id,
    cycleId: plan.currentCycleId != null ? Number(plan.currentCycleId) : null,
    stageId: null,
    buyStage: 1,
  });

  // 주문 성공(접수) 후에만 당일 완료 — 실패 시 같은 슬롯에서 재시도
  if (result?.success) {
    ranKeys.add(runKey);
    await markBandBuyDone(userId, plan, dateKey);
  } else {
    console.warn(
      `${LOG}[${userId}] 배수매수 실패 plan=${plan.id}: ${result?.error || result?.message || 'unknown'}`
    );
  }

  return { skipped: false, result, band, qty, price };
};

const tick = async () => {
  const kstHm = kstParts().hm;
  const users = await getAllUsers();
  for (const user of users) {
    const userId = String(user.id);

    let plans = [];
    try {
      plans = await listTradingPlans(userId, { status: 'active' });
    } catch (err) {
      console.error(`${LOG}[${userId}] 플랜 목록 실패:`, err.message);
      continue;
    }
    const due = plans.filter(
      (p) => p.strategyType === 'INFINITE_TRADE' && shouldRunPlanNow(p, planSlot(p), kstHm)
    );
    if (due.length === 0) continue;

    let kiwoomInfo;
    try {
      kiwoomInfo = await getKiwoomInfo(userId);
      if (
        !kiwoomInfo?.accessToken ||
        !kiwoomInfo?.appKey ||
        !kiwoomInfo?.appSecret ||
        !kiwoomInfo?.accountNo
      ) {
        continue;
      }
    } catch {
      continue;
    }

    for (const summary of due) {
      let plan;
      try {
        plan = await getTradingPlanById(userId, summary.id);
      } catch {
        continue;
      }
      if (!plan || plan.status !== 'active') continue;
      const slot = planSlot(plan);
      const dateKey = dateKeyForSlot(slot);
      console.log(`${LOG}[${userId}] plan=${plan.id} 매수시간 ${kstHm} 실행 ${slot} date=${dateKey}`);

      try {
        const out = await runBandBuyForPlan(userId, kiwoomInfo, plan, slot, dateKey);
        if (!out.skipped) {
          console.log(
            `${LOG}[${userId}] 배수매수 주문 plan=${plan.id} qty=${out.qty} @${out.price} ` +
              `ok=${out.result?.success}`
          );
        } else if (out.reason && out.reason !== 'already_today' && out.reason !== 'ran_memory') {
          console.log(`${LOG}[${userId}] plan=${plan.id} skip=${out.reason}`);
        }
      } catch (err) {
        console.error(`${LOG}[${userId}] plan=${summary.id} 오류:`, err.message);
      }
    }
  }
};

const startInfiniteTradeScheduler = () => {
  if (started) return;
  started = true;
  // 매분 확인 — 플랜별 매수시간(KST)에만 실제 실행
  cron.schedule('* * * * *', () => {
    tick().catch((e) => console.error(`${LOG} tick:`, e.message));
  });
  console.log(
    `${LOG} 시작 (플랜별 매수시간, 기본 KR주식 ${DEFAULT_BUY_TIME.KR_STOCK} / KR ETF ${DEFAULT_BUY_TIME.KR_ETF} / US ${DEFAULT_BUY_TIME.US} KST)`
  );
};

module.exports = {
  startInfiniteTradeScheduler,
  runBandBuyForPlan,
  planSlot,
  planBuyTime,
  shouldRunPlanNow,
  DEFAULT_BUY_TIME,
};

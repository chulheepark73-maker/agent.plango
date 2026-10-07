/**
 * 자동매매 V2 감시 — trading_plans (status=active) 시세 기반
 * 지표기반은 indicatorWsMonitor (registry key: indicator)
 * 구독자 key: auto_v2 (키움 WS 레지스트리 공유)
 */

const wsRegistry = require('./kiwoomUserWsRegistry');
const { getKiwoomInfo } = require('../utils/kiwoomUtils');
const { getAllUsers } = require('../utils/userStore');
const { isNXTStock } = require('../utils/stockListStore');
const {
  isNXTTradingHours,
  isKRXSessionOpen,
  isPreMarketWarmup,
  isUsTradingHours,
  getUsSessionLabel,
} = require('../utils/stockUtils');
const { listTradingPlans, getTradingPlanById } = require('../utils/tradingV2Store');
const {
  executeTradingV2BuyOrder,
  executeTradingV2SellOrder,
  hasOpenOrderForStage,
  isV2OrderOnCooldown,
} = require('../utils/tradingV2OrderExec');
const { avgCostFromPlanFills, clampBuyBySeed, netFilledQtyForSplitStage, resolveSplitSellTarget } = require('../utils/infiniteTradeBands');
const { splitStagePosition } = require('../utils/splitTradeLots');
const { adjustSellPriceToTickSize } = require('../utils/priceUtils');
const { startBuyTrailingStop, buyTrailingStopIntervals } = require('../utils/autoTradingBuyTrailingStop');
const { startTrailingStop, trailingStopIntervals } = require('../utils/autoTradingTrailingStop');
const { encodeUsRegCode } = require('./kiwoomRealtimeClient');
const { normalizeAutoCode, isUsMarket } = require('../utils/autoTradingMarket');

const SUBSCRIBE_REFRESH_MS = 30000;
const OFF_MARKET_CHECK_MS = 60000;
const WARMUP_REFRESH_MS = 5000;
const TICK_DEBOUNCE_MS = 800;
const SUBSCRIBE_SOON_MS = 2000;
const REGISTRY_KEY = 'auto_v2';
const LOG = '[자동매매WS-V2]';

/** @type {Map<string, object>} */
const monitors = new Map();

let refreshTimer = null;
let soonRefreshTimer = null;
let started = false;

async function getValidUsers() {
  const users = await getAllUsers();
  const valid = [];
  for (const user of users) {
    try {
      const info = await getKiwoomInfo(user.id);
      if (info?.accessToken && info?.appKey && info?.appSecret && info?.accountNo) {
        valid.push(user);
      }
    } catch {
      /* skip */
    }
  }
  return valid;
}

function resolveStockMarket(plan) {
  const market = String(plan.instrument?.market || '').toUpperCase();
  if (market === 'US') return 'US';
  const exchange = String(plan.venue?.exchange || '').toUpperCase();
  if (exchange === 'NXT') return 'NXT';
  return 'KRX';
}

/**
 * 국내 감시·주문 시장: 08:00~08:50 은 stock_list_nxt 기준 NXT 가능 종목만(NXT), 그 외 시간은 KRX
 * @returns {Promise<'NXT'|'KRX'|null>} null = 이번 세션 감시 대상 아님
 */
async function resolveSessionKrMarket(stockCode, isNXTTime) {
  if (!isNXTTime) return 'KRX';
  return (await isNXTStock(stockCode)) ? 'NXT' : null;
}

/**
 * active trading_plan → 감시 타깃(매수/매도)
 * @returns {Array<object>}
 */
function buildWatchTargets(plan) {
  const symbol = String(plan.instrument?.symbol || '').trim();
  if (!symbol) return [];

  const stockMarket = resolveStockMarket(plan);
  const stockCode = normalizeAutoCode(symbol, stockMarket);
  const stockName = plan.instrument?.name || symbol;
  const cfg = plan.strategyConfig || {};
  const buyTrail =
    cfg.buyTrailingPercent != null && Number.isFinite(Number(cfg.buyTrailingPercent))
      ? Number(cfg.buyTrailingPercent)
      : 0.3;
  const sellTrail =
    cfg.sellTrailingPercent != null && Number.isFinite(Number(cfg.sellTrailingPercent))
      ? Number(cfg.sellTrailingPercent)
      : 0.3;

  const targets = [];

  if (plan.strategyType === 'INFINITE_TRADE') {
    const cycleId = plan.currentCycleId != null ? Number(plan.currentCycleId) : null;
    // 진입 여부는 접수된 주문까지 포함(재진입 방지), 매도는 실제 체결분만
    const { buyQty } = avgCostFromPlanFills(plan, { cycleId });
    const hasEntry = buyQty > 0;
    const { avgCost, remQty } = avgCostFromPlanFills(plan, { cycleId, includeSubmitted: false });

    // 1) 1회 entry — 체결 전 buyEntry trailing 매수
    if (!hasEntry) {
      const buyEntry = Number(cfg.buyEntry);
      const unitAmt = Number(cfg.unitBuyAmount);
      let qty =
        Number.isFinite(buyEntry) && buyEntry > 0 && Number.isFinite(unitAmt) && unitAmt > 0
          ? Math.floor(unitAmt / buyEntry)
          : 0;
      if (buyEntry > 0 && qty > 0) {
        const capped = clampBuyBySeed(
          plan,
          { price: buyEntry, qty, amount: buyEntry * qty },
          { cycleId }
        );
        if (!capped.ok) {
          // 시드 소진 — entry 미감시
          qty = 0;
        } else {
          qty = capped.qty;
        }
      }
      if (buyEntry > 0 && qty > 0 && !hasOpenOrderForStage(plan, 'BUY', null, cycleId)) {
        targets.push({
          side: 'BUY',
          stage: 1,
          stageId: null,
          cycleId,
          targetPrice: buyEntry,
          targetQty: qty,
          trailingPercent: buyTrail,
          planId: plan.id,
          strategyType: plan.strategyType,
          stockCode,
          stockName,
          stockMarket,
          exchange: plan.venue?.exchange || null,
          mode: 'entry',
        });
      }
    }

    // 2) 매도 — 평단 대비 sellTarget%(기본 10%) 이상이면 trailing (상시)
    if (hasEntry && remQty > 0 && avgCost > 0 && !hasOpenOrderForStage(plan, 'SELL', null, cycleId)) {
      const sellPct =
        cfg.sellTargetPercent != null && Number.isFinite(Number(cfg.sellTargetPercent))
          ? Number(cfg.sellTargetPercent)
          : 10;
      if (sellPct > 0) {
        targets.push({
          side: 'SELL',
          stage: 1,
          stageId: null,
          cycleId,
          targetPrice: adjustSellPriceToTickSize(avgCost * (1 + sellPct / 100), stockMarket),
          targetQty: remQty,
          trailingPercent: sellTrail,
          planId: plan.id,
          strategyType: plan.strategyType,
          stockCode,
          stockName,
          stockMarket,
          exchange: plan.venue?.exchange || null,
          mode: 'infinite_tp',
          avgCost,
        });
      }
    }

    // 스케줄 배수매수·시세용 — 포지션만 있어도 구독
    if (!targets.length && hasEntry && remQty > 0) {
      targets.push({
        side: 'WATCH',
        stage: 0,
        stageId: null,
        cycleId,
        targetPrice: 0,
        targetQty: 0,
        trailingPercent: 0,
        planId: plan.id,
        strategyType: plan.strategyType,
        stockCode,
        stockName,
        stockMarket,
        exchange: plan.venue?.exchange || null,
        mode: 'watch',
      });
    }
    return targets;
  }

  // SPLIT_TRADE
  // 매수: 잔량 0인 가장 낮은 대기 차수
  // - 앞 차수가 ordered/미체결이면 거기서 멈춤 (다음 차수 arm 금지)
  // - 잔량 있는 차수(보유중)는 건너뛰고 다음 매수 슬롯 탐색
  // 매도: 잔량 > 0인 가장 높은 차수 (그 차수에 붙인 stage_no 유지)
  const cycleId = plan.currentCycleId != null ? Number(plan.currentCycleId) : null;
  const stages = (plan.stages || []).filter((s) => !cycleId || Number(s.cycleId) === cycleId);

  const buyStages = stages
    .filter((s) => String(s.side).toUpperCase() === 'BUY')
    .sort((a, b) => Number(a.stage) - Number(b.stage));

  for (const buySt of buyStages) {
    const stageNo = Number(buySt.stage) || 1;
    const remQty = netFilledQtyForSplitStage(plan, stageNo, cycleId);
    // 이미 보유 중인 차수 → 다음 매수 슬롯 탐색
    if (remQty > 0) continue;

    const st = String(buySt.status || '').toLowerCase();
    const hasOpen = hasOpenOrderForStage(plan, 'BUY', buySt.id, cycleId);
    // 미체결/주문중이면 이 차수에서 대기 — 더 높은 차수 arm 금지
    if (st === 'ordered' || hasOpen) break;

    if (st !== 'pending') continue;

    const price = Number(buySt.targetPrice) || 0;
    const qty = Number(buySt.targetQty) || 0;
    if (price > 0 && qty > 0) {
      targets.push({
        side: 'BUY',
        stage: stageNo,
        stageId: buySt.id,
        cycleId: buySt.cycleId || cycleId,
        targetPrice: price,
        targetQty: qty,
        trailingPercent: buyTrail,
        planId: plan.id,
        strategyType: plan.strategyType,
        stockCode,
        stockName,
        stockMarket,
        exchange: plan.venue?.exchange || null,
      });
    }
    break;
  }

  // 매도: 잔량 있는 가장 높은 차수
  const sellPendings = stages
    .filter((s) => String(s.side).toUpperCase() === 'SELL' && s.status === 'pending')
    .sort((a, b) => Number(b.stage) - Number(a.stage));

  for (const sell of sellPendings) {
    const stageNo = Number(sell.stage) || 1;
    const buyFilled = stages.find(
      (s) =>
        String(s.side).toUpperCase() === 'BUY' &&
        Number(s.stage) === stageNo &&
        (s.status === 'filled' || netFilledQtyForSplitStage(plan, stageNo, cycleId) > 0)
    );
    if (!buyFilled && !(netFilledQtyForSplitStage(plan, stageNo, cycleId) > 0)) continue;
    const remQty = netFilledQtyForSplitStage(plan, stageNo, cycleId);
    if (!(remQty > 0)) continue;
    const buyPrice = Number(buyFilled?.targetPrice) || 0;
    const fillAvg = splitStagePosition(plan, stageNo, cycleId).avgPrice || buyPrice;
    const price = resolveSplitSellTarget(fillAvg || buyPrice, sell, stockMarket);
    const qty = remQty;
    if (price > 0 && qty > 0 && !hasOpenOrderForStage(plan, 'SELL', sell.id, cycleId)) {
      targets.push({
        side: 'SELL',
        stage: stageNo,
        stageId: sell.id,
        cycleId: sell.cycleId || cycleId,
        targetPrice: price,
        targetQty: qty,
        trailingPercent: sellTrail,
        planId: plan.id,
        strategyType: plan.strategyType,
        stockCode,
        stockName,
        stockMarket,
        exchange: plan.venue?.exchange || null,
      });
      break;
    }
  }

  return targets;
}

/**
 * @returns {Promise<Map<string, {stockName, stockMarket, exchange?, targets: object[]}>>}
 */
async function collectV2MonitorCodes(user, isKRXTime, isNXTTime, isUsTime) {
  /** @type {Map<string, {stockName:string, stockMarket:string, exchange?:string, targets: object[], priority?:number}>} */
  const codes = new Map();

  let plans = [];
  try {
    plans = await listTradingPlans(user.id, { status: 'active' });
  } catch (err) {
    console.error(`${LOG} 플랜 목록 실패 user=${user.id}:`, err.message);
    return codes;
  }

  for (const summary of plans) {
    let plan;
    try {
      plan = await getTradingPlanById(user.id, summary.id);
    } catch (err) {
      console.error(`${LOG} 플랜 상세 실패 id=${summary.id}:`, err.message);
      continue;
    }
    if (!plan || plan.status !== 'active') continue;

    const targets = buildWatchTargets(plan);
    if (!targets.length) continue;

    for (const t of targets) {
      const isUs = t.stockMarket === 'US' || isUsMarket(t.stockMarket, t.stockCode);
      if (isUs && !isUsTime) continue;
      if (!isUs) {
        if (!isNXTTime && !isKRXTime && !isPreMarketWarmup()) continue;
        const market = await resolveSessionKrMarket(t.stockCode, isNXTTime);
        if (!market) continue;
        t.stockMarket = market;
      }

      const codeKey = normalizeAutoCode(t.stockCode, t.stockMarket);
      if (!codeKey) continue;

      const prev = codes.get(codeKey);
      if (prev) {
        prev.targets.push(t);
      } else {
        codes.set(codeKey, {
          stockName: t.stockName,
          stockMarket: t.stockMarket,
          exchange: t.exchange || null,
          priority: wsRegistry.PRIORITY.POSITION,
          targets: [t],
        });
      }
    }
  }

  return codes;
}

function mergeTrailingSymbols(userId, codes) {
  try {
    const { getActiveBuyTrailingSymbols } = require('../utils/autoTradingBuyTrailingStop');
    const { getActiveSellTrailingSymbols } = require('../utils/autoTradingTrailingStop');
    const buyMap = getActiveBuyTrailingSymbols();
    const sellMap = getActiveSellTrailingSymbols();
    const lists = [
      ...(buyMap.get(String(userId)) || []),
      ...(sellMap.get(String(userId)) || []),
    ];
    for (const item of lists) {
      const market =
        item.stockMarket === 'US' || isUsMarket(item.stockMarket, item.stockCode)
          ? 'US'
          : item.stockMarket;
      const codeKey = normalizeAutoCode(item.stockCode, market);
      if (!codeKey) continue;
      const prev = codes.get(codeKey);
      codes.set(codeKey, {
        stockName: (prev && prev.stockName) || item.stockName || codeKey,
        stockMarket:
          market === 'US'
            ? 'US'
            : (prev && prev.stockMarket === 'NXT') || item.stockMarket === 'NXT'
              ? 'NXT'
              : (prev && prev.stockMarket) || item.stockMarket || 'KRX',
        exchange: (prev && prev.exchange) || item.exchange || null,
        priority: wsRegistry.PRIORITY.POSITION,
        targets: (prev && prev.targets) || [],
      });
    }
  } catch (err) {
    console.error(`${LOG} trailing 구독 병합 실패:`, err.message);
  }
  return codes;
}

function ensureMonitor(userId) {
  let m = monitors.get(userId);
  if (m) return m;

  m = {
    userId,
    kiwoomInfo: null,
    lastPrices: new Map(),
    metaByCode: new Map(),
    debounceTimers: new Map(),
    processingCodes: new Set(),
    client: null,
  };

  m.client = wsRegistry.acquire(userId, REGISTRY_KEY, {
    onTick: (tick) => onUserTick(m, tick),
    onOrder: (evt) => {
      // V2 주문만 처리 (레거시/지표 체결은 auto 모니터 onOrder가 담당)
      // auto 없어도 V2-only 사용자는 여기서 체결 수신
      const { tryCompleteTradingV2Fill } = require('../utils/tradingV2Fill');
      tryCompleteTradingV2Fill(m.userId, evt).catch((err) => {
        console.error(`${LOG}[${m.userId}] 주문체결 처리 오류:`, err.message);
      });
    },
    onStatus: (info) => {
      if (info.status === 'error') {
        console.error(`${LOG}[${userId}] ${info.message || info.status}`);
      } else if (info.status === 'subscribed' || info.status === 'kiwoom_connected') {
        console.log(`${LOG}[${userId}] ${info.status}${info.message ? ` ${info.message}` : ''}`);
      }
    },
  });

  monitors.set(userId, m);
  return m;
}

function destroyMonitor(userId) {
  const m = monitors.get(userId);
  if (!m) return;
  for (const t of m.debounceTimers.values()) clearTimeout(t);
  m.debounceTimers.clear();
  wsRegistry.release(userId, REGISTRY_KEY);
  monitors.delete(userId);
}

function destroyAllMonitors() {
  for (const userId of [...monitors.keys()]) {
    destroyMonitor(userId);
  }
}

function onUserTick(m, tick) {
  const raw = String(tick.stockCode || '').trim();
  if (!raw || !tick.price) return;

  const metaHint = m.metaByCode.get(raw) || m.metaByCode.get(raw.toUpperCase()) || {};
  const market = metaHint.stockMarket || (isUsMarket(null, raw) ? 'US' : 'KRX');
  const codeKey = normalizeAutoCode(raw, market);
  if (!codeKey) return;

  const meta = m.metaByCode.get(codeKey) || metaHint;
  const priceRow = {
    stockCode: codeKey,
    stockName: meta.stockName || codeKey,
    stockMarket: meta.stockMarket || market,
    price: tick.price,
    change: tick.change,
    changeRate: tick.changeRate,
    ts: Date.now(),
    targets: meta.targets || [],
  };
  m.lastPrices.set(codeKey, priceRow);

  try {
    const { onBuyTrailingPriceTick } = require('../utils/autoTradingBuyTrailingStop');
    const { onSellTrailingPriceTick } = require('../utils/autoTradingTrailingStop');
    onBuyTrailingPriceTick(m.userId, codeKey, tick.price).catch(() => {});
    onSellTrailingPriceTick(m.userId, codeKey, tick.price).catch(() => {});
  } catch {
    /* ignore */
  }

  const existing = m.debounceTimers.get(codeKey);
  if (existing) clearTimeout(existing);

  m.debounceTimers.set(
    codeKey,
    setTimeout(() => {
      m.debounceTimers.delete(codeKey);
      runChecksForTick(m, codeKey).catch((err) => {
        console.error(`${LOG}[${m.userId}] 처리 오류 ${codeKey}:`, err.message);
      });
    }, TICK_DEBOUNCE_MS)
  );
}

async function runChecksForTick(m, codeKey) {
  if (m.processingCodes.has(codeKey)) return;
  const priceRow = m.lastPrices.get(codeKey);
  if (!priceRow) return;

  let kiwoomInfo = m.kiwoomInfo;
  if (!kiwoomInfo?.accessToken) {
    const info = await getKiwoomInfo(m.userId);
    if (!info?.accessToken) return;
    kiwoomInfo = {
      accessToken: info.accessToken,
      appKey: info.appKey,
      appSecret: info.appSecret,
      accountNo: info.accountNo,
    };
    m.kiwoomInfo = kiwoomInfo;
  }

  // 메타의 targets가 비어 있으면 최신 active 플랜에서 재구성
  let targets = priceRow.targets || [];
  if (!targets.length) {
    const meta = m.metaByCode.get(codeKey);
    targets = meta?.targets || [];
  }

  if (!targets.length) {
    // 구독만 유지 중인 trailing 심볼 — 플랜 재조회
    try {
      const summaries = await listTradingPlans(m.userId, { status: 'active' });
      for (const s of summaries) {
        const plan = await getTradingPlanById(m.userId, s.id);
        if (!plan) continue;
        const built = buildWatchTargets(plan).filter(
          (t) => normalizeAutoCode(t.stockCode, t.stockMarket) === codeKey
        );
        for (const t of built) {
          if (t.stockMarket !== 'US' && !isUsMarket(t.stockMarket, t.stockCode)) {
            const market = await resolveSessionKrMarket(t.stockCode, isNXTTradingHours());
            if (!market) continue;
            t.stockMarket = market;
          }
          targets.push(t);
        }
      }
    } catch (err) {
      console.error(`${LOG}[${m.userId}] 타깃 재조회 실패:`, err.message);
      return;
    }
  }

  if (!targets.length) return;

  m.processingCodes.add(codeKey);
  try {
    const price = parseFloat(priceRow.price);
    if (!Number.isFinite(price) || price <= 0) return;

    const usOpen = isUsTradingHours();
    const krOpen = isKRXSessionOpen() || isNXTTradingHours();
    for (const t of targets) {
      if (t.side === 'WATCH') continue;
      // 화면 시세 구독으로 장외 틱이 들어와도 arm 하지 않음 (arm→세션종료 stop 반복 방지)
      const isUsTarget = t.stockMarket === 'US' || isUsMarket(t.stockMarket, t.stockCode);
      if (isUsTarget ? !usOpen : !krOpen) continue;
      if (t.planId && isV2OrderOnCooldown(t.side, t.planId)) continue;

      if (t.side === 'BUY' && price < t.targetPrice) {
        const checkKey = `${m.userId}_${t.stockCode}_${t.stage}_v2p${t.planId}`;
        if (buyTrailingStopIntervals.has(checkKey)) continue;
        if (t.planId) {
          const plan = await getTradingPlanById(m.userId, t.planId);
          if (!plan || hasOpenOrderForStage(plan, 'BUY', t.stageId, t.cycleId)) continue;
          if (t.stageId) {
            const st = (plan.stages || []).find((s) => Number(s.id) === Number(t.stageId));
            if (st && String(st.status) !== 'pending') continue;
          }
          // 캐시된 targets 는 최대 30초 stale — 무한매매 entry 는 체결 여부를 최신 플랜으로 재확인
          if (t.mode === 'entry') {
            const cid = t.cycleId ?? (plan.currentCycleId != null ? Number(plan.currentCycleId) : null);
            if (avgCostFromPlanFills(plan, { cycleId: cid }).buyQty > 0) continue;
          }
        }

        await startBuyTrailingStop(
          kiwoomInfo,
          m.userId,
          t.stockCode,
          t.stockName,
          t.stage,
          t.targetQty,
          t.stockMarket,
          price,
          t.trailingPercent,
          t.targetPrice,
          {
            checkKey,
            v2Meta: {
              planId: t.planId,
              stageId: t.stageId,
              cycleId: t.cycleId ?? null,
              mode: t.mode || null,
            },
            executeOrder: executeTradingV2BuyOrder,
          }
        );
        console.log(
          `${LOG}[${m.userId}] Buy trailing arm: ${t.stockCode} plan=${t.planId} ${t.strategyType} @${t.targetPrice}`
        );
      }

      if (t.side === 'SELL' && price > t.targetPrice) {
        const checkKey = `${m.userId}_${t.stockCode}_${t.stage}_v2p${t.planId}`;
        if (trailingStopIntervals.has(checkKey)) continue;
        if (t.planId) {
          const plan = await getTradingPlanById(m.userId, t.planId);
          if (!plan || hasOpenOrderForStage(plan, 'SELL', t.stageId, t.cycleId)) continue;
          if (t.stageId) {
            const st = (plan.stages || []).find((s) => Number(s.id) === Number(t.stageId));
            if (st && String(st.status) !== 'pending') continue;
          }
          // 분할: 같은 차수 BUY filled 일 때만 매도 arm (재오픈 후 BUY pending이면 스킵)
          if (String(plan.strategyType) === 'SPLIT_TRADE') {
            const stageNo = Number(t.stage);
            const buyFilled = (plan.stages || []).find(
              (s) =>
                String(s.side).toUpperCase() === 'BUY' &&
                Number(s.stage) === stageNo &&
                (!t.cycleId || Number(s.cycleId) === Number(t.cycleId)) &&
                String(s.status) === 'filled'
            );
            if (!buyFilled) continue;
          }
          // 잔량 없으면 매도 arm 금지 (전량 매도 직후 스테일 타깃 방지)
          let sellQty = Number(t.targetQty) || 0;
          try {
            const { avgCostFromPlanFills } = require('../utils/infiniteTradeBands');
            const cycleId =
              t.cycleId != null
                ? Number(t.cycleId)
                : plan.currentCycleId != null
                  ? Number(plan.currentCycleId)
                  : null;
            const { remQty } = avgCostFromPlanFills(plan, { cycleId, includeSubmitted: false });
            if (!(remQty > 0)) continue;
            sellQty = Math.min(sellQty > 0 ? sellQty : remQty, remQty);
          } catch (err) {
            // 잔량 확인 실패 시 스테일 arm 방지 (특히 분할 재오픈 직후)
            console.warn(
              `${LOG}[${m.userId}] Sell arm remQty 확인 실패 plan=${t.planId}: ${err.message}`
            );
            continue;
          }
          if (!(sellQty > 0)) continue;

          await startTrailingStop(
            kiwoomInfo,
            m.userId,
            t.stockCode,
            t.stockName,
            t.stage,
            sellQty,
            t.stockMarket,
            price,
            t.trailingPercent,
            t.targetPrice,
            {
              checkKey,
              v2Meta: { planId: t.planId, stageId: t.stageId, cycleId: t.cycleId ?? null },
              executeOrder: executeTradingV2SellOrder,
            }
          );
          console.log(
            `${LOG}[${m.userId}] Sell trailing arm: ${t.stockCode} plan=${t.planId} ${t.strategyType} @${t.targetPrice} qty=${sellQty}`
          );
          continue;
        }

        await startTrailingStop(
          kiwoomInfo,
          m.userId,
          t.stockCode,
          t.stockName,
          t.stage,
          t.targetQty,
          t.stockMarket,
          price,
          t.trailingPercent,
          t.targetPrice,
          {
            checkKey,
            v2Meta: { planId: t.planId, stageId: t.stageId, cycleId: t.cycleId ?? null },
            executeOrder: executeTradingV2SellOrder,
          }
        );
        console.log(
          `${LOG}[${m.userId}] Sell trailing arm: ${t.stockCode} plan=${t.planId} ${t.strategyType} @${t.targetPrice}`
        );
      }
    }
  } finally {
    m.processingCodes.delete(codeKey);
  }
}

async function refreshSubscriptions() {
  try {
    // 정규장·시간외종가·애프터 포함 — 15:30 미체결 취소 후에도 pending 감시는 유지
    const isKRXTime = isKRXSessionOpen();
    const isNXTTime = isNXTTradingHours();
    const isUsTime = isUsTradingHours();
    const isWarmup = !isKRXTime && !isNXTTime && isPreMarketWarmup();
    const isKrSession = isKRXTime || isNXTTime || isWarmup;

    if (!isKrSession && !isUsTime) {
      destroyAllMonitors();
      scheduleRefresh(OFF_MARKET_CHECK_MS);
      return;
    }

    const users = await getValidUsers();
    if (users.length === 0) {
      // 장중인데 대상이 없으면 토큰 만료·계좌번호 누락 등 곧 풀릴 수 있는 상황
      destroyAllMonitors();
      scheduleRefresh(OFF_MARKET_CHECK_MS);
      return;
    }

    const activeUserIds = new Set();

    for (const user of users) {
      require('../utils/tradingV2FillRestBackup')
        .resumeOpenTradingV2FillWatches(user.id)
        .catch((err) => console.error(`${LOG}[${user.id}] 체결감시 복구 실패:`, err.message));

      let codeMap = new Map();
      if (isKrSession || isUsTime) {
        codeMap = await collectV2MonitorCodes(user, isKRXTime, isNXTTime, isUsTime);
        codeMap = mergeTrailingSymbols(String(user.id), codeMap);
      }

      const userId = String(user.id);
      if (codeMap.size === 0) {
        destroyMonitor(userId);
        continue;
      }

      activeUserIds.add(userId);
      const m = ensureMonitor(userId);
      m.kiwoomInfo = await getKiwoomInfo(userId);
      m.metaByCode = codeMap;

      for (const code of [...m.lastPrices.keys()]) {
        if (!codeMap.has(code)) m.lastPrices.delete(code);
      }

      wsRegistry.setSymbols(
        userId,
        REGISTRY_KEY,
        [...codeMap.entries()].map(([code, meta]) => {
          if (meta.stockMarket === 'US') {
            return {
              code: encodeUsRegCode(code, meta.exchange || 'ND'),
              priority: meta.priority ?? wsRegistry.PRIORITY.POSITION,
            };
          }
          const code6 = String(code).substring(0, 6);
          const symbol = isNXTTime && meta.stockMarket === 'NXT' ? `${code6}_NX` : code6;
          return { code: symbol, priority: meta.priority ?? wsRegistry.PRIORITY.POSITION };
        }),
        wsRegistry.PRIORITY.POSITION
      );

      const sessionLabel = [
        getUsSessionLabel(),
        isNXTTime && !isKRXTime ? 'NXT' : isKRXTime ? 'KRX' : isWarmup ? 'warmup' : null,
      ]
        .filter(Boolean)
        .join('+');
      console.log(
        `${LOG}[${userId}] 구독 ${codeMap.size}종목 (${sessionLabel}): ${[...codeMap.keys()].join(', ')}`
      );
    }

    for (const userId of [...monitors.keys()]) {
      if (!activeUserIds.has(userId)) destroyMonitor(userId);
    }

    scheduleRefresh(isWarmup ? WARMUP_REFRESH_MS : SUBSCRIBE_REFRESH_MS);
  } catch (err) {
    console.error(`${LOG} 구독 갱신 오류:`, err.message);
    scheduleRefresh(OFF_MARKET_CHECK_MS);
  }
}

function scheduleRefresh(ms) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshSubscriptions();
  }, ms);
}

function requestSymbolRefreshSoon() {
  if (!started) return;
  if (soonRefreshTimer) clearTimeout(soonRefreshTimer);
  soonRefreshTimer = setTimeout(() => {
    soonRefreshTimer = null;
    refreshSubscriptions();
  }, SUBSCRIBE_SOON_MS);
}

function startAutoTradingWsMonitorV2() {
  if (started) return;
  started = true;
  console.log(
    `${LOG} 감시 시작 (trading_plans active, 시세=키움 WS, US프리·정규·애프터, 구독갱신=${SUBSCRIBE_REFRESH_MS / 1000}s, debounce=${TICK_DEBOUNCE_MS}ms)`
  );
  refreshSubscriptions();
}

function stopAutoTradingWsMonitorV2() {
  started = false;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (soonRefreshTimer) {
    clearTimeout(soonRefreshTimer);
    soonRefreshTimer = null;
  }
  destroyAllMonitors();
}

module.exports = {
  startAutoTradingWsMonitorV2,
  stopAutoTradingWsMonitorV2,
  requestSymbolRefreshSoon,
  requestSubscribeRefreshSoon: requestSymbolRefreshSoon,
  buildWatchTargets,
  getLastPrices(userId) {
    const uid = String(userId);
    const m = monitors.get(uid) || monitors.get(userId);
    if (!m?.lastPrices) return new Map();
    return m.lastPrices;
  },
};

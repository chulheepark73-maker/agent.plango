const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { getUserById } = require('../utils/userStore');
const kiwoomAPI = require('../services/kiwoomApi');
const { isNXTStock } = require('../utils/stockListStore');
const { getKiwoomInfo, validateKiwoomInfo } = require('../utils/kiwoomUtils');
const { isUsMarket, normalizeAutoCode, looksLikeUsTicker } = require('../utils/autoTradingMarket');
const {
  buildOrderStatuses,
  buildTrailingStatuses,
  buildStockNameMap,
} = require('../utils/dashboardStatusBuilders');
const { listTradingPlans, getTradingPlanById, listCompletedSellsFromTradingV2 } = require('../utils/tradingV2Store');
const { avgCostFromPlanFills, resolveSplitSellTarget } = require('../utils/infiniteTradeBands');
const { buildSplitLots } = require('../utils/splitTradeLots');
const { ensurePlanStatusTable, getPlanStatusByUserId } = require('../utils/planStatusStore');
const { calculateProfit } = require('../utils/profitUtils');
const { getBrokerFeeRates } = require('../utils/brokerCredentialsStore');
const { adjustSellPriceToTickSize, roundAvgCostForDisplay } = require('../utils/priceUtils');

const holdingCodeKey = (stockCode, stockMarket) => {
  const raw = String(stockCode || '').trim();
  if (!raw) return '';
  if (stockMarket === 'US' || isUsMarket(stockMarket, raw)) return raw.toUpperCase();
  return raw.substring(0, 6);
};

/** 매수일 YYYY-MM-DD (KST) */
const toBuyDateYmd = (raw) => {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(raw))) return String(raw).slice(0, 10);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const y = get('year');
  const m = get('month');
  const day = get('day');
  return y && m && day ? `${y}-${m}-${day}` : null;
};

const resolvePlanStockMarket = async (plan, marketCache) => {
  const market = String(plan.instrument?.market || '').toUpperCase();
  const symbol = String(plan.instrument?.symbol || '').trim();
  if (market === 'US' || isUsMarket(market, symbol)) return 'US';
  const exchange = String(plan.venue?.exchange || '').toUpperCase();
  if (exchange === 'NXT') return 'NXT';
  const code6 = symbol.substring(0, 6);
  if (!code6) return 'KRX';
  if (marketCache.has(code6)) return marketCache.get(code6);
  const isNXT = await isNXTStock(symbol);
  const resolved = isNXT ? 'NXT' : 'KRX';
  marketCache.set(code6, resolved);
  return resolved;
};

/**
 * Trading V2 trading_plans 기준 매수종목 (잔량 > 0)
 * - SPLIT: 차수별 BUY 잔량
 * - INFINITE: 평단·잔량 1행
 */
const buildHoldingsFromTradingV2 = async (userId) => {
  const uid = String(userId);
  const holdings = [];
  /** @type {Map<string, 'NXT'|'KRX'|'US'>} */
  const marketCache = new Map();

  let summaries = [];
  try {
    summaries = await listTradingPlans(uid);
  } catch (err) {
    console.warn('[보유종목] trading_plans 목록 실패:', err.message);
    return holdings;
  }

  for (const summary of summaries || []) {
    const status = String(summary.status || '').toLowerCase();
    if (status === 'draft' || status === 'cancelled') continue;

    let plan;
    try {
      plan = await getTradingPlanById(uid, summary.id);
    } catch {
      continue;
    }
    if (!plan) continue;

    const symbol = String(plan.instrument?.symbol || '').trim();
    if (!symbol) continue;
    const stockMarket = await resolvePlanStockMarket(plan, marketCache);
    const stockCode = normalizeAutoCode(symbol, stockMarket);
    const stockName = plan.instrument?.name || stockCode;
    const strategyType = String(plan.strategyType || '').toUpperCase();
    const planId = Number(plan.id);
    const cycleId = plan.currentCycleId != null ? Number(plan.currentCycleId) : null;
    const cfg = plan.strategyConfig || {};
    const base = {
      stockCode,
      stockName,
      stockMarket,
      planId,
      strategyType,
      planStatus: plan.status,
      source: 'v2',
    };

    if (strategyType === 'INFINITE_TRADE') {
      const { avgCost, remQty, cycleId: fillCycleId } = avgCostFromPlanFills(plan, {
        cycleId,
        includeSubmitted: false,
      });
      if (!(remQty > 0) || !(avgCost > 0)) continue;
      const sellPct =
        cfg.sellTargetPercent != null && Number.isFinite(Number(cfg.sellTargetPercent))
          ? Number(cfg.sellTargetPercent)
          : 10;
      const sellPriceRaw = sellPct > 0 ? avgCost * (1 + sellPct / 100) : 0;
      const sellPrice = sellPriceRaw > 0
        ? adjustSellPriceToTickSize(sellPriceRaw, stockMarket)
        : 0;
      const avgCostDisplay = roundAvgCostForDisplay(avgCost, stockMarket);
      const cid = fillCycleId != null ? fillCycleId : cycleId;

      const ordersAll = plan.orders || [];
      const orders =
        cid != null
          ? ordersAll.filter((o) => {
              if (o.cycleId != null) return Number(o.cycleId) === Number(cid);
              if (o.stageId != null) {
                const st = (plan.stages || []).find((s) => Number(s.id) === Number(o.stageId));
                return st && Number(st.cycleId) === Number(cid);
              }
              return false;
            })
          : ordersAll;
      const orderById = new Map(orders.map((o) => [Number(o.id), o]));
      // 부분체결(fills 여러 건)은 주문 1건 = 1행으로 합산
      const buyByOrder = new Map();
      for (const f of plan.fills || []) {
        const ord = orderById.get(Number(f.orderId));
        if (!ord || String(ord.side).toUpperCase() !== 'BUY') continue;
        const q = Math.floor(Number(f.fillQty) || 0);
        const p = Number(f.fillPrice) || 0;
        if (!(q > 0) || !(p > 0)) continue;
        const amt = Number(f.fillAmount) > 0 ? Number(f.fillAmount) : p * q;
        const at = f.filledAt || f.createdAt || null;
        const key = Number(f.orderId);
        const prev = buyByOrder.get(key);
        if (prev) {
          prev.qty += q;
          prev.amt += amt;
          if (at && (!prev.at || new Date(at) < new Date(prev.at))) prev.at = at;
        } else {
          buyByOrder.set(key, { qty: q, amt, at, orderNo: ord.brokerOrderNo || null });
        }
      }
      const buyFills = [...buyByOrder.values()]
        .map((r) => ({ qty: r.qty, price: r.amt / r.qty, at: r.at, orderNo: r.orderNo }))
        .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));

      // fills 없으면 주문 단위 폴백 1행
      const rows =
        buyFills.length > 0
          ? buyFills
          : [
              {
                qty: remQty,
                price: avgCost,
                at: plan.updatedAt,
                orderNo: null,
              },
            ];

      const lastIdx = rows.length - 1;
      rows.forEach((row, idx) => {
        const buyDate = toBuyDateYmd(row.at) || toBuyDateYmd(plan.updatedAt);
        const isLast = idx === lastIdx;
        holdings.push({
          ...base,
          stage: idx + 1,
          buy_price: roundAvgCostForDisplay(row.price, stockMarket),
          buy_qty: row.qty,
          sell_price: isLast ? sellPrice : null,
          orderNo: row.orderNo,
          buyDate,
          dateTime: row.at || buyDate || plan.updatedAt || new Date().toISOString(),
          // 마지막 매수일 행: 기대수익 칸에 평단가 표시
          avgCost: isLast ? avgCostDisplay : null,
          showAvgCostInProfit: isLast,
        });
      });
      continue;
    }

    // SPLIT_TRADE: 체결 로트 기준 차수별 잔량 (매도로 소진된 매수는 제외)
    const stages = (plan.stages || []).filter(
      (s) => cycleId == null || Number(s.cycleId) === cycleId
    );
    const { positions } = buildSplitLots(plan, { cycleId });
    const stageNosWithPos = new Set([...positions.keys()].filter((k) => k != null));
    const buyStageNos = stages
      .filter((s) => String(s.side).toUpperCase() === 'BUY')
      .map((s) => Number(s.stage))
      .sort((a, b) => a - b);

    for (const pos of [...positions.values()].sort(
      (a, b) => (Number(a.stage) || 0) - (Number(b.stage) || 0)
    )) {
      const qty = Math.floor(pos.qty);
      if (!(qty > 0) || !(pos.avgPrice > 0)) continue;
      const stageNo =
        pos.stage != null
          ? Number(pos.stage)
          : buyStageNos.find((n) => !stageNosWithPos.has(n)) || 1;
      const buySt = stages.find(
        (s) => String(s.side).toUpperCase() === 'BUY' && Number(s.stage) === stageNo
      );
      const sellSt = stages.find(
        (s) => String(s.side).toUpperCase() === 'SELL' && Number(s.stage) === stageNo
      );
      const sellPrice = resolveSplitSellTarget(pos.avgPrice, sellSt, stockMarket);
      const buyDate = toBuyDateYmd(pos.at) || toBuyDateYmd(plan.updatedAt);
      holdings.push({
        ...base,
        stage: stageNo,
        stageId: buySt?.id ?? null,
        buy_price: Math.round(pos.avgPrice * 100) / 100,
        buy_qty: qty,
        sell_price: Math.round((sellPrice || 0) * 100) / 100,
        orderNo: pos.orderNo || null,
        buyDate,
        dateTime: pos.at || plan.updatedAt || new Date().toISOString(),
      });
    }
  }

  return holdings;
};

const buildHoldingPrices = async (_kiwoomInfo, holdings, { userId } = {}) => {
  if (!holdings || holdings.length === 0) {
    return [];
  }

  const stockNameMap = await buildStockNameMap();
  const uniqueStockCodes = [];
  const seen = new Set();
  const marketByCode = new Map();
  for (const h of holdings) {
    const key = holdingCodeKey(h.stockCode, h.stockMarket);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueStockCodes.push(key);
    if (h.stockMarket) marketByCode.set(key, h.stockMarket);
  }

  // REST(ka10095) 사용 안 함 — lastPrices Map만
  const { buildPriceRowsFromLastPrices } = require('../services/watchlistPriceWsHub');
  return buildPriceRowsFromLastPrices(userId || '', uniqueStockCodes, {
    stockNameMap,
    marketByCode,
  });
};

const getKstNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));

const getWeekStartDateKst = (kstDate) => {
  // 월요일 시작(월:1 ~ 일:0)
  const date = new Date(kstDate);
  const day = date.getDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - diffToMonday);
  date.setHours(0, 0, 0, 0);
  return date;
};

const toNumber = (value) => {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

const pickFirstNumber = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = toNumber(obj[key]);
    if (value !== null) return value;
  }
  return null;
};

// 보유종목 목록 조회 (Trading V2 trading_plans 잔량 기준)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    console.log(`[보유종목] 사용자 ID: ${userId} - V2 조회 시작`);

    const holdings = await buildHoldingsFromTradingV2(userId);

    console.log(`[보유종목] V2 holdings 개수: ${holdings.length}`);
    res.json(holdings);
  } catch (error) {
    console.error('[보유종목] 목록 조회 실패:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      name: error.name,
      error: error
    });
    res.status(500).json({
      error: '보유종목 목록 조회 중 오류가 발생했습니다.',
      message: error.message || '알 수 없는 오류가 발생했습니다.'
    });
  }
});

// 보유종목 현재가 조회
router.get('/prices', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const holdings = await buildHoldingsFromTradingV2(userId);

    if (holdings.length === 0) {
      return res.json([]);
    }

    // lastPrices Map만 (ka10095 REST 사용 안 함)
    const prices = await buildHoldingPrices(null, holdings, { userId });
    return res.json(prices);
  } catch (error) {
    console.error('[보유종목] 현재가 조회 실패:', error);
    res.status(500).json({
      error: '보유종목 현재가 조회 중 오류가 발생했습니다.',
      message: error.message,
    });
  }
});


// Trade History 조회 (Trading V2 SELL 체결)
router.get('/trade-history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { year, month } = req.query; // 클라이언트에서 전달된 year와 month

    let userCompleted = await listCompletedSellsFromTradingV2(userId).catch((err) => {
      console.warn('[Trade History] V2 매도완료 조회 실패:', err.message);
      return [];
    });

    // year와 month 필터링
    if (year && month) {
      const y = parseInt(year, 10);
      const m = parseInt(month, 10);
      userCompleted = userCompleted.filter((item) => {
        const itemDate = new Date(item.createdAt);
        if (Number.isNaN(itemDate.getTime())) return false;
        return itemDate.getFullYear() === y && itemDate.getMonth() + 1 === m;
      });
    }
    
    // 종목명 매핑 (국내 + 미국)
    const { readStockListFile } = require('../utils/stockListStore');
    const { getUsStockByTicker } = require('../utils/usStockListStore');
    const stockList = await readStockListFile();
    const stockNameMap = new Map();
    stockList.forEach(stock => {
      if (stock.stockCode) {
        stockNameMap.set(stock.stockCode, stock.stockName || '');
        const code6 = String(stock.stockCode).substring(0, 6);
        if (code6) stockNameMap.set(code6, stock.stockName || '');
      }
    });

    const enrichedHistory = [];
    for (const item of userCompleted) {
      const code = String(item.stockCode || '').trim();
      let stockName =
        item.stockName ||
        stockNameMap.get(code) ||
        stockNameMap.get(code.substring(0, 6)) ||
        '';
      let stockMarket = item.stockMarket || null;
      if (!stockName && looksLikeUsTicker(code)) {
        stockMarket = 'US';
        try {
          const master = await getUsStockByTicker(code);
          stockName = master?.stockName || code.toUpperCase();
        } catch {
          stockName = code.toUpperCase();
        }
      }
      if (!stockName) stockName = code;
      enrichedHistory.push({
        ...item,
        stockCode: stockMarket === 'US' || looksLikeUsTicker(code) ? code.toUpperCase() : item.stockCode,
        stockName,
        stockMarket: stockMarket || (looksLikeUsTicker(code) ? 'US' : 'KRX'),
      });
    }
    
    // 날짜 순서로 정렬 (최신순)
    const sorted = enrichedHistory.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json(sorted);
  } catch (error) {
    console.error('[Trade History] 조회 실패:', error);
    res.status(500).json({
      error: 'Trade History 조회 중 오류가 발생했습니다.',
      message: error.message
    });
  }
});

// Plan 대비 진행사항 조회 (목표금액 대비 주간/월간/년간 수익)
router.get('/plan-progress', authenticateToken, async (req, res) => {
  try {
    const userId = String(req.user.userId);
    const plan = await getPlanStatusByUserId(userId);
    const goalsKr = {
      week: Number(plan.krWeek || 0),
      month: Number(plan.krMonth || 0),
      year: Number(plan.krYear || 0),
    };
    const goalsUs = {
      week: Number(plan.usWeek || 0),
      month: Number(plan.usMonth || 0),
      year: Number(plan.usYear || 0),
    };

    const userCompleted = await listCompletedSellsFromTradingV2(userId).catch((err) => {
      console.warn('[Plan Progress] V2 매도완료 조회 실패:', err.message);
      return [];
    });

    const nowKst = getKstNow();
    const todayStart = new Date(nowKst);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = getWeekStartDateKst(nowKst);
    const monthStart = new Date(nowKst.getFullYear(), nowKst.getMonth(), 1);
    const yearStart = new Date(nowKst.getFullYear(), 0, 1);

    const feeRates = await getBrokerFeeRates(userId);
    const accumulateProfits = (predicate) =>
      userCompleted.reduce(
        (acc, item) => {
          if (!predicate(item)) return acc;

          const buyPrice = parseFloat(item.buy_price || 0);
          const sellPrice = parseFloat(item.sell_price || 0);
          const sellQty = parseInt(item.sell_qty || 0, 10);
          const createdAt = new Date(item.createdAt);

          if (!Number.isFinite(buyPrice) || !Number.isFinite(sellPrice) || !Number.isFinite(sellQty)) {
            return acc;
          }
          if (sellQty <= 0 || Number.isNaN(createdAt.getTime())) {
            return acc;
          }

          const { profitAmount: profit } = calculateProfit({
            buyPrice,
            sellPrice,
            qty: sellQty,
            stockMarket: item.stockMarket || (looksLikeUsTicker(item.stockCode) ? 'US' : 'KRX'),
            feeRates,
          });
          if (createdAt >= weekStart && createdAt <= nowKst) acc.week += profit;
          if (createdAt >= monthStart && createdAt <= nowKst) acc.month += profit;
          if (createdAt >= yearStart && createdAt <= nowKst) acc.year += profit;
          if (createdAt >= todayStart && createdAt <= nowKst) acc.today += profit;
          return acc;
        },
        { week: 0, month: 0, year: 0, today: 0 }
      );

    const isUsCompleted = (item) => {
      const market = String(item.stockMarket || '').toUpperCase();
      if (market === 'US') return true;
      if (market === 'KRX' || market === 'NXT') return false;
      return looksLikeUsTicker(item.stockCode);
    };

    const krRaw = accumulateProfits((item) => !isUsCompleted(item));
    const usRaw = accumulateProfits((item) => isUsCompleted(item));

    const safePercent = (value, goal) => {
      const g = Number(goal || 0);
      if (g <= 0) return 0;
      return Math.max(0, Math.round((value / g) * 10000) / 100);
    };

    const buildProgressBlock = (rawProfits, goals) => {
      const profits = {
        today: Math.round(rawProfits.today),
        week: Math.round(rawProfits.week),
        month: Math.round(rawProfits.month),
        year: Math.round(rawProfits.year),
      };
      return {
        goals,
        profits,
        progress: {
          week: safePercent(profits.week, goals.week),
          month: safePercent(profits.month, goals.month),
          year: safePercent(profits.year, goals.year),
        },
      };
    };

    const cachedInvestable = getCachedInvestable(userId);
    const kr = { ...buildProgressBlock(krRaw, goalsKr), investable: cachedInvestable?.kr || null };
    const us = { ...buildProgressBlock(usRaw, goalsUs), investable: cachedInvestable?.us || null };

    return res.json({
      date: {
        year: nowKst.getFullYear(),
        month: nowKst.getMonth() + 1,
        day: nowKst.getDate(),
      },
      // 하위 호환: 기존 필드는 KR
      goals: kr.goals,
      profits: kr.profits,
      progress: kr.progress,
      investable: kr.investable,
      kr,
      us,
    });
  } catch (error) {
    console.error('[Plan Progress] 조회 실패:', error?.message || error);
    if (error?.stack) console.error(error.stack);
    return res.status(500).json({
      error: 'Plan 대비 진행사항 조회 중 오류가 발생했습니다.',
      message: error.message,
    });
  }
});

// Plan 카드의 투자가능금액(현금비중) — 키움 계좌 조회라 느려서 plan-progress 와 분리
router.get('/plan-investable', authenticateToken, async (req, res) => {
  try {
    const userId = String(req.user.userId);
    const force = req.query.force === '1';
    res.json(await getInvestable(userId, { force }));
  } catch (error) {
    console.error('[Plan Investable] 조회 실패:', error?.message || error);
    res.status(500).json({
      error: '투자가능금액 조회 중 오류가 발생했습니다.',
      message: error.message,
    });
  }
});

const INVESTABLE_CACHE_TTL_MS = 60 * 1000;
/** @type {Map<string, {at: number, value: {kr: object, us: object}}>} */
const investableCache = new Map();
/** @type {Map<string, Promise<{kr: object, us: object}>>} */
const investableInFlight = new Map();

function getCachedInvestable(userId) {
  const hit = investableCache.get(userId);
  if (!hit || Date.now() - hit.at > INVESTABLE_CACHE_TTL_MS) return null;
  return hit.value;
}

async function getInvestable(userId, { force = false } = {}) {
  if (!force) {
    const cached = getCachedInvestable(userId);
    if (cached) return cached;
  }
  if (investableInFlight.has(userId)) return investableInFlight.get(userId);
  const promise = computeInvestable(userId)
    .then((value) => {
      investableCache.set(userId, { at: Date.now(), value });
      return value;
    })
    .finally(() => investableInFlight.delete(userId));
  investableInFlight.set(userId, promise);
  return promise;
}

async function computeInvestable(userId) {
    let krInvestable = { amount: 0, total: 0, percent: 0 };
    let usInvestable = { amount: 0, total: 0, percent: 0 };

    try {
      const kiwoomInfo = await getKiwoomInfo(userId);
      const validationError = validateKiwoomInfo(kiwoomInfo);
      if (!validationError) {
        const [accountSettled, depositSettled, usDepositSettled, usLedgerSettled] =
          await Promise.allSettled([
            kiwoomAPI.getAccountInfo(
              kiwoomInfo.accessToken,
              kiwoomInfo.appKey,
              kiwoomInfo.appSecret,
              kiwoomInfo.accountNo
            ),
            kiwoomAPI.getKrDeposit(kiwoomInfo.accessToken, { qryTp: '3' }),
            kiwoomAPI.getUsDeposit(kiwoomInfo.accessToken),
            kiwoomAPI.getUsLedgerBalance(kiwoomInfo.accessToken, { stexTp: '', stkCd: '' }),
          ]);

        const accountInfo =
          accountSettled.status === 'fulfilled' ? accountSettled.value : null;
        const depositInfo =
          depositSettled.status === 'fulfilled' ? depositSettled.value : null;
        const usDeposit =
          usDepositSettled.status === 'fulfilled' ? usDepositSettled.value : null;
        const usLedger =
          usLedgerSettled.status === 'fulfilled' ? usLedgerSettled.value : null;

        if (depositSettled.status === 'rejected') {
          console.warn(
            '[Plan Progress] KR 예수금 조회 실패:',
            depositSettled.reason?.message || depositSettled.reason
          );
        }
        if (usDepositSettled.status === 'rejected') {
          console.warn(
            '[Plan Progress] US 예수금 조회 실패:',
            usDepositSettled.reason?.message || usDepositSettled.reason
          );
        }

        const totalAssetAmount =
          pickFirstNumber(accountInfo, ['prsm_dpst_aset_amt', 'tot_aset_amt']) || 0;
        const investableAmount = Math.max(
          0,
          pickFirstNumber(depositInfo, ['entr', 'd2_entra']) || 0
        );
        const krPercent =
          totalAssetAmount > 0
            ? Math.max(0, Math.min(100, (investableAmount / totalAssetAmount) * 100))
            : 0;
        krInvestable = {
          amount: Math.round(investableAmount),
          total: Math.round(totalAssetAmount),
          percent: Math.round(krPercent * 100) / 100,
        };

        if (usDeposit && typeof usDeposit === 'object') {
          const list = Array.isArray(usDeposit.result_list) ? usDeposit.result_list : [];
          let usCash = 0;
          for (const row of list) {
            if (!row || typeof row !== 'object') continue;
            usCash +=
              pickFirstNumber(row, ['fc_entra', 'frcr_amt', 'dpst', 'entra']) || 0;
          }
          let usEval = 0;
          const holdings = Array.isArray(usLedger?.holdings) ? usLedger.holdings : [];
          for (const h of holdings) {
            usEval += pickFirstNumber(h, ['evlt_amt', 'evlu_amt', 'eval_amt']) || 0;
          }
          if (!(usEval > 0)) {
            usEval =
              pickFirstNumber(usDeposit, ['tot_evlt_amt', 'tot_evlu_amt', 'evlt_amt']) || 0;
          }
          const usTotal = usCash + Math.max(0, usEval);
          const usPercent =
            usTotal > 0 ? Math.max(0, Math.min(100, (usCash / usTotal) * 100)) : 0;
          usInvestable = {
            amount: Math.round(usCash * 100) / 100,
            total: Math.round(usTotal * 100) / 100,
            percent: Math.round(usPercent * 100) / 100,
          };
        }

      }
    } catch (accountError) {
      console.warn('[Plan Progress] 현금비중 계산 실패:', accountError.message);
    }

    return { kr: krInvestable, us: usInvestable };
}

// Dashboard 초기 로딩용 스냅샷 조회 (holdings + prices + trailing status)
router.get('/dashboard-snapshot', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const holdings = await buildHoldingsFromTradingV2(userId);
    const orderStatuses = await buildOrderStatuses(userId);

    // 시세: lastPrices Map만 (REST 없음). 장중은 이후 WS로 갱신.
    const prices = await buildHoldingPrices(null, holdings, { userId });
    const trailingStatus = await buildTrailingStatuses(String(userId));

    res.json({
      timestamp: new Date().toISOString(),
      holdings,
      orderStatuses,
      prices,
      trailingStatus
    });
  } catch (error) {
    console.error('[Dashboard Snapshot] 조회 실패:', error);
    res.status(500).json({
      error: 'Dashboard Snapshot 조회 중 오류가 발생했습니다.',
      message: error.message
    });
  }
});

const TRAILING_LOG_EXPORT = {
  buy: { title: 'Trailing Buy Status', patterns: ['[Buy Trailing Stop]', 'Buy trailing arm'] },
  sell: { title: 'Trailing Sell Status', patterns: ['[Trailing Stop]', 'Sell trailing arm'] },
};

// 오늘(서버 로컬 날짜) 서버 로그에서 Trailing Buy/Sell 줄만 추출해 backend/data 에 저장
router.post('/trailing-log-export', authenticateToken, async (req, res) => {
  try {
    const side = String(req.body?.side || '').toLowerCase();
    const spec = TRAILING_LOG_EXPORT[side];
    if (!spec) return res.status(400).json({ error: "side 는 'buy' 또는 'sell' 이어야 합니다." });

    const fs = require('fs');
    const path = require('path');
    const readline = require('readline');
    const { LOG_DIR } = require('../utils/logger');

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const linePrefix = `[${ymd} `;

    // 자정을 넘겨 실행 중인 서버의 로그도 포함되도록 파일명이 아니라 수정시각으로 고른다
    const logFiles = (await fs.promises.readdir(LOG_DIR))
      .filter((name) => /^server_.*\.log$/.test(name))
      .map((name) => path.join(LOG_DIR, name))
      .filter((file) => fs.statSync(file).mtimeMs >= dayStart)
      .sort();

    const lines = [];
    for (const file of logFiles) {
      const rl = readline.createInterface({
        input: fs.createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.startsWith(linePrefix)) continue;
        if (spec.patterns.some((p) => line.includes(p))) lines.push(line);
      }
    }
    lines.sort();

    const fileName = `${spec.title}_${ymd}_${pad(now.getHours())}_${pad(now.getMinutes())}.txt`;
    const { DATA_DIR } = require('../utils/appPaths');
    const outPath = path.join(DATA_DIR, fileName);
    const header = `${spec.title} — ${ymd} (추출 ${now.toLocaleString('ko-KR')}, ${lines.length}건)\n\n`;
    const content = header + lines.join('\n') + (lines.length ? '\n' : '');
    await fs.promises.writeFile(outPath, content, 'utf8');

    res.json({ fileName, path: outPath, count: lines.length, content });
  } catch (error) {
    console.error('[Trailing Log Export] 실패:', error?.message || error);
    res.status(500).json({ error: '로그 추출 중 오류가 발생했습니다.', message: error.message });
  }
});

// Trailing Stop 진행 상태 조회
router.get('/trailing-status', authenticateToken, async (req, res) => {
  try {
    const userId = String(req.user.userId);
    const trailingStatus = await buildTrailingStatuses(userId);
    res.json(trailingStatus);
  } catch (error) {
    console.error('[Trailing Status] 조회 실패:', error);
    res.status(500).json({
      error: 'Trailing Status 조회 중 오류가 발생했습니다.',
      message: error.message
    });
  }
});

// 주문번호/체결 상태 조회
router.get('/order-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const orderStatuses = await buildOrderStatuses(userId);
    res.json(orderStatuses);
  } catch (error) {
    console.error('[Order Status] 조회 실패:', error);
    res.status(500).json({
      error: 'Order Status 조회 중 오류가 발생했습니다.',
      message: error.message
    });
  }
});

module.exports = router;


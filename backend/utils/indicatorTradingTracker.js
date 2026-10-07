/**
 * 지표기반매매 — 조건식 종목 트래킹·설정 기반 매수 평가
 */

const { getKiwoomInfo } = require('./kiwoomUtils');
const { fetchConditionSearch } = require('./kiwoomConditionList');
const {
  getIndicatorTrading,
  getTrackingStocks,
  saveTrackingStocks,
} = require('./indicatorTradingStore');
const {
  ensurePositionTables,
  summarizeActiveUsage,
  getActivePositionByCode,
  hasProfitableCloseToday,
  getActivePositionsMap,
  insertOrderLog,
  migrateBuysFromTrackingJson,
  stripOrderFieldsFromTracking,
  mergeTrackingWithPositions,
  hasUnfilledBuyPlace,
  getUnfilledBuyPlacesFromOrders,
} = require('./indicatorPositionStore');
const {
  hasPendingIndicatorBuy,
  countPendingIndicatorBuys,
  registerIndicatorBuyPending,
} = require('./indicatorBuyFill');

const placingLocks = new Set(); // `${userId}_${code6}`
const { computeBuyQtyFromAmount, adjustPriceToTickSize, getTickSize } = require('./priceUtils');
const { isNXTStock } = require('./stockListStore');
const { isTradingHours, isNXTTradingHours, isKRXAfterMarketHours, isKRXExtendedCloseHours } = require('./stockUtils');
const kiwoomAPI = require('../services/kiwoomApi');

/** HH:mm / H:mm / HH:mm:ss → 분 단위 (실패 시 null) */
const parseHmToMinutes = (raw) => {
  const m = String(raw || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
};

/** 현재 KST가 매수시간(시작~종료, 양끝 포함) 안인지 */
const isWithinBuyTimeWindow = (settings = {}) => {
  const startMin = parseHmToMinutes(settings.buyTimeStart ?? '15:00');
  const endMin = parseHmToMinutes(settings.buyTimeEnd ?? '15:20');
  if (startMin == null || endMin == null) {
    return { ok: false, reason: '매수시간 설정 오류' };
  }
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const nowMin = kst.getHours() * 60 + kst.getMinutes();
  if (startMin <= endMin) {
    if (nowMin >= startMin && nowMin <= endMin) return { ok: true, reason: '' };
  } else if (nowMin >= startMin || nowMin <= endMin) {
    // 자정 넘는 구간 (예: 23:00~01:00)
    return { ok: true, reason: '' };
  }
  const fmt = (n) =>
    `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return {
    ok: false,
    reason: `매수시간 외(${fmt(startMin)}~${fmt(endMin)} KST)`,
  };
};

const passesBuyFilters = () => ({ ok: true, reason: '' });

/** 실시간 시세를 이 시간 이상 못 받았으면 주문 기준가로 쓰지 않는다 */
const PRICE_MAX_AGE_MS = 15000;

/** 손절 후 재매수: 손절가 대비 이 비율 이하일 때만 (DB 컬럼 없이 tracking JSON + 메모리) */
const STOP_LOSS_REBUY_DROP_RATIO = 0.09;
/** @type {Map<string, number>} `${userId}:${code6}` → 재매수 가능 상한가 */
const stopRebuyBelowMem = new Map();
/** @type {Map<string, number>} 대기 로그 throttle */
const stopRebuySkipLogAt = new Map();
const STOP_REBUY_SKIP_LOG_MS = 30000;

const stopRebuyKeyOf = (userId, code6) => `${userId}:${code6}`;

const getStopRebuyBelow = (userId, code6, row = null) => {
  const fromRow = Number(row?.stopRebuyBelow);
  if (fromRow > 0) return fromRow;
  return stopRebuyBelowMem.get(stopRebuyKeyOf(userId, code6)) || 0;
};

/**
 * 손절 체결가 기준 재매수 상한가 저장 (tracking JSON, 스키마 변경 없음)
 * @returns {Promise<number|null>} 재매수가능가
 */
const setStopRebuyBelow = async (userId, stockCode, stopFillPrice, { stockName = '', seq = '' } = {}) => {
  const uid = String(userId);
  const code6 = String(stockCode || '').substring(0, 6);
  const stop = Math.round(Number(stopFillPrice) || 0);
  if (!code6 || !(stop > 0)) return null;

  const below = Math.max(1, Math.round(stop * (1 - STOP_LOSS_REBUY_DROP_RATIO)));
  stopRebuyBelowMem.set(stopRebuyKeyOf(uid, code6), below);

  const list = await getTrackingStocks(uid);
  const idx = list.findIndex((r) => String(r.stockCode || '').substring(0, 6) === code6);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = {
      ...stripOrderFieldsFromTracking(next[idx]),
      stopRebuyBelow: below,
      stopRebuyStopPrice: stop,
    };
    await saveTrackingStocks(uid, next);
  }

  try {
    const { addPendingBuy } = require('./indicatorPendingBuys');
    addPendingBuy(uid, code6, {
      stockCode: code6,
      stockName: stockName || list[idx]?.stockName || '',
      seq: seq || String(list[idx]?.buyConditionSeq || ''),
    });
  } catch {
    /* ignore */
  }

  return below;
};

const clearStopRebuyBelow = async (userId, stockCode) => {
  const uid = String(userId);
  const code6 = String(stockCode || '').substring(0, 6);
  if (!code6) return;
  stopRebuyBelowMem.delete(stopRebuyKeyOf(uid, code6));
  stopRebuySkipLogAt.delete(stopRebuyKeyOf(uid, code6));

  const list = await getTrackingStocks(uid);
  const idx = list.findIndex((r) => String(r.stockCode || '').substring(0, 6) === code6);
  if (idx < 0) return;
  if (list[idx].stopRebuyBelow == null && list[idx].stopRebuyStopPrice == null) return;
  const next = [...list];
  const row = { ...stripOrderFieldsFromTracking(next[idx]) };
  delete row.stopRebuyBelow;
  delete row.stopRebuyStopPrice;
  next[idx] = row;
  await saveTrackingStocks(uid, next);
};

/** 재시작 후 tracking JSON의 손절재매수 대기 → 메모리·시세대기큐 복구 */
const hydrateStopRebuyPendings = async (userId) => {
  const uid = String(userId);
  const state = await getIndicatorTrading(uid);
  if (!state.autoTradingEnabled) return 0;

  const seq = String(state.settings?.buyCondition ?? '').trim();
  const list = await getTrackingStocks(uid);
  let n = 0;
  const { addPendingBuy } = require('./indicatorPendingBuys');

  for (const row of list) {
    const below = Number(row.stopRebuyBelow);
    if (!(below > 0)) continue;
    const code6 = String(row.stockCode || '').substring(0, 6);
    if (!code6) continue;
    stopRebuyBelowMem.set(stopRebuyKeyOf(uid, code6), below);
    addPendingBuy(uid, code6, {
      stockCode: code6,
      stockName: row.stockName || '',
      seq: seq || String(row.buyConditionSeq || ''),
    });
    n += 1;
  }
  if (n > 0) {
    console.log(`[지표기반매매][${uid}] 손절 후 재매수 대기 ${n}건 복구`);
  }
  return n;
};

/**
 * 주문 기준가 결정
 * 1) 키움 WS 실시간 시세 (신선한 경우)
 * 2) 조건검색 편입 이벤트·스냅샷으로 방금 받은 가격(priceFresh)
 * 저장된 트래킹 가격은 장중에 낡을 수 있어 단독으로는 쓰지 않는다.
 * @returns {number} 0이면 확인 불가
 */
const resolveOrderBasePrice = (userId, code6, row, priceFresh) => {
  try {
    const { getLastPrices } = require('../services/indicatorWsMonitor');
    const cached = getLastPrices(userId)?.get(code6);
    if (cached?.price > 0) {
      const age = cached.ts ? Date.now() - cached.ts : Infinity;
      if (age <= PRICE_MAX_AGE_MS) return Number(cached.price);
    }
  } catch {
    /* ignore */
  }

  const rowPrice = Number(row?.price);
  if (priceFresh && rowPrice > 0) return rowPrice;

  return 0;
};

/**
 * 단일 트래킹 종목 매수 시도 (조건검색 편입·스냅샷 공통)
 * @returns {Promise<{ placed: boolean, log: string }>}
 */
const tryIndicatorBuyForStock = async (
  userId,
  row,
  {
    settings,
    seq,
    kiwoomInfo,
    holdingState,
    priceFresh = false,
    bypassBuyTimeWindow = false,
    forceMarketOrder = false,
  } = {}
) => {
  const code6 = String(row.stockCode || '').substring(0, 6);
  const lockKey = `${userId}_${code6}`;

  const existingPos = await getActivePositionByCode(userId, row.stockCode);
  if (existingPos) {
    return { placed: false, log: `[${row.stockCode}] 이미 활성 포지션` };
  }
  if (hasPendingIndicatorBuy(userId, row.stockCode)) {
    return { placed: false, log: `[${row.stockCode}] 매수 체결 대기 중` };
  }
  if (await hasProfitableCloseToday(userId, row.stockCode)) {
    return { placed: false, log: `[${row.stockCode}] 주문 스킵: 당일 익절 완료 (재매수 금지)` };
  }
  if (
    holdingState.pendingCodes.has(code6) ||
    (await hasUnfilledBuyPlace(userId, row.stockCode))
  ) {
    return { placed: false, log: `[${row.stockCode}] 미체결 매수 존재` };
  }
  if (placingLocks.has(lockKey)) {
    return { placed: false, log: `[${row.stockCode}] 매수 처리 중` };
  }

  if (!bypassBuyTimeWindow) {
    const buyTime = isWithinBuyTimeWindow(settings || {});
    if (!buyTime.ok) {
      return { placed: false, log: `[${row.stockCode}] 주문 스킵: ${buyTime.reason}` };
    }
  }

  const filter = passesBuyFilters(row, settings);
  if (!filter.ok) {
    return { placed: false, log: `[${row.stockCode}] 필터 불통과: ${filter.reason}` };
  }

  const venue = await resolveTradeVenue(row.stockCode);
  row.stockMarket = venue.stockMarket;
  if (!venue.ok) {
    return { placed: false, log: `[${row.stockCode}] 주문 스킵: ${venue.reason}` };
  }

  const maxHold = Math.max(0, Number(settings.maxHoldingStocks) || 5);
  if (holdingState.holdingCount >= maxHold) {
    return { placed: false, log: `[${row.stockCode}] 주문 스킵: 최대 보유 ${maxHold}종목` };
  }

  const orderPriceBase = resolveOrderBasePrice(userId, code6, row, priceFresh);
  if (!(orderPriceBase > 0)) {
    const { addPendingBuy } = require('./indicatorPendingBuys');
    const queued = addPendingBuy(userId, code6, {
      stockCode: row.stockCode,
      stockName: row.stockName,
      seq,
    });
    return {
      placed: false,
      log: queued
        ? `[${row.stockCode}] 시세 대기 등록: 실시간 시세 없음 — 첫 틱 수신 시 매수 재시도`
        : `[${row.stockCode}] 시세 대기 중: 실시간 시세 없음`,
    };
  }
  row.price = orderPriceBase;

  // 손절 후 재매수: 손절가 대비 -9% 이하일 때만
  let rebuyBelow = getStopRebuyBelow(userId, code6, row);
  if (!(rebuyBelow > 0)) {
    try {
      const list = await getTrackingStocks(userId);
      const hit = list.find((r) => String(r.stockCode || '').substring(0, 6) === code6);
      rebuyBelow = getStopRebuyBelow(userId, code6, hit);
      if (rebuyBelow > 0) {
        row.stopRebuyBelow = rebuyBelow;
        row.stopRebuyStopPrice = hit?.stopRebuyStopPrice;
      }
    } catch {
      /* ignore */
    }
  }
  if (rebuyBelow > 0 && orderPriceBase > rebuyBelow) {
    const { addPendingBuy } = require('./indicatorPendingBuys');
    addPendingBuy(userId, code6, {
      stockCode: row.stockCode,
      stockName: row.stockName,
      seq,
    });
    const sk = stopRebuyKeyOf(userId, code6);
    const now = Date.now();
    const last = stopRebuySkipLogAt.get(sk) || 0;
    if (now - last >= STOP_REBUY_SKIP_LOG_MS) {
      stopRebuySkipLogAt.set(sk, now);
      return {
        placed: false,
        log:
          `[${row.stockCode}] 손절 후 재매수 대기: 현재 ${orderPriceBase} > ` +
          `기준 ${rebuyBelow} (손절가 −${STOP_LOSS_REBUY_DROP_RATIO * 100}%)`,
      };
    }
    return { placed: false, log: '' };
  }

  const buyAmount = Number(settings.buyAmountKrw) || 0;
  const maxUsage = Number(settings.maxUsageAmountKrw) || 0;
  if (maxUsage > 0 && holdingState.usedAmount + buyAmount > maxUsage) {
    return { placed: false, log: `[${row.stockCode}] 주문 스킵: 최대사용금액 초과` };
  }

  /** 분할매수: 기준틱 30%, 기준-3틱 30%, 기준-6틱 40% — 시장가 강제 시 분할 없음 */
  const baseTick = Number(settings.buyLimitTickOffset) || 0;
  const useSplit = !!settings.useSplitBuy && !forceMarketOrder;
  const splitLegs = useSplit
    ? [
        { tickOffset: baseTick, amountRatio: 0.3, label: '기준틱 30%' },
        { tickOffset: baseTick - 3, amountRatio: 0.3, label: '-3틱추가 30%' },
        { tickOffset: baseTick - 6, amountRatio: 0.4, label: '-3틱추가 40%' },
      ]
    : [{ tickOffset: baseTick, amountRatio: 1, label: '전액' }];

  let allocatedAmt = 0;
  const legs = splitLegs.map((leg, i) => {
    const amount =
      i === splitLegs.length - 1
        ? Math.max(0, buyAmount - allocatedAmt)
        : Math.floor(buyAmount * leg.amountRatio);
    allocatedAmt += amount;
    return { ...leg, amount };
  });

  placingLocks.add(lockKey);
  const placedLogs = [];
  let anyPlaced = false;
  let totalPlacedAmount = 0;

  try {
    for (let i = 0; i < legs.length; i += 1) {
      const leg = legs[i];
      if (!(leg.amount > 0)) continue;

      let orderPrice = orderPriceBase;
      let priceType = 'limit';
      if (forceMarketOrder) {
        priceType = 'market';
      } else {
        const tick = getTickSize(orderPriceBase);
        orderPrice = adjustPriceToTickSize(orderPriceBase + leg.tickOffset * tick);
      }
      if (!(orderPrice > 0)) {
        placedLogs.push(`[${row.stockCode}] 분할${i + 1} 스킵: 가격 산출 불가 (${leg.label})`);
        continue;
      }

      const qty = computeBuyQtyFromAmount(leg.amount, orderPrice);
      if (!qty) {
        placedLogs.push(
          `[${row.stockCode}] 분할${i + 1} 스킵: 수량 불가 ${leg.amount}원@${orderPrice} (${leg.label})`
        );
        continue;
      }

      try {
        const orderRes = await kiwoomAPI.placeOrder(
          {
            symbol: row.stockCode,
            orderType: 'buy',
            quantity: qty,
            priceType,
            price: orderPrice,
          },
          kiwoomInfo.accessToken,
          kiwoomInfo.appKey,
          kiwoomInfo.appSecret,
          kiwoomInfo.accountNo,
          venue.market
        );
        const orderNo =
          orderRes?.ord_no || orderRes?.order_no || orderRes?.ODNO || orderRes?.data?.ord_no || '';

        await insertOrderLog(userId, {
          positionId: null,
          stockCode: row.stockCode,
          side: 'buy',
          action: 'place',
          venue: venue.market,
          priceType,
          orderPrice,
          qty,
          orderNo,
          rawMessage: useSplit
            ? `awaiting_fill_split_${i + 1}_${leg.label}`
            : 'awaiting_fill_no_position_yet',
        });

        if (orderNo) {
          registerIndicatorBuyPending({
            kiwoomInfo,
            userId,
            stockCode: row.stockCode,
            stockName: row.stockName,
            venue: venue.market,
            buyConditionSeq: seq,
            orderNo,
            orderPrice,
            buyQty: qty,
            buyAmount: leg.amount,
            priceType,
          });
        }

        anyPlaced = true;
        totalPlacedAmount += leg.amount;
        placedLogs.push(
          `[${row.stockCode}] 매수 접수(${leg.label}) market=${venue.market} ` +
            `틱${leg.tickOffset >= 0 ? '+' : ''}${leg.tickOffset} qty=${qty} price=${orderPrice} ` +
            `amt=${leg.amount} ord=${orderNo || '-'}`
        );
      } catch (err) {
        const msg = err.message || '주문 실패';
        if (String(msg).includes('uq_indicator_pos_open')) {
          placedLogs.push(`[${row.stockCode}] 이미 활성 포지션 존재`);
          break;
        }
        placedLogs.push(`[${row.stockCode}] 분할${i + 1} 실패(${leg.label}): ${msg}`);
      }

      if (i < legs.length - 1) {
        await new Promise((r) => setTimeout(r, 120));
      }
    }

    if (!anyPlaced) {
      return {
        placed: false,
        log: placedLogs.join(' | ') || `[${row.stockCode}] 매수 주문 없음`,
      };
    }

    holdingState.holdingCount += 1;
    holdingState.usedAmount += totalPlacedAmount > 0 ? totalPlacedAmount : buyAmount;
    holdingState.pendingCodes.add(code6);

    if (rebuyBelow > 0) {
      await clearStopRebuyBelow(userId, code6).catch(() => {});
    }

    return {
      placed: true,
      log: placedLogs.join(' | '),
    };
  } finally {
    placingLocks.delete(lockKey);
  }
};

const createBuyHoldingState = async (userId) => {
  const pending = countPendingIndicatorBuys(userId);
  const unfilledDb = await getUnfilledBuyPlacesFromOrders(userId);
  const pendingCodes = new Set();
  for (const p of unfilledDb) pendingCodes.add(String(p.stockCode).substring(0, 6));
  const { holdingCount, usedAmount } = await summarizeActiveUsage(userId);
  return {
    holdingCount: holdingCount + pending.pendingCount + pendingCodes.size,
    usedAmount: usedAmount + pending.pendingUsedAmount,
    pendingCodes,
  };
};

/**
 * 주문 거래소 결정
 * - NXT 오전(08:00~08:50) + NXT 종목: NXT 주문
 * - KRX 정규(09:00~15:30) · 시간외 종가(15:30~16:00) · 애프터(16:00~20:00): 전 종목 KRX
 * - NXT 오전·NXT 미지원 종목: 스킵
 * - 그 외: 거래시간 아님
 */
const resolveTradeVenue = async (stockCode) => {
  const isNxtListed = await isNXTStock(stockCode);
  const stockMarket = isNxtListed ? 'NXT' : 'KRX';
  const nxtOpen = isNXTTradingHours();

  if (nxtOpen) {
    if (isNxtListed) {
      return { ok: true, market: 'NXT', stockMarket, reason: '' };
    }
    return {
      ok: false,
      market: 'KRX',
      stockMarket,
      reason: 'NXT장시간·NXT미지원종목',
    };
  }

  if (isTradingHours() || isKRXExtendedCloseHours() || isKRXAfterMarketHours()) {
    return { ok: true, market: 'KRX', stockMarket, reason: '' };
  }

  return {
    ok: false,
    market: stockMarket,
    stockMarket,
    reason: '거래시간 아님',
  };
};

/** 감시 목록 전용 필드 (주문/포지션은 DB 테이블) */
const buildTrackingRow = (stock, prev = null, conditionSeq = '', stockMarket = 'KRX') => {
  const nowIso = new Date().toISOString();
  // 검색식 편입 시각: 신규·재편입 시 now, 기존은 유지 (없으면 updatedAt으로 1회 보정)
  const enteredAt =
    prev?.enteredAt || stock.enteredAt || prev?.updatedAt || nowIso;
  return {
    stockCode: stock.stockCode,
    stockName: stock.stockName || prev?.stockName || '',
    stockMarket: stockMarket || prev?.stockMarket || 'KRX',
    price: stock.price ?? prev?.price ?? null,
    dailyMa: prev?.dailyMa ?? null,
    minuteMa: prev?.minuteMa ?? null,
    buyConditionSeq: conditionSeq || prev?.buyConditionSeq || '',
    source: stock.source || prev?.source || null,
    stopRebuyBelow: stock.stopRebuyBelow ?? prev?.stopRebuyBelow ?? null,
    stopRebuyStopPrice: stock.stopRebuyStopPrice ?? prev?.stopRebuyStopPrice ?? null,
    enteredAt,
    updatedAt: nowIso,
  };
};

/** 조건식 변경 시에도 수동(source=manual) prev는 유지 */
const prevForRebuild = (prev, sameCondition) => {
  if (!prev) return null;
  if (sameCondition) return prev;
  if (prev.source === 'manual') return prev;
  return null;
};

/**
 * 종목명/코드로 수동 트래킹 추가 (source=manual, DB 스키마 변경 없음)
 * 자동매매 ON이면 기존 설정으로 매수 시도
 */
const addManualTrackingStock = async (userId, { stockCode, stockName } = {}) => {
  const uid = String(userId);
  const code6 = String(stockCode || '').substring(0, 6);
  const name = String(stockName || '').trim();
  if (!code6) {
    throw new Error('종목코드가 없습니다.');
  }

  const state = await getIndicatorTrading(uid);
  const settings = state.settings || {};
  const maxTrack = Math.max(1, Number(settings.maxTrackingStocks) || 90);
  const seq = String(settings.buyCondition ?? '').trim();

  const list = await getTrackingStocks(uid);
  const idx = list.findIndex((r) => String(r.stockCode || '').substring(0, 6) === code6);
  if (idx >= 0) {
    const existing = list[idx];
    // 이미 있으면 manual 플래그만 보강
    if (existing.source !== 'manual') {
      const next = [...list];
      next[idx] = stripOrderFieldsFromTracking({
        ...existing,
        source: 'manual',
        stockName: name || existing.stockName,
      });
      await saveTrackingStocks(uid, next);
    }
    const merged = await mergeTrackingWithPositions(uid, await getTrackingStocks(uid));
    return {
      stock: merged.find((r) => String(r.stockCode).substring(0, 6) === code6) || existing,
      already: true,
      buyLog: null,
    };
  }

  if (list.length >= maxTrack) {
    throw new Error(`최대 트래킹 ${maxTrack}종목을 초과했습니다.`);
  }

  const isNxt = await isNXTStock(code6);
  const row = stripOrderFieldsFromTracking(
    buildTrackingRow(
      { stockCode: code6, stockName: name || code6, source: 'manual' },
      null,
      seq,
      isNxt ? 'NXT' : 'KRX'
    )
  );
  await saveTrackingStocks(uid, [...list, row]);

  try {
    const { requestSymbolRefreshSoon } = require('../services/indicatorWsMonitor');
    requestSymbolRefreshSoon();
  } catch {
    /* ignore */
  }

  let buyLog = null;
  if (state.autoTradingEnabled) {
    const kiwoomInfo = await getKiwoomInfo(uid);
    if (kiwoomInfo?.accessToken) {
      const holdingState = await createBuyHoldingState(uid);
      const result = await tryIndicatorBuyForStock(uid, row, {
        settings,
        seq,
        kiwoomInfo,
        holdingState,
        priceFresh: false,
      });
      buyLog = result.log || null;
      if (buyLog) {
        console.log(`[지표기반매매][${uid}] 수동추가 매수: ${buyLog}`);
      }
    }
  }

  const merged = await mergeTrackingWithPositions(uid, await getTrackingStocks(uid));
  return {
    stock: merged.find((r) => String(r.stockCode).substring(0, 6) === code6) || row,
    already: false,
    buyLog,
  };
};

/**
 * 수동 트래킹 삭제
 * - open/selling(체결·보유·매도중) → 거부
 * - 미체결 매수 있으면 키움 취소 후 목록에서 제거
 */
const removeManualTrackingStock = async (userId, stockCode) => {
  const uid = String(userId);
  const code6 = String(stockCode || '').substring(0, 6);
  if (!code6) {
    throw new Error('종목코드가 없습니다.');
  }

  const list = await getTrackingStocks(uid);
  const hit = list.find((r) => String(r.stockCode || '').substring(0, 6) === code6);
  if (!hit) {
    throw new Error('트래킹 목록에 없는 종목입니다.');
  }
  if (hit.source !== 'manual') {
    throw new Error('수동 추가 종목만 삭제할 수 있습니다.');
  }

  const pos = await getActivePositionByCode(uid, code6);
  if (pos && (pos.status === 'open' || pos.status === 'selling')) {
    const err = new Error(
      '체결 완료(보유) 종목은 삭제할 수 없습니다. 매도 완료 후 삭제하세요.'
    );
    err.code = 'HOLDING_BLOCKED';
    throw err;
  }

  const { cancelPendingIndicatorBuys } = require('./indicatorBuyFill');
  const cancelResult = await cancelPendingIndicatorBuys(uid, {
    stockCode: code6,
    reason: 'manual_remove',
    rawMessage: '수동 트래킹 삭제 — 미체결 매수 취소',
  });

  const { cancelPendingBuyPositionsForCode } = require('./indicatorPositionStore');
  await cancelPendingBuyPositionsForCode(uid, code6, 'manual_remove');

  try {
    const { removePendingBuy } = require('./indicatorPendingBuys');
    removePendingBuy(uid, code6);
  } catch {
    /* ignore */
  }

  await clearStopRebuyBelow(uid, code6);

  const next = list.filter((r) => String(r.stockCode || '').substring(0, 6) !== code6);
  await saveTrackingStocks(uid, next.map(stripOrderFieldsFromTracking));

  try {
    const { requestSymbolRefreshSoon } = require('../services/indicatorWsMonitor');
    requestSymbolRefreshSoon();
  } catch {
    /* ignore */
  }

  console.log(
    `[지표기반매매][${uid}] 수동 삭제 ${code6}` +
      (cancelResult.total
        ? ` (매수취소 ${cancelResult.cancelled}/${cancelResult.total})`
        : '')
  );

  const stocks = await mergeTrackingWithPositions(uid, next);
  return {
    removed: true,
    stockCode: code6,
    stockName: hit.stockName || code6,
    cancelResult,
    stocks,
  };
};

/**
 * 조건식 종목(스냅샷·트래킹 목록)에 대해 매수 시도
 * @returns {Promise<string[]>} 로그 메시지 배열
 */
const attemptBuysForStocks = async (userId, stocks, seq, { priceFresh = false } = {}) => {
  const uid = String(userId);
  const state = await getIndicatorTrading(uid);
  if (!state.autoTradingEnabled) return [];

  const kiwoomInfo = await getKiwoomInfo(uid);
  if (!kiwoomInfo?.accessToken) return [];

  const settings = state.settings || {};
  const holdingState = await createBuyHoldingState(uid);
  const logs = [];
  const prevList = await getTrackingStocks(uid);
  const prevByCode = new Map(
    prevList.map((r) => [String(r.stockCode || '').substring(0, 6), r])
  );

  for (const s of stocks || []) {
    const code6 = String(s.stockCode || '').substring(0, 6);
    if (!code6) continue;
    const isNxt = await isNXTStock(s.stockCode);
    const row = buildTrackingRow(s, prevByCode.get(code6) || null, seq, isNxt ? 'NXT' : 'KRX');
    const result = await tryIndicatorBuyForStock(uid, row, {
      settings,
      seq,
      kiwoomInfo,
      holdingState,
      priceFresh,
    });
    if (result.placed) {
      const { removePendingBuy } = require('./indicatorPendingBuys');
      removePendingBuy(uid, code6);
    }
    if (result.log) logs.push(result.log);
  }
  return logs;
};

/**
 * 시세 대기 큐에 있던 종목의 첫 틱이 도착했을 때 호출 — 매수 재시도
 * 큐에서 꺼내면서 제거하므로 연속 틱에도 한 번만 실행된다.
 * @returns {Promise<string[]>} 로그 메시지 배열 (재시도 대상이 아니면 빈 배열)
 */
const retryPendingBuyOnTick = async (userId, code6) => {
  const { takePendingBuy, addPendingBuy } = require('./indicatorPendingBuys');
  const entry = takePendingBuy(userId, code6);
  if (!entry) return [];

  try {
    return await attemptBuysForStocks(
      userId,
      [{ stockCode: entry.stockCode, stockName: entry.stockName }],
      entry.seq,
      { priceFresh: true }
    );
  } catch (err) {
    // 일시적 오류면 다음 틱에 다시 시도할 수 있도록 큐에 되돌린다
    addPendingBuy(userId, code6, entry);
    throw err;
  }
};

/**
 * 저장된 매수조건으로 종목 불러오기 + (자동매매 ON 시) 설정 기준 매수 시도
 */
const refreshTrackingFromCondition = async (
  userId,
  { placeOrders = false, syncRealtime = false } = {}
) => {
  await ensurePositionTables();
  const state = await getIndicatorTrading(userId);
  const settings = state.settings || {};
  const seq = String(settings.buyCondition ?? '').trim();
  if (seq === '') {
    // 아직 설정 전 — 오류가 아니므로 기존 목록(포지션·수동추가)만 돌려준다
    return {
      stocks: await mergeTrackingWithPositions(userId, await getTrackingStocks(userId)),
      conditionSeq: '',
      autoTradingEnabled: !!state.autoTradingEnabled,
      needsCondition: true,
      logs: [],
    };
  }

  const kiwoomInfo = await getKiwoomInfo(userId);
  if (!kiwoomInfo?.accessToken) {
    throw new Error('키움 액세스 토큰이 없습니다. 나의 환경설정에서 토큰을 발급하세요.');
  }

  const prevList = await getTrackingStocks(userId);
  await migrateBuysFromTrackingJson(userId, prevList);

  // 자동매매 ON — 실시간 CNSRREQ(search_type=1) 유지, search_type=0 스냅샷은 WS 충돌 유발
  if (state.autoTradingEnabled) {
    const logs = [];
    if (syncRealtime) {
      try {
        const { resubscribeConditionRealtime } = require('./indicatorConditionRealtime');
        const sub = await resubscribeConditionRealtime(userId, { forceDaily: true });
        if (sub?.subscribed) {
          logs.push(
            `실시간 재구독 — 스냅샷 기준 목록 갱신 (${sub.initialCount ?? 0}건, ${sub.reason || 'ok'})`
          );
        } else {
          logs.push(`실시간 재구독 대기 (${sub?.reason || 'unknown'}) — WS 연결 후 자동 갱신`);
        }
      } catch (err) {
        logs.push(`실시간 재구독 실패: ${err.message}`);
      }
    } else {
      logs.push('자동매매 ON — 실시간 구독 유지, 조건식 스냅샷 조회 생략');
    }
    const currentList = await getTrackingStocks(userId);
    const merged = await mergeTrackingWithPositions(userId, currentList);
    if (placeOrders && currentList.length > 0) {
      const buyLogs = await attemptBuysForStocks(userId, currentList, seq);
      logs.push(...buyLogs);
    }
    return {
      stocks: merged,
      conditionSeq: seq,
      autoTradingEnabled: true,
      settingsApplied: true,
      keptPrevious: !syncRealtime && prevList.length > 0,
      skippedRealtimeSnapshot: !syncRealtime,
      logs,
    };
  }

  let searched;
  try {
    searched = await fetchConditionSearch(kiwoomInfo.accessToken, seq, {
      userId,
      preserveRealtimeSubscription: true,
    });
  } catch (err) {
    if (err?.code === 'REALTIME_SNAPSHOT_SKIP') {
      const merged = await mergeTrackingWithPositions(userId, prevList);
      const logs = ['실시간 구독 중 — 스냅샷 조회 생략, 기존 트래킹 유지'];
      if (placeOrders && state.autoTradingEnabled && prevList.length > 0) {
        const buyLogs = await attemptBuysForStocks(userId, prevList, seq);
        logs.push(...buyLogs);
      }
      return {
        stocks: merged,
        conditionSeq: seq,
        autoTradingEnabled: !!state.autoTradingEnabled,
        settingsApplied: true,
        keptPrevious: prevList.length > 0,
        skippedRealtimeSnapshot: true,
        logs,
      };
    }
    throw err;
  }
  const maxTrack = Math.max(1, Number(settings.maxTrackingStocks) || 90);
  const sliced = searched.slice(0, maxTrack);

  const code6Key = (c) => String(c || '').substring(0, 6);
  const prevMap = new Map();
  for (const s of prevList) {
    const c6 = code6Key(s.stockCode);
    if (c6) prevMap.set(c6, s);
  }
  const prevConditionSeq = String(prevList[0]?.buyConditionSeq ?? '').trim();
  const sameCondition = prevConditionSeq !== '' && prevConditionSeq === seq;

  // 조건검색 0건이어도 스냅샷 기준으로 교체(활성 포지션·수동추가만 유지).
  // 이전 목록 유지는 금요→월요처럼 오래된 종목이 남는 원인이 됨.
  if (sliced.length === 0 && prevList.length > 0) {
    console.log(
      `[지표기반매매] 조건검색 0건 — 트래킹 교체(포지션·수동 유지, prev=${prevList.length}, seq=${seq}` +
        `${sameCondition ? '' : `, 조건변경 ${prevConditionSeq || '?'}→${seq}`})`
    );
  }

  let rows = [];
  for (const s of sliced) {
    const code6 = code6Key(s.stockCode);
    const prev = prevForRebuild(prevMap.get(code6) || null, sameCondition);
    const { resolveIndicatorStockName } = require('./indicatorPositionStore');
    const enriched = {
      ...s,
      stockName: await resolveIndicatorStockName(userId, s.stockCode, s.stockName),
      // 수동이면 스냅샷에도 source 유지
      ...(prev?.source === 'manual' ? { source: 'manual' } : {}),
    };
    const isNxt = await isNXTStock(enriched.stockCode);
    rows.push(buildTrackingRow(enriched, prev, seq, isNxt ? 'NXT' : 'KRX'));
  }

  // 스냅샷에 없어도 활성 포지션은 유지 (미보유 종목만 정리)
  const rowCodes = new Set(rows.map((r) => code6Key(r.stockCode)));
  const posMap = await getActivePositionsMap(userId);
  for (const [code, pos] of posMap.entries()) {
    const c6 = code6Key(code);
    if (!c6 || rowCodes.has(c6)) continue;
    const prevRaw = prevMap.get(c6) || null;
    const prev = prevForRebuild(prevRaw, sameCondition);
    const venue = pos.venue === 'NXT' ? 'NXT' : 'KRX';
    const stickySource =
      prev?.source || pos.entrySource || (prevRaw?.source === 'manual' ? 'manual' : null);
    rows.push(
      buildTrackingRow(
        {
          stockCode: c6,
          stockName: pos.stockName,
          price: pos.lastPrice ?? pos.buyFilledPrice ?? prev?.price ?? prevRaw?.price,
          source: stickySource,
        },
        stickySource === 'manual' ? prevRaw || prev : prev,
        seq,
        venue
      )
    );
    rowCodes.add(c6);
  }

  // 수동 추가 종목은 조건검색 스냅샷에 없어도 유지
  for (const prev of prevList) {
    const c6 = code6Key(prev.stockCode);
    if (!c6 || rowCodes.has(c6)) continue;
    if (prev.source !== 'manual') continue;
    rows.push(
      stripOrderFieldsFromTracking({
        ...prev,
        buyConditionSeq: seq || prev.buyConditionSeq,
      })
    );
    rowCodes.add(c6);
  }

  const shouldTrade = placeOrders && !!state.autoTradingEnabled;
  const logs = [];

  if (shouldTrade) {
    const holdingState = await createBuyHoldingState(userId);

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const result = await tryIndicatorBuyForStock(userId, row, {
        settings,
        seq,
        kiwoomInfo,
        holdingState,
        // 방금 조건검색 스냅샷으로 받은 가격
        priceFresh: true,
      });
      if (result.log) logs.push(result.log);
    }
  }

  const slimRows = rows.map(stripOrderFieldsFromTracking);
  await saveTrackingStocks(userId, slimRows);
  const merged = await mergeTrackingWithPositions(userId, slimRows);

  return {
    stocks: merged,
    conditionSeq: seq,
    autoTradingEnabled: !!state.autoTradingEnabled,
    settingsApplied: true,
    logs,
  };
};

/**
 * 손절 청산 후 tracking에 남아 있으면 재매수 대기 등록
 * — 손절가 대비 -9% 이하일 때만 실제 매수 (즉시 재매수 금지)
 */
const retryBuyAfterStopLossIfTracking = async (userId, stockCode, sellReason, stopFillPrice) => {
  if (sellReason !== 'stop_loss') return null;

  const uid = String(userId);
  const code6 = String(stockCode || '').substring(0, 6);
  if (!code6) return null;

  const state = await getIndicatorTrading(uid);
  if (!state.autoTradingEnabled) return null;

  const seq = String(state.settings?.buyCondition ?? '').trim();
  if (!seq) return null;

  const list = await getTrackingStocks(uid);
  const hit = list.find((r) => String(r.stockCode || '').substring(0, 6) === code6);
  if (!hit) {
    console.log(`[지표기반매매][${uid}] ${code6} 손절 후 재매수 스킵 — tracking 없음`);
    return null;
  }

  const below = await setStopRebuyBelow(uid, code6, stopFillPrice, {
    stockName: hit.stockName || '',
    seq,
  });
  if (below > 0) {
    console.log(
      `[지표기반매매][${uid}] ${code6} 손절 후 재매수 대기 등록: ` +
        `손절가=${Math.round(Number(stopFillPrice) || 0)} 기준가=${below} (−${STOP_LOSS_REBUY_DROP_RATIO * 100}%)`
    );
  }

  const kiwoomInfo = await getKiwoomInfo(uid);
  if (!kiwoomInfo?.accessToken) return null;

  const holdingState = await createBuyHoldingState(uid);
  const row = { ...hit, stopRebuyBelow: below || hit.stopRebuyBelow };
  const result = await tryIndicatorBuyForStock(uid, row, {
    settings: state.settings || {},
    seq,
    kiwoomInfo,
    holdingState,
    priceFresh: false,
  });
  if (result.log) {
    console.log(`[지표기반매매][${uid}] 손절 후 재매수: ${result.log}`);
  }
  return result;
};

module.exports = {
  refreshTrackingFromCondition,
  passesBuyFilters,
  isWithinBuyTimeWindow,
  resolveTradeVenue,
  buildTrackingRow,
  prevForRebuild,
  tryIndicatorBuyForStock,
  createBuyHoldingState,
  attemptBuysForStocks,
  retryPendingBuyOnTick,
  retryBuyAfterStopLossIfTracking,
  addManualTrackingStock,
  removeManualTrackingStock,
  setStopRebuyBelow,
  clearStopRebuyBelow,
  hydrateStopRebuyPendings,
  STOP_LOSS_REBUY_DROP_RATIO,
};

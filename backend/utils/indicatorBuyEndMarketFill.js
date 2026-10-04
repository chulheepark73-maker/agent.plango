/**
 * 매수종료 시각 — 미체결 매수 취소 후 시장가 매수 (설정 ON 시)
 * 사용자별 buyTimeEnd(KST)에 1분 단위로 확인
 */

const cron = require('node-cron');
const { getKiwoomInfo } = require('./kiwoomUtils');
const {
  listAutoTradingUserIds,
  getIndicatorTrading,
  getTrackingStocks,
} = require('./indicatorTradingStore');
const {
  listPendingIndicatorBuys,
  cancelPendingIndicatorBuys,
} = require('./indicatorBuyFill');
const {
  getUnfilledBuyPlacesFromOrders,
  cancelPendingBuyPositionsForCode,
} = require('./indicatorPositionStore');
const {
  tryIndicatorBuyForStock,
  createBuyHoldingState,
} = require('./indicatorTradingTracker');

/** @type {Set<string>} `userId:YYYY-MM-DD` */
const ranKeys = new Set();

const kstNowParts = () => {
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
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hm: `${get('hour')}:${get('minute')}`,
  };
};

const normalizeHm = (raw) => {
  const m = String(raw || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
};

const collectUnfilledBuyCodes = async (userId) => {
  const fromMem = listPendingIndicatorBuys(userId);
  const fromDb = await getUnfilledBuyPlacesFromOrders(userId);
  const map = new Map();
  for (const p of [...fromDb, ...fromMem]) {
    const code = String(p.stockCode || '').substring(0, 6);
    if (!code) continue;
    map.set(code, {
      stockCode: code,
      stockName: p.stockName || '',
      stockMarket: p.stockMarket || p.venue || 'KRX',
    });
  }
  return [...map.values()];
};

/**
 * 단일 사용자 — 미체결 취소 후 시장가 매수
 */
const runBuyEndMarketFillForUser = async (userId) => {
  const uid = String(userId);
  const state = await getIndicatorTrading(uid);
  if (!state.autoTradingEnabled) {
    return { skipped: true, reason: 'auto_off' };
  }
  const settings = state.settings || {};
  if (!settings.buyEndMarketFill) {
    return { skipped: true, reason: 'setting_off' };
  }

  const targets = await collectUnfilledBuyCodes(uid);
  if (targets.length === 0) {
    return { skipped: true, reason: 'no_unfilled', cancelled: 0, placed: 0 };
  }

  const kiwoomInfo = await getKiwoomInfo(uid);
  if (!kiwoomInfo?.accessToken) {
    return { skipped: true, reason: 'no_token' };
  }

  const seq = String(settings.buyCondition ?? '').trim();
  const tracking = await getTrackingStocks(uid);
  const trackByCode = new Map(
    tracking.map((r) => [String(r.stockCode || '').substring(0, 6), r])
  );

  console.log(
    `[지표기반매매][${uid}] 매수종료 시장가폴백 — 미체결 ${targets.length}건 취소 후 시장가 매수`
  );

  const cancelResult = await cancelPendingIndicatorBuys(uid, {
    reason: 'buy_end_market_fill',
    rawMessage: '매수종료 — 미체결 취소 후 시장가 매수',
  });

  for (const t of targets) {
    try {
      await cancelPendingBuyPositionsForCode(uid, t.stockCode, 'buy_end_market_fill');
    } catch {
      /* ignore */
    }
  }

  // 취소 반영 대기
  await new Promise((r) => setTimeout(r, 400));

  const holdingState = await createBuyHoldingState(uid);
  const logs = [];
  let placed = 0;

  for (const t of targets) {
    const prev = trackByCode.get(t.stockCode);
    const row = {
      stockCode: t.stockCode,
      stockName: t.stockName || prev?.stockName || t.stockCode,
      stockMarket: t.stockMarket || prev?.stockMarket || 'KRX',
      price: prev?.price ?? null,
      source: prev?.source || null,
    };
    try {
      const result = await tryIndicatorBuyForStock(uid, row, {
        settings,
        seq,
        kiwoomInfo,
        holdingState,
        priceFresh: false,
        bypassBuyTimeWindow: true,
        forceMarketOrder: true,
      });
      if (result.log) {
        logs.push(result.log);
        console.log(`[지표기반매매][${uid}] ${result.log}`);
      }
      if (result.placed) {
        placed += 1;
        holdingState.holdingCount += 1;
        holdingState.usedAmount += Number(settings.buyAmountKrw) || 0;
        holdingState.pendingCodes.add(t.stockCode);
      }
    } catch (err) {
      const msg = `[${t.stockCode}] 시장가매수 실패: ${err.message || err}`;
      logs.push(msg);
      console.error(`[지표기반매매][${uid}] ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    skipped: false,
    cancelled: cancelResult.cancelled || 0,
    cancelFailed: cancelResult.failed || 0,
    targets: targets.length,
    placed,
    logs,
  };
};

const runBuyEndMarketFillTick = async () => {
  const { date, hm } = kstNowParts();
  const userIds = await listAutoTradingUserIds();
  for (const userId of userIds) {
    const runKey = `${userId}:${date}`;
    if (ranKeys.has(runKey)) continue;

    let state;
    try {
      state = await getIndicatorTrading(userId);
    } catch {
      continue;
    }
    if (!state.autoTradingEnabled) continue;
    const settings = state.settings || {};
    if (!settings.buyEndMarketFill) continue;

    const endHm = normalizeHm(settings.buyTimeEnd || '15:20');
    if (!endHm || endHm !== hm) continue;

    ranKeys.add(runKey);
    try {
      const result = await runBuyEndMarketFillForUser(userId);
      if (!result.skipped) {
        console.log(
          `[지표기반매매][${userId}] 매수종료 시장가폴백 완료 ` +
            `취소=${result.cancelled} 시장가접수=${result.placed}`
        );
      }
    } catch (err) {
      console.error(`[지표기반매매][${userId}] 매수종료 시장가폴백 오류:`, err.message || err);
    }
  }

  // 날짜 지난 키 정리
  for (const k of [...ranKeys]) {
    if (!k.endsWith(`:${date}`)) ranKeys.delete(k);
  }
};

function startScheduler() {
  cron.schedule(
    '* * * * 1-5',
    async () => {
      try {
        await runBuyEndMarketFillTick();
      } catch (error) {
        console.error('[지표기반매매] 매수종료 시장가폴백 스케줄 오류:', error);
      }
    },
    { timezone: 'Asia/Seoul' }
  );
  console.log('[지표기반매매] 매수종료 시장가폴백 스케줄러 시작 (매분, 평일 KST)');
}

module.exports = {
  startScheduler,
  runBuyEndMarketFillForUser,
  runBuyEndMarketFillTick,
};

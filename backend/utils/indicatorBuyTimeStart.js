/**
 * 매수시간 시작 시각 — tracking(조건) 종목 일괄 매수 시도
 * 사용자별 buyTimeStart(KST)에 1분 단위로 확인 (접속 없이 서버에서 실행)
 */

const cron = require('node-cron');
const {
  listAutoTradingUserIds,
  getIndicatorTrading,
  getTrackingStocks,
} = require('./indicatorTradingStore');
const { attemptBuysForStocks } = require('./indicatorTradingTracker');

/** @type {Set<string>} `userId:YYYY-MM-DD:HH:mm` */
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

/**
 * 단일 사용자 — 매수시간 시작 일괄 매수
 */
const runBuyTimeStartForUser = async (userId) => {
  const uid = String(userId);
  const state = await getIndicatorTrading(uid);
  if (!state.autoTradingEnabled) {
    return { skipped: true, reason: 'auto_off' };
  }

  const settings = state.settings || {};
  const seq = String(settings.buyCondition ?? '').trim();
  if (!seq) {
    return { skipped: true, reason: 'no_condition' };
  }

  let tracking = await getTrackingStocks(uid);

  // 매수시간 시작 전 — 항상 조건식 강제 재구독으로 당일 스냅샷 확보 (금요 잔존 목록으로 매수 방지)
  try {
    const { resubscribeConditionRealtime } = require('./indicatorConditionRealtime');
    const sub = await resubscribeConditionRealtime(uid, { forceDaily: true });
    if (sub?.subscribed && (sub.initialCount || 0) > 0 && (sub.buyLogs || []).length > 0) {
      return {
        skipped: false,
        via: 'resubscribe',
        stockCount: sub.initialCount || 0,
        placedHint: (sub.buyLogs || []).length,
        logs: sub.buyLogs || [],
      };
    }
    tracking = await getTrackingStocks(uid);
    if (sub?.reason) {
      console.log(
        `[지표기반매매][${uid}] 매수시작 재구독 reason=${sub.reason} tracking=${tracking.length}`
      );
    }
  } catch (err) {
    console.warn(
      `[지표기반매매][${uid}] 매수시작 재구독 실패:`,
      err.message || err
    );
  }

  if (!tracking.length) {
    return { skipped: true, reason: 'no_tracking', stockCount: 0, logs: [] };
  }

  console.log(
    `[지표기반매매][${uid}] 매수시간 시작 — tracking ${tracking.length}종목 일괄 매수 시도`
  );

  const logs = await attemptBuysForStocks(uid, tracking, seq, { priceFresh: false });
  const placed = logs.filter((l) => /매수 접수/.test(String(l))).length;

  for (const log of logs) {
    console.log(`[지표기반매매][${uid}] ${log}`);
  }

  return {
    skipped: false,
    via: 'tracking',
    stockCount: tracking.length,
    placed,
    logs,
  };
};

const runBuyTimeStartTick = async () => {
  const { date, hm } = kstNowParts();
  const userIds = await listAutoTradingUserIds();

  for (const userId of userIds) {
    let state;
    try {
      state = await getIndicatorTrading(userId);
    } catch {
      continue;
    }
    if (!state.autoTradingEnabled) continue;

    const settings = state.settings || {};
    const startHm = normalizeHm(settings.buyTimeStart || '15:00');
    if (!startHm || startHm !== hm) continue;

    const runKey = `${userId}:${date}:${startHm}`;
    if (ranKeys.has(runKey)) continue;
    ranKeys.add(runKey);

    try {
      const result = await runBuyTimeStartForUser(userId);
      if (result.skipped) {
        console.log(
          `[지표기반매매][${userId}] 매수시간 시작 스킵: ${result.reason}`
        );
      } else {
        console.log(
          `[지표기반매매][${userId}] 매수시간 시작 일괄매수 완료 ` +
            `via=${result.via} 종목=${result.stockCount} ` +
            `접수추정=${result.placed ?? result.placedHint ?? 0}`
        );
      }
    } catch (err) {
      console.error(
        `[지표기반매매][${userId}] 매수시간 시작 일괄매수 오류:`,
        err.message || err
      );
    }
  }

  for (const k of [...ranKeys]) {
    if (!String(k).includes(`:${date}:`)) ranKeys.delete(k);
  }
};

function startScheduler() {
  cron.schedule(
    '* * * * 1-5',
    async () => {
      try {
        await runBuyTimeStartTick();
      } catch (error) {
        console.error('[지표기반매매] 매수시간 시작 일괄매수 스케줄 오류:', error);
      }
    },
    { timezone: 'Asia/Seoul' }
  );
  console.log('[지표기반매매] 매수시간 시작 일괄매수 스케줄러 시작 (매분, 평일 KST)');
}

module.exports = {
  startScheduler,
  runBuyTimeStartForUser,
  runBuyTimeStartTick,
};

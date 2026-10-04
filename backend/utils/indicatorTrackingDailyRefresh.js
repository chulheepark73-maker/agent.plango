/**
 * 지표기반매매 — 트래킹 목록 일일 갱신
 * - 08:00: 전일(금요 등) 조건식 잔존 종목 정리 (포지션·수동추가 유지)
 * - 08:58: 자동매매 ON 사용자 조건검색 강제 재구독(당일 스냅샷)
 */

const cron = require('node-cron');
const {
  listAutoTradingUserIds,
  getIndicatorTrading,
  getTrackingStocks,
} = require('./indicatorTradingStore');
const {
  pruneConditionTrackingKeepingSticky,
  resubscribeConditionRealtime,
  hasFreshSnapshotToday,
} = require('./indicatorConditionRealtime');
const { isWeekend, isHolidaySync } = require('./stockUtils');

/** @type {Set<string>} `prune:YYYY-MM-DD` / `snap:YYYY-MM-DD` */
const ranKeys = new Set();

const kstDate = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

/** 트래킹이 있는 모든 지표매매 사용자 */
const listUsersWithTracking = async () => {
  const pool = require('./db');
  const result = await pool.query(
    `SELECT user_id FROM indicator_trading
     WHERE jsonb_typeof(tracking_stocks) = 'array'
       AND jsonb_array_length(tracking_stocks) > 0`
  );
  return result.rows.map((r) => String(r.user_id));
};

/**
 * 장전 — 당일 스냅샷 전 조건식 잔존 목록 정리
 */
const runMorningPrune = async () => {
  if (isWeekend() || isHolidaySync()) {
    console.log('[지표기반매매] 트래킹 장전 정리 — 주말·휴일 생략');
    return;
  }

  const date = kstDate();
  const key = `prune:${date}`;
  if (ranKeys.has(key)) return;
  ranKeys.add(key);

  const userIds = await listUsersWithTracking();
  console.log(`[지표기반매매] 트래킹 장전 정리 시작 — ${userIds.length}명`);

  for (const uid of userIds) {
    try {
      if (hasFreshSnapshotToday(uid)) continue;
      const before = await getTrackingStocks(uid);
      if (!before.length) continue;
      const state = await getIndicatorTrading(uid);
      const seq = String(state.settings?.buyCondition ?? '').trim();
      const after = await pruneConditionTrackingKeepingSticky(uid, seq);
      console.log(
        `[지표기반매매][${uid}] 장전 정리 ${before.length}→${(after || []).length}건`
      );
    } catch (err) {
      console.error(`[지표기반매매][${uid}] 장전 정리 오류:`, err.message || err);
    }
  }
};

/**
 * 08:58 — 자동매매 ON 사용자 강제 조건식 스냅샷
 */
const runMorningForceSnapshot = async () => {
  if (isWeekend() || isHolidaySync()) {
    console.log('[지표기반매매] 당일 스냅샷 강제 — 주말·휴일 생략');
    return;
  }

  const date = kstDate();
  const key = `snap:${date}`;
  if (ranKeys.has(key)) return;
  ranKeys.add(key);

  const userIds = await listAutoTradingUserIds();
  console.log(`[지표기반매매] 당일 스냅샷 강제 시작 — auto ${userIds.length}명`);

  for (const uid of userIds) {
    try {
      if (hasFreshSnapshotToday(uid)) {
        console.log(`[지표기반매매][${uid}] 당일 스냅샷 이미 있음 — 스킵`);
        continue;
      }
      const sub = await resubscribeConditionRealtime(uid, { forceDaily: true });
      console.log(
        `[지표기반매매][${uid}] 당일 스냅샷 강제 ` +
          `subscribed=${!!sub?.subscribed} reason=${sub?.reason || '-'} ` +
          `count=${sub?.initialCount ?? 0}`
      );
    } catch (err) {
      console.error(`[지표기반매매][${uid}] 당일 스냅샷 강제 오류:`, err.message || err);
    }
  }

  for (const k of [...ranKeys]) {
    if (!k.endsWith(`:${date}`)) ranKeys.delete(k);
  }
};

function startScheduler() {
  // 평일 08:00 — 전일 잔존 조건식 종목 정리
  cron.schedule(
    '0 8 * * 1-5',
    async () => {
      try {
        await runMorningPrune();
      } catch (error) {
        console.error('[지표기반매매] 트래킹 장전 정리 스케줄 오류:', error);
      }
    },
    { timezone: 'Asia/Seoul' }
  );

  // 평일 08:58 — 조건검색 강제 스냅샷 (WS 모니터와 병행)
  cron.schedule(
    '58 8 * * 1-5',
    async () => {
      try {
        await runMorningForceSnapshot();
      } catch (error) {
        console.error('[지표기반매매] 당일 스냅샷 강제 스케줄 오류:', error);
      }
    },
    { timezone: 'Asia/Seoul' }
  );

  console.log(
    '[지표기반매매] 트래킹 일일 갱신 스케줄러 시작 (08:00 정리, 08:58 스냅샷, 평일 KST)'
  );

  // 서버가 08:00/08:58 이후에 뜬 경우 당일 1회 보정
  setTimeout(() => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      const get = (t) => parts.find((p) => p.type === t)?.value || '';
      const weekday = get('weekday');
      if (weekday === 'Sat' || weekday === 'Sun') return;
      let hour = parseInt(get('hour'), 10);
      if (hour === 24) hour = 0;
      const minute = parseInt(get('minute'), 10) || 0;
      const mins = hour * 60 + minute;
      if (mins >= 8 * 60) {
        runMorningPrune().catch((e) =>
          console.error('[지표기반매매] 기동 시 장전 정리 오류:', e.message || e)
        );
      }
      if (mins >= 8 * 60 + 58) {
        runMorningForceSnapshot().catch((e) =>
          console.error('[지표기반매매] 기동 시 스냅샷 강제 오류:', e.message || e)
        );
      }
    } catch (e) {
      console.error('[지표기반매매] 기동 시 트래킹 보정 오류:', e.message || e);
    }
  }, 8000);
}

module.exports = {
  startScheduler,
  runMorningPrune,
  runMorningForceSnapshot,
};

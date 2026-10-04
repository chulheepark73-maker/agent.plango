const cron = require('node-cron');
const { runEodUnfilledIndicatorSellsForAllUsers } = require('../services/indicatorSellMonitor');

/**
 * 지표기반매매 — 장마감 후 미체결 매도 → reject + open 복귀
 * KRX 15:35 / NXT·잔여 20:05 KST (평일)
 */
function startScheduler() {
  cron.schedule(
    '35 15 * * 1-5',
    async () => {
      try {
        await runEodUnfilledIndicatorSellsForAllUsers('KRX');
      } catch (error) {
        console.error('[지표기반매매매도] EOD KRX 15:35 오류:', error);
      }
    },
    { timezone: 'Asia/Seoul' }
  );

  cron.schedule(
    '5 20 * * 1-5',
    async () => {
      try {
        // NXT 마감 + KRX에서 놓친 selling 잔여분
        await runEodUnfilledIndicatorSellsForAllUsers(null);
      } catch (error) {
        console.error('[지표기반매매매도] EOD NXT 20:05 오류:', error);
      }
    },
    { timezone: 'Asia/Seoul' }
  );

  console.log('[지표기반매매매도] EOD 미체결정리 스케줄러 시작 (KRX 15:35, 전장 20:05 KST)');
}

module.exports = {
  startScheduler,
  runEodUnfilledIndicatorSellsForAllUsers,
};

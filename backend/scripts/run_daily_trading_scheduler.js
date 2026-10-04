const { fetchAndSaveTopTradingStocks } = require('../utils/dailyTradingStocksScheduler');

async function runScheduler() {
  try {
    console.log('[스케줄러 수동 실행] 시작');
    await fetchAndSaveTopTradingStocks();
    console.log('[스케줄러 수동 실행] 완료');
    process.exit(0);
  } catch (error) {
    console.error('[스케줄러 수동 실행] 실패:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  runScheduler();
}

module.exports = { runScheduler };


// 스케줄러 함수를 직접 실행하여 테스트
require('dotenv').config();

const { fetchAndSaveTopTradingStocks } = require('../utils/dailyTradingStocksScheduler');

async function test() {
  try {
    console.log('=== 일일 거래대금 상위 종목 저장 테스트 시작 ===');
    await fetchAndSaveTopTradingStocks();
    console.log('=== 테스트 완료 ===');
    process.exit(0);
  } catch (error) {
    console.error('=== 테스트 실패 ===', error);
    process.exit(1);
  }
}

test();


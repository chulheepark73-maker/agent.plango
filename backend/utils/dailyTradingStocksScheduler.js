const cron = require('node-cron');
const { getAllUsers } = require('./userStore');
const { getKiwoomInfo } = require('./kiwoomUtils');
const kiwoomAPI = require('../services/kiwoomApi');
const { saveDailyTradingStocks } = require('./dailyTradingStocksStore');
const { isWeekend, isHolidaySync } = require('./stockUtils');

/**
 * 주중 거래일인지 확인
 * @returns {boolean} 주중 거래일 여부
 */
function isTradingDay() {
  // 주말 체크
  if (isWeekend()) {
    return false;
  }
  
  // 휴일 체크
  if (isHolidaySync()) {
    return false;
  }
  
  return true;
}

/**
 * 거래대금 상위 종목을 가져와서 DB에 저장
 */
async function fetchAndSaveTopTradingStocks() {
  try {
    console.log('[일일거래대금 스케줄러] 거래대금 상위 종목 조회 및 저장 시작');
    
    // 주중 거래일인지 확인
    if (!isTradingDay()) {
      console.log('[일일거래대금 스케줄러] 주말 또는 휴일이므로 실행하지 않습니다.');
      return;
    }
    
    // 유효한 사용자 조회 (첫 번째 사용자의 정보 사용)
    const allUsers = await getAllUsers();
    const { filterUsersWithKiwoom } = require('./kiwoomUtils');
    const users = await filterUsersWithKiwoom(allUsers);
    
    if (users.length === 0) {
      console.log('[일일거래대금 스케줄러] 유효한 사용자가 없습니다.');
      return;
    }
    
    // 첫 번째 사용자의 키움증권 정보 사용
    const user = users[0];
    const kiwoomInfo = await getKiwoomInfo(user.id);
    
    if (!kiwoomInfo || !kiwoomInfo.accessToken || !kiwoomInfo.appKey || !kiwoomInfo.appSecret) {
      console.log('[일일거래대금 스케줄러] 키움증권 정보가 없습니다.');
      return;
    }
    
    // 거래대금 상위 50위 종목 조회 (시가총액 3조 이상 필터링 포함)
    const stocks = await kiwoomAPI.getTopTradingValueStocks(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      50
    );
    
    if (!stocks || stocks.length === 0) {
      console.log('[일일거래대금 스케줄러] 조회된 종목이 없습니다.');
      return;
    }
    
    // 오늘 날짜 (한국 시간 기준)
    // 한국 시간대(UTC+9) 계산
    const now = new Date();
    // 한국 시간대(UTC+9) 계산: 현재 UTC 시간에 9시간 추가
    const koreaTimeOffset = 9 * 60 * 60 * 1000; // 9시간을 밀리초로
    const koreaTime = new Date(now.getTime() + koreaTimeOffset);
    
    // 한국 시간 기준으로 날짜 문자열 생성 (YYYY-MM-DD)
    const year = koreaTime.getUTCFullYear();
    const month = String(koreaTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(koreaTime.getUTCDate()).padStart(2, '0');
    const dateString = `${year}-${month}-${day}`;
    const today = new Date(dateString + 'T00:00:00Z');
    
    console.log(`[일일거래대금 스케줄러] 현재 시간: ${now.toISOString()}, 한국 시간: ${koreaTime.toISOString()}, 오늘 날짜: ${dateString}`);
    
    // DB에 저장할 데이터 형식으로 변환
    // getTopTradingValueStocks에서 이미 계산된 prevChange, prevVolume, isDecreased, decreaseRate를 그대로 사용
    const stocksToSave = stocks.map(stock => ({
      stockCode: stock.stockCode,
      stockName: stock.stockName,
      price: stock.price || 0,
      volume: stock.volume || 0,
      tradingValue: stock.tradingValue || 0,
      sector: stock.sector || '기타',
      prevChange: stock.prevChange || 0,
      prevVolume: stock.prevVolume || 0,
      isDecreased: stock.isDecreased || false,
      decreaseRate: stock.decreaseRate || 0
    }));
    
    // DB에 저장
    const savedCount = await saveDailyTradingStocks(today, stocksToSave);
    
    console.log(`[일일거래대금 스케줄러] ${today.toISOString().split('T')[0]} 날짜로 ${savedCount}개 종목 저장 완료`);
  } catch (error) {
    console.error('[일일거래대금 스케줄러] 실행 중 오류:', error);
  }
}

/**
 * 스케줄러 시작
 */
function startScheduler() {
  // 주중 거래일 21시에 실행 (매일 21:00)
  // cron 표현식: '0 21 * * 1-5' (월-금 21:00)
  // 하지만 주말/휴일 체크는 함수 내부에서 수행
  cron.schedule('0 21 * * *', async () => {
    console.log('[일일거래대금 스케줄러] 스케줄 실행 (21:00)');
    await fetchAndSaveTopTradingStocks();
  }, {
    timezone: 'Asia/Seoul'
  });
  
  console.log('[일일거래대금 스케줄러] 스케줄러 시작됨 (매일 21:00 실행)');
}

module.exports = {
  startScheduler,
  fetchAndSaveTopTradingStocks
};


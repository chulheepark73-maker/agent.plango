const pool = require('./db');

/**
 * 거래대금 상위 종목을 DB에 저장
 * @param {Date} date - 날짜
 * @param {Array} stocks - 종목 배열 [{ stockCode, stockName, price, volume, tradingValue, sector, prevChange, prevVolume, isDecreased, decreaseRate }]
 * @returns {Promise<number>} 저장된 레코드 수
 */
async function saveDailyTradingStocks(date, stocks) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    let savedCount = 0;
    
    for (const stock of stocks) {
      try {
        await client.query(
          `INSERT INTO daily_trading_stocks 
           (date, stock_code, stock_name, price, volume, trading_value, sector, prev_change, prev_volume, is_decreased, decrease_rate)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (date, stock_code) 
           DO UPDATE SET
             stock_name = EXCLUDED.stock_name,
             price = EXCLUDED.price,
             volume = EXCLUDED.volume,
             trading_value = EXCLUDED.trading_value,
             sector = EXCLUDED.sector,
             prev_change = EXCLUDED.prev_change,
             prev_volume = EXCLUDED.prev_volume,
             is_decreased = EXCLUDED.is_decreased,
             decrease_rate = EXCLUDED.decrease_rate,
             created_at = CURRENT_TIMESTAMP`,
          [
            date,
            stock.stockCode,
            stock.stockName,
            stock.price,
            stock.volume,
            stock.tradingValue,
            stock.sector || '기타',
            stock.prevChange || 0,
            stock.prevVolume || 0,
            stock.isDecreased || false,
            stock.decreaseRate || 0
          ]
        );
        savedCount++;
      } catch (error) {
        console.error(`[일일거래대금] 종목 ${stock.stockCode} 저장 실패:`, error.message);
        // 개별 종목 저장 실패는 계속 진행
      }
    }
    
    await client.query('COMMIT');
    console.log(`[일일거래대금] ${date.toISOString().split('T')[0]} 날짜로 ${savedCount}개 종목 저장 완료`);
    
    return savedCount;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[일일거래대금] 저장 중 오류:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 특정 날짜의 거래대금 상위 종목 조회
 * @param {Date} date - 날짜
 * @returns {Promise<Array>} 종목 배열
 */
async function getDailyTradingStocks(date) {
  try {
    const result = await pool.query(
      `SELECT date, stock_code, stock_name, price, volume, trading_value, sector, 
              prev_change, prev_volume, is_decreased, decrease_rate, created_at
       FROM daily_trading_stocks
       WHERE date = $1
       ORDER BY trading_value DESC`,
      [date]
    );
    
    return result.rows;
  } catch (error) {
    console.error('[일일거래대금] 조회 중 오류:', error);
    throw error;
  }
}

module.exports = {
  saveDailyTradingStocks,
  getDailyTradingStocks
};


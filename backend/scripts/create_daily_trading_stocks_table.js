const pool = require('../utils/db');

async function createTable() {
  try {
    // daily_trading_stocks 테이블 생성
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_trading_stocks (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        stock_code VARCHAR(20) NOT NULL,
        stock_name VARCHAR(100) NOT NULL,
        price BIGINT NOT NULL,
        volume BIGINT NOT NULL,
        trading_value BIGINT NOT NULL,
        sector VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(date, stock_code)
      )
    `);

    // 인덱스 생성
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_trading_stocks_date 
      ON daily_trading_stocks(date)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_trading_stocks_stock_code 
      ON daily_trading_stocks(stock_code)
    `);

    console.log('✅ daily_trading_stocks 테이블 생성 완료');
  } catch (error) {
    console.error('❌ 테이블 생성 실패:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  createTable()
    .then(() => {
      console.log('✅ 스크립트 실행 완료');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ 스크립트 실행 실패:', error);
      process.exit(1);
    });
}

module.exports = { createTable };


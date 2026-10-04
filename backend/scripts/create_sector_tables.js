const pool = require('../utils/db');

async function createSectorTables() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // 1. 섹터(테마) 마스터 테이블
    await client.query(`
      CREATE TABLE IF NOT EXISTS sectors (
        id           SERIAL PRIMARY KEY,
        name         VARCHAR(100) NOT NULL,
        description  TEXT,
        parent_id    INT REFERENCES sectors(id),
        is_active    BOOLEAN DEFAULT true,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ sectors 테이블 생성 완료');

    // 2. 종목 마스터 테이블
    await client.query(`
      CREATE TABLE IF NOT EXISTS stocks (
        code       VARCHAR(10) PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        market     VARCHAR(10),       -- KOSPI / KOSDAQ
        is_active  BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ stocks 테이블 생성 완료');

    // 3. 종목 ↔ 섹터 매핑 테이블
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_sectors (
        stock_code VARCHAR(10) REFERENCES stock_list(stock_code) ON DELETE CASCADE,
        sector_id  INT REFERENCES sectors(id) ON DELETE CASCADE,
        priority   INT DEFAULT 1,      -- 1: 주력, 2~: 부가
        latest_up  DATE,               -- 최신 업데이트 날짜 (yyyy-mm-dd)
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (stock_code, sector_id)
      )
    `);
    console.log('✅ stock_sectors 테이블 생성 완료');

    // 인덱스 생성
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sectors_parent_id ON sectors(parent_id)
    `);
    console.log('✅ sectors.parent_id 인덱스 생성 완료');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market)
    `);
    console.log('✅ stocks.market 인덱스 생성 완료');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_sectors_stock_code ON stock_sectors(stock_code)
    `);
    console.log('✅ stock_sectors.stock_code 인덱스 생성 완료');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_sectors_sector_id ON stock_sectors(sector_id)
    `);
    console.log('✅ stock_sectors.sector_id 인덱스 생성 완료');

    await client.query('COMMIT');
    console.log('✅ 모든 테이블 생성 완료');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ 테이블 생성 실패:', error);
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  createSectorTables()
    .then(() => {
      console.log('✅ 스크립트 실행 완료');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ 스크립트 실행 실패:', error);
      process.exit(1);
    });
}

module.exports = { createSectorTables };


const pool = require('../utils/db');

async function createStockSectorsTable() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    console.log('stock_sectors 테이블 생성 시작...');

    // stock_sectors 테이블 생성
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_sectors (
        stock_code VARCHAR(10) REFERENCES stock_list(stock_code),
        sector_id  INT REFERENCES sectors(id),
        priority   INT DEFAULT 1,      -- 1: 주력, 2~: 부가
        latest_up  DATE,               -- 최신 업데이트 날짜 (yyyy-mm-dd)
        created_at TIMESTAMP DEFAULT now(),
        PRIMARY KEY (stock_code, sector_id)
      )
    `);
    console.log('✅ stock_sectors 테이블 생성 완료');

    // 인덱스 생성
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_sectors_stock_code ON stock_sectors(stock_code)
    `);
    console.log('✅ stock_sectors.stock_code 인덱스 생성 완료');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_sectors_sector_id ON stock_sectors(sector_id)
    `);
    console.log('✅ stock_sectors.sector_id 인덱스 생성 완료');

    await client.query('COMMIT');
    console.log('✅ stock_sectors 테이블 생성 완료');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ 테이블 생성 실패:', error);
    throw error;
  } finally {
    client.release();
  }
}

// 스크립트 직접 실행 시
if (require.main === module) {
  createStockSectorsTable()
    .then(() => {
      console.log('✅ 스크립트 실행 완료');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ 스크립트 실행 실패:', error);
      process.exit(1);
    });
}

module.exports = { createStockSectorsTable };


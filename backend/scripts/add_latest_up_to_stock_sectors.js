const pool = require('../utils/db');

async function addLatestUpToStockSectors() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    console.log('stock_sectors 테이블에 latest_up 필드 추가 시작...');

    // latest_up 컬럼 추가 (DATE 타입)
    await client.query(`
      ALTER TABLE stock_sectors
      ADD COLUMN IF NOT EXISTS latest_up DATE
    `);
    console.log('✅ latest_up 필드 추가 완료');

    await client.query('COMMIT');
    console.log('✅ 작업 완료');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ 작업 실패:', error);
    throw error;
  } finally {
    client.release();
  }
}

// 스크립트 직접 실행 시
if (require.main === module) {
  addLatestUpToStockSectors()
    .then(() => {
      console.log('✅ 스크립트 실행 완료');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ 스크립트 실행 실패:', error);
      process.exit(1);
    });
}

module.exports = { addLatestUpToStockSectors };


const pool = require('../utils/db');

async function addFields() {
  try {
    // prevChange, prevVolume, isDecreased, decreaseRate 필드 추가
    await pool.query(`
      ALTER TABLE daily_trading_stocks
      ADD COLUMN IF NOT EXISTS prev_change BIGINT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS prev_volume BIGINT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS is_decreased BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS decrease_rate NUMERIC(10, 2) DEFAULT 0
    `);

    console.log('✅ daily_trading_stocks 테이블에 필드 추가 완료');
  } catch (error) {
    console.error('❌ 필드 추가 실패:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  addFields()
    .then(() => {
      console.log('✅ 스크립트 실행 완료');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ 스크립트 실행 실패:', error);
      process.exit(1);
    });
}

module.exports = { addFields };


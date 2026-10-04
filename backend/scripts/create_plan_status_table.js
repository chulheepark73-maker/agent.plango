const pool = require('../utils/db');
const { ensurePlanStatusTable } = require('../utils/planStatusStore');

async function createPlanStatusTable() {
  try {
    await ensurePlanStatusTable();
    console.log('✅ plan_status 테이블 생성/마이그레이션 완료 (kr_*/us_*)');
  } catch (error) {
    console.error('❌ plan_status 테이블 생성 실패:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  createPlanStatusTable()
    .then(() => {
      console.log('✅ 스크립트 실행 완료');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ 스크립트 실행 실패:', error);
      process.exit(1);
    });
}

module.exports = { createPlanStatusTable };

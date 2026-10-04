const pool = require('../utils/db');

async function dropStocksTable() {
  const client = await pool.connect();
  
  try {
    console.log('stocks 테이블 삭제 시작...');
    
    // 외래 키 제약 조건 때문에 stock_sectors 테이블의 참조를 먼저 확인해야 할 수 있습니다.
    // 하지만 사용자가 명시적으로 삭제를 요청했으므로 CASCADE로 삭제합니다.
    
    await client.query('DROP TABLE IF EXISTS stock_sectors CASCADE');
    console.log('stock_sectors 테이블 삭제 완료');
    
    await client.query('DROP TABLE IF EXISTS stocks CASCADE');
    console.log('stocks 테이블 삭제 완료');
    
    console.log('모든 작업 완료!');
  } catch (error) {
    console.error('오류 발생:', error);
    throw error;
  } finally {
    client.release();
  }
}

// 스크립트 직접 실행 시
if (require.main === module) {
  dropStocksTable()
    .then(() => {
      console.log('스크립트 실행 완료');
      process.exit(0);
    })
    .catch((error) => {
      console.error('스크립트 실행 실패:', error);
      process.exit(1);
    });
}

module.exports = { dropStocksTable };


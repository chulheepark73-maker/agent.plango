// DB에 저장된 데이터 확인
require('dotenv').config();

const pool = require('../utils/db');

async function check() {
  try {
    // 오늘 날짜로 저장된 데이터 조회
    const now = new Date();
    const koreaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const today = new Date(koreaTime.getFullYear(), koreaTime.getMonth(), koreaTime.getDate());
    
    const result = await pool.query(
      `SELECT date, stock_code, stock_name, price, volume, trading_value, sector, created_at
       FROM daily_trading_stocks
       WHERE date = $1
       ORDER BY trading_value DESC
       LIMIT 10`,
      [today]
    );
    
    console.log(`\n=== ${today.toISOString().split('T')[0]} 날짜로 저장된 데이터 (상위 10개) ===\n`);
    console.log(`총 ${result.rows.length}개 레코드 조회됨\n`);
    
    result.rows.forEach((row, index) => {
      console.log(`${index + 1}. ${row.stock_name} (${row.stock_code})`);
      console.log(`   현재가: ${row.price.toLocaleString()}원`);
      console.log(`   거래량: ${row.volume.toLocaleString()}`);
      console.log(`   거래대금: ${row.trading_value.toLocaleString()}원`);
      console.log(`   섹터: ${row.sector}`);
      console.log(`   저장시간: ${row.created_at}`);
      console.log('');
    });
    
    // 전체 개수 확인
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM daily_trading_stocks WHERE date = $1`,
      [today]
    );
    
    console.log(`\n총 저장된 종목 수: ${countResult.rows[0].total}개\n`);
    
    process.exit(0);
  } catch (error) {
    console.error('조회 중 오류:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

check();


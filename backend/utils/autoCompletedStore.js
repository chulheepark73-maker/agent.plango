const pool = require('./db');

// 한국 시간으로 날짜 시간 포맷팅 (YYYY-MM-DD HH:mm:ss)
const formatKoreaDateTime = () => {
  const now = new Date();
  const koreaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  
  const year = koreaTime.getFullYear();
  const month = String(koreaTime.getMonth() + 1).padStart(2, '0');
  const day = String(koreaTime.getDate()).padStart(2, '0');
  const hours = String(koreaTime.getHours()).padStart(2, '0');
  const minutes = String(koreaTime.getMinutes()).padStart(2, '0');
  const seconds = String(koreaTime.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

// auto_completed 항목 추가
const addAutoCompleted = async (userId, stockCode, buyX_price, buyX_qty, sellX_price, sellX_qty, sell_cur) => {
  try {
    const result = await pool.query(
      `INSERT INTO auto_completed (
        user_id, stock_code, buy_price, buy_qty, sell_price, sell_qty, sell_cur, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        String(userId),
        stockCode,
        buyX_price || null,
        buyX_qty || null,
        sellX_price || null,
        sellX_qty || null,
        sell_cur || 1,
        new Date()
      ]
    );
    
    const saved = result.rows[0];
    return {
      userId: saved.user_id,
      stockCode: saved.stock_code,
      buy_price: saved.buy_price,
      buy_qty: saved.buy_qty,
      sell_price: saved.sell_price,
      sell_qty: saved.sell_qty,
      sell_cur: saved.sell_cur,
      createdAt: saved.created_at ? formatKoreaDateTimeFromDate(saved.created_at) : formatKoreaDateTime()
    };
  } catch (error) {
    console.error('[autoCompletedStore] addAutoCompleted 오류:', error);
    throw error;
  }
};

const formatKoreaDateTimeFromDate = (date) => {
  const koreaTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const year = koreaTime.getFullYear();
  const month = String(koreaTime.getMonth() + 1).padStart(2, '0');
  const day = String(koreaTime.getDate()).padStart(2, '0');
  const hours = String(koreaTime.getHours()).padStart(2, '0');
  const minutes = String(koreaTime.getMinutes()).padStart(2, '0');
  const seconds = String(koreaTime.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

// 파일 읽기 (하위 호환성을 위해 유지)
const readAutoCompletedFile = async () => {
  try {
    const result = await pool.query(
      'SELECT * FROM auto_completed ORDER BY created_at DESC'
    );
    
    return result.rows.map(row => ({
      userId: row.user_id,
      stockCode: row.stock_code,
      buy_price: row.buy_price,
      buy_qty: row.buy_qty,
      sell_price: row.sell_price,
      sell_qty: row.sell_qty,
      sell_cur: row.sell_cur,
      createdAt: row.created_at ? formatKoreaDateTimeFromDate(row.created_at) : null
    }));
  } catch (error) {
    console.error('[autoCompletedStore] readAutoCompletedFile 오류:', error);
    return [];
  }
};

module.exports = {
  addAutoCompleted,
  readAutoCompletedFile,
  formatKoreaDateTimeFromDate,
};

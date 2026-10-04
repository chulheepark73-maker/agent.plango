const pool = require('./db');

// 한국 시간(KST)으로 날짜 시간 문자열 반환 (YYYY-MM-DD HH:mm:ss 형식)
const getKSTDateTime = () => {
  const now = new Date();
  const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  
  const year = kstTime.getUTCFullYear();
  const month = String(kstTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kstTime.getUTCDate()).padStart(2, '0');
  const hour = String(kstTime.getUTCHours()).padStart(2, '0');
  const minute = String(kstTime.getUTCMinutes()).padStart(2, '0');
  const second = String(kstTime.getUTCSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
};

// DB 결과를 JSON 형식으로 변환
const convertDbRowToJson = (row) => {
  return {
    id: row.user_id,
    dateTime: row.date_time ? formatKoreaDateTimeFromDate(row.date_time) : getKSTDateTime(),
    stockCode: row.stock_code,
    buy_price: row.buy_price,
    buy_qty: row.buy_qty,
    sell_completed: row.sell_completed,
    sell_price: row.sell_price
  };
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

// completed_buy 항목 추가
const addCompletedBuy = async (userId, stockCode, buyPrice, buyQty) => {
  try {
    const dateTime = getKSTDateTime();
    
    const result = await pool.query(
      `INSERT INTO completed_buy (
        user_id, date_time, stock_code, buy_price, buy_qty, sell_completed, sell_price
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        String(userId),
        new Date(dateTime),
        stockCode,
        buyPrice,
        buyQty,
        'N',
        null
      ]
    );
    
    return convertDbRowToJson(result.rows[0]);
  } catch (error) {
    console.error('[completedBuyStore] addCompletedBuy 오류:', error);
    throw error;
  }
};

// 모든 completed_buy 조회 (userId 필터링)
const getAllCompletedBuy = async (userId = null) => {
  try {
    let result;
    if (userId === null) {
      result = await pool.query('SELECT * FROM completed_buy ORDER BY date_time DESC');
    } else {
      result = await pool.query(
        'SELECT * FROM completed_buy WHERE user_id = $1 ORDER BY date_time DESC',
        [String(userId)]
      );
    }
    
    return result.rows.map(row => convertDbRowToJson(row));
  } catch (error) {
    console.error('[completedBuyStore] getAllCompletedBuy 오류:', error);
    return [];
  }
};

// 종목코드로 completed_buy 조회
const getCompletedBuyByStockCode = async (userId, stockCode) => {
  try {
    const result = await pool.query(
      'SELECT * FROM completed_buy WHERE user_id = $1 AND stock_code = $2 ORDER BY date_time DESC',
      [String(userId), stockCode]
    );
    
    return result.rows.map(row => convertDbRowToJson(row));
  } catch (error) {
    console.error('[completedBuyStore] getCompletedBuyByStockCode 오류:', error);
    return [];
  }
};

// sell_completed 상태 업데이트 (종목코드 전체)
const updateSellCompleted = async (userId, stockCode, completed) => {
  try {
    const result = await pool.query(
      `UPDATE completed_buy 
       SET sell_completed = $1
       WHERE user_id = $2 AND stock_code = $3 AND sell_completed = 'N'`,
      [completed ? 'Y' : 'N', String(userId), stockCode]
    );
    
    return result.rowCount > 0;
  } catch (error) {
    console.error('[completedBuyStore] updateSellCompleted 오류:', error);
    throw error;
  }
};

// sell_completed 상태 업데이트 (특정 매수 내역)
const updateSellCompletedByDateTime = async (userId, stockCode, buyDateTime, completed, targetSellId = null, sellPrice = null) => {
  try {
    const userIdStr = targetSellId ? String(targetSellId) : String(userId);
    
    const result = await pool.query(
      `UPDATE completed_buy 
       SET sell_completed = $1, sell_price = COALESCE($2, sell_price)
       WHERE user_id = $3 AND stock_code = $4 AND date_time = $5 AND sell_completed = 'N'`,
      [
        completed ? 'Y' : 'N',
        sellPrice,
        userIdStr,
        stockCode,
        new Date(buyDateTime)
      ]
    );
    
    return result.rowCount > 0;
  } catch (error) {
    console.error('[completedBuyStore] updateSellCompletedByDateTime 오류:', error);
    throw error;
  }
};

// 체결 가격 업데이트 (주문 성공 시 목표가격으로 기록된 것을 실제 체결 가격으로 업데이트)
const updateBuyPrice = async (userId, stockCode, buyPrice, buyQty) => {
  try {
    // 가장 최근 항목(같은 userId와 종목코드, sell_completed='N')을 찾아서 업데이트
    const result = await pool.query(
      `UPDATE completed_buy 
       SET buy_price = $1, buy_qty = $2
       WHERE id = (
         SELECT id FROM completed_buy 
         WHERE user_id = $3 AND stock_code = $4 AND sell_completed = 'N'
         ORDER BY date_time DESC
         LIMIT 1
       )
       AND (buy_price = 0 OR buy_price != $1)
       RETURNING *`,
      [buyPrice, buyQty, String(userId), stockCode]
    );
    
    if (result.rows.length === 0) {
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('[completedBuyStore] updateBuyPrice 오류:', error);
    throw error;
  }
};

module.exports = {
  addCompletedBuy,
  getAllCompletedBuy,
  getCompletedBuyByStockCode,
  updateSellCompleted,
  updateSellCompletedByDateTime,
  updateBuyPrice,
};

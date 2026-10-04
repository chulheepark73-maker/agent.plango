/**
 * 미국주식 종목 마스터 (us_stock_list)
 * 국내 stock_list / stockListStore 와 동일 역할
 */

const pool = require('./db');

let tableReady = false;

const normalizeTicker = (raw) => String(raw || '').trim().toUpperCase();

const ensureUsStockListTable = async () => {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS us_stock_list (
      ticker VARCHAR(20) PRIMARY KEY,
      stock_name VARCHAR(200) NOT NULL DEFAULT '',
      exchange VARCHAR(40),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_us_stock_list_name
    ON us_stock_list (stock_name)
  `);
  tableReady = true;
};

ensureUsStockListTable().catch((error) => {
  console.error('[usStockListStore] ensureUsStockListTable 실패:', error.message);
});

const rowToItem = (row) => ({
  ticker: row.ticker,
  stockCode: row.ticker,
  stockName: row.stock_name || row.ticker,
  exchange: row.exchange || null,
  updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
});

/**
 * 전체 교체 UPSERT (배치)
 * @param {Array<{ ticker?: string, stockCode?: string, stockName?: string, exchange?: string }>} stockList
 */
const writeUsStockList = async (stockList) => {
  await ensureUsStockListTable();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const map = new Map();
    (stockList || []).forEach((stock) => {
      const ticker = normalizeTicker(stock.ticker || stock.stockCode);
      if (!ticker) return;
      const stockName = String(stock.stockName || ticker).trim() || ticker;
      const exchange = stock.exchange ? String(stock.exchange).trim() : null;
      map.set(ticker, { ticker, stockName, exchange });
    });

    const rows = Array.from(map.values());
    if (rows.length === 0) {
      await client.query('COMMIT');
      return { totalCount: 0 };
    }

    // 전체 교체: 삭제 후 재삽입 (폐지 종목 정리)
    await client.query('DELETE FROM us_stock_list');

    const CHUNK = 400;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values = chunk
        .map((_, index) => {
          const base = index * 3;
          return `($${base + 1}, $${base + 2}, $${base + 3}, NOW())`;
        })
        .join(', ');
      const params = chunk.flatMap((s) => [s.ticker, s.stockName, s.exchange]);
      await client.query(
        `INSERT INTO us_stock_list (ticker, stock_name, exchange, updated_at)
         VALUES ${values}
         ON CONFLICT (ticker) DO UPDATE SET
           stock_name = EXCLUDED.stock_name,
           exchange = COALESCE(EXCLUDED.exchange, us_stock_list.exchange),
           updated_at = NOW()`,
        params
      );
    }

    await client.query('COMMIT');
    return { totalCount: rows.length };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[usStockListStore] writeUsStockList 오류:', error);
    throw error;
  } finally {
    client.release();
  }
};

/**
 * 티커 또는 종목명 검색
 * @param {string} query
 * @param {{ returnAll?: boolean, limit?: number }} [opts]
 */
const searchUsStock = async (query, opts = {}) => {
  await ensureUsStockListTable();
  const returnAll = !!opts.returnAll;
  const limit = Math.min(Math.max(Number(opts.limit) || (returnAll ? 50 : 1), 1), 100);
  const q = String(query || '').trim();
  if (!q) return returnAll ? [] : null;

  const ticker = normalizeTicker(q);

  // 1) 티커 정확 일치
  let result = await pool.query(
    `SELECT ticker, stock_name, exchange, updated_at
     FROM us_stock_list WHERE ticker = $1
     LIMIT $2`,
    [ticker, limit]
  );
  if (result.rows.length > 0) {
    const matches = result.rows.map(rowToItem);
    return returnAll ? matches : matches[0];
  }

  // 2) 티커 prefix
  result = await pool.query(
    `SELECT ticker, stock_name, exchange, updated_at
     FROM us_stock_list
     WHERE ticker LIKE $1
     ORDER BY ticker
     LIMIT $2`,
    [`${ticker}%`, limit]
  );
  if (result.rows.length > 0) {
    const matches = result.rows.map(rowToItem);
    return returnAll ? matches : matches[0];
  }

  // 3) 종목명 ILIKE
  result = await pool.query(
    `SELECT ticker, stock_name, exchange, updated_at
     FROM us_stock_list
     WHERE stock_name ILIKE $1
     ORDER BY
       CASE WHEN stock_name ILIKE $2 THEN 0 ELSE 1 END,
       stock_name
     LIMIT $3`,
    [`%${q}%`, `${q}%`, limit]
  );
  if (result.rows.length > 0) {
    const matches = result.rows.map(rowToItem);
    return returnAll ? matches : matches[0];
  }

  return returnAll ? [] : null;
};

const getUsStockByTicker = async (tickerRaw) => {
  await ensureUsStockListTable();
  const ticker = normalizeTicker(tickerRaw);
  if (!ticker) return null;
  const result = await pool.query(
    `SELECT ticker, stock_name, exchange, updated_at
     FROM us_stock_list WHERE ticker = $1 LIMIT 1`,
    [ticker]
  );
  return result.rows[0] ? rowToItem(result.rows[0]) : null;
};

const getUsStockListCount = async () => {
  await ensureUsStockListTable();
  const result = await pool.query('SELECT COUNT(*)::int AS cnt FROM us_stock_list');
  return result.rows[0]?.cnt || 0;
};

module.exports = {
  ensureUsStockListTable,
  writeUsStockList,
  searchUsStock,
  getUsStockByTicker,
  getUsStockListCount,
  normalizeTicker,
};

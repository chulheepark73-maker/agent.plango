/**
 * data.csv → stock_list_nxt 전체 교체
 * 사용: node scripts/import_nxt_from_data_csv.js [csvPath]
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../utils/db');
const { writeStockListNxtFile, isNXTStock } = require('../utils/stockListStore');

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const stocks = [];
  for (const line of lines) {
    const idx = line.indexOf(',');
    if (idx < 0) continue;
    const stockCode = line.slice(0, idx).trim();
    const stockName = line.slice(idx + 1).trim();
    if (!stockCode) continue;
    stocks.push({ stockCode, stockName });
  }
  return stocks;
}

(async () => {
  const csvPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', '..', 'data.csv');

  if (!fs.existsSync(csvPath)) {
    console.error('CSV 없음:', csvPath);
    process.exit(1);
  }

  const stocks = parseCsv(csvPath);
  console.log(`CSV: ${csvPath} (${stocks.length}건)`);

  await writeStockListNxtFile(stocks);

  const count = await pool.query('SELECT COUNT(*)::int AS n FROM stock_list_nxt');
  console.log('stock_list_nxt count:', count.rows[0].n);

  const dl = await pool.query(
    "SELECT stock_code, stock_name FROM stock_list_nxt WHERE stock_code LIKE '375500%'"
  );
  console.log('DL in nxt:', dl.rows);
  console.log('isNXTStock(375500):', await isNXTStock('375500'));

  await pool.end();
  console.log('완료');
})().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});

/**
 * usa20100 단건/배치 검증
 * 사용: node scripts/test_us_quote_batch.js [userId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pool = require('../utils/tradingDb');
const { getOwnerUserId } = require('../utils/agentIdentity');
const { getKiwoomInfo } = require('../utils/kiwoomUtils');
const kiwoomAPI = require('../services/kiwoomApi');

async function resolveUserId(arg) {
  if (arg) return String(arg);
  const ownerId = getOwnerUserId();
  if (!ownerId) return null;
  const info = await getKiwoomInfo(ownerId).catch(() => null);
  return info?.accessToken ? String(ownerId) : null;
}

async function main() {
  const userId = await resolveUserId(process.argv[2]);
  if (!userId) {
    console.error('accessToken 있는 사용자를 찾지 못했습니다.');
    process.exit(1);
  }

  const kiwoomInfo = await getKiwoomInfo(userId);
  const tickers = ['AAPL', 'MSFT', 'TSLA'];
  console.log(`\n[test] userId=${userId}, tickers=${tickers.join(',')}\n`);

  // 1) | 배치 직접 호출 (기대: 실패)
  try {
    const result = await kiwoomAPI.postUsTr(
      kiwoomInfo.accessToken,
      '/api/us/mrkcond',
      'usa20100',
      { stk_cd: tickers.join('|'), stex_tp: 'ND' }
    );
    const rows = kiwoomAPI.extractResponseArray(result.data);
    console.log(`[test] | 배치 응답 rows=${rows.length}`, rows.slice(0, 2));
  } catch (e) {
    console.log(`[test] | 배치 거부(예상): ${e.message}`);
  }

  // 2) getUsStockQuotes (단건 순차 + us_stock_list exchange)
  const t0 = Date.now();
  const quotes = await kiwoomAPI.getUsStockQuotes(kiwoomInfo.accessToken, tickers);
  console.log(`\n[test] getUsStockQuotes (${Date.now() - t0}ms) count=${quotes.length}`);
  for (const q of quotes) {
    console.log(`  - ${q.stockCode} ${q.stockName} $${q.price} (${q.exchange})`);
  }

  pool.close();
}

main().catch((e) => {
  console.error(e);
  pool.close();
  process.exit(1);
});

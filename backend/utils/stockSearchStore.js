/**
 * 종목 검색 전용 — stock_list / us_stock_list 마스터
 * watchlist API와 분리
 */
const { searchStockByName } = require('./stockListStore');
const { searchUsStock } = require('./usStockListStore');

/**
 * @param {string} query
 * @returns {Promise<Array<{ stockCode, stockName, stockMarket, market, currency, exchange }>>}
 */
const searchStocks = async (query) => {
  const q = String(query || '').trim();
  if (!q) return [];

  const looksLikeTicker = /^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(q);
  const canSearchKr = q.length >= 2 || /^\d{4,6}$/.test(q);
  const canSearchUs = q.length >= 1;

  const [krHit, usHit] = await Promise.all([
    canSearchKr
      ? searchStockByName(q, false)
          .then((found) =>
            found
              ? {
                  stockCode: found.stockCode,
                  stockName: found.stockName,
                  stockMarket: 'KRX',
                  market: 'KR',
                  currency: 'KRW',
                  exchange: 'KRX',
                }
              : null
          )
          .catch(() => null)
      : Promise.resolve(null),
    canSearchUs
      ? searchUsStock(q, { returnAll: false })
          .then((found) =>
            found
              ? {
                  stockCode: found.ticker,
                  stockName: found.stockName,
                  stockMarket: 'US',
                  market: 'US',
                  currency: 'USD',
                  exchange: found.exchange || null,
                }
              : null
          )
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const results = [];
  if (looksLikeTicker) {
    if (usHit) results.push(usHit);
    if (krHit) results.push(krHit);
  } else {
    if (krHit) results.push(krHit);
    if (usHit) results.push(usHit);
  }
  return results;
};

module.exports = {
  searchStocks,
};

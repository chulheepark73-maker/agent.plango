/**
 * KRX 주식 호가 단위 (가격대별)
 * @param {number} price
 * @returns {number}
 */
const getTickSize = (price) => {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
};

/**
 * 호가 단위에 맞게 가격 조정 (버림 — 지정가 매수용)
 * @param {number} price
 * @param {string} [stockMarket='KRX']
 * @returns {number}
 */
const adjustPriceToTickSize = (price, stockMarket = 'KRX') => {
  if (price == null || !Number.isFinite(price) || price <= 0) return 0;
  if (String(stockMarket || '').toUpperCase() === 'US') {
    return Math.round(price * 100) / 100;
  }
  const tickSize = getTickSize(price);
  return Math.floor(price / tickSize) * tickSize;
};

/**
 * 매도 목표가: 호가 올림 (익절% 아래로 내려가지 않게)
 */
const adjustSellPriceToTickSize = (price, stockMarket = 'KRX') => {
  if (price == null || !Number.isFinite(price) || price <= 0) return 0;
  if (String(stockMarket || '').toUpperCase() === 'US') {
    return Math.round(price * 100) / 100;
  }
  const tickSize = getTickSize(price);
  return Math.ceil(price / tickSize) * tickSize;
};

/** 평단 표시: 국내는 원 단위, 미국은 센트 */
const roundAvgCostForDisplay = (price, stockMarket = 'KRX') => {
  if (price == null || !Number.isFinite(price) || price <= 0) return 0;
  if (String(stockMarket || '').toUpperCase() === 'US') {
    return Math.round(price * 100) / 100;
  }
  return Math.round(price);
};

/**
 * 매수금액 기준 주문 가능 수량
 */
const computeBuyQtyFromAmount = (buyAmount, orderPrice) => {
  if (orderPrice == null || !Number.isFinite(orderPrice) || orderPrice <= 0) return null;
  const amount = Number(buyAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const qty = Math.floor(amount / orderPrice);
  return qty >= 1 ? qty : null;
};

/**
 * 매수예상가(호가 조정) + 수량
 */
const normalizeBuyOrderFields = (buyAmount, rawBuyExpectedPrice) => {
  if (rawBuyExpectedPrice == null || !Number.isFinite(rawBuyExpectedPrice)) {
    return { buyExpectedPrice: null, buyQty: null };
  }
  const buyExpectedPrice = adjustPriceToTickSize(rawBuyExpectedPrice);
  if (buyExpectedPrice <= 0) {
    return { buyExpectedPrice: null, buyQty: null };
  }
  const buyQty = computeBuyQtyFromAmount(buyAmount, buyExpectedPrice);
  return { buyExpectedPrice, buyQty };
};

module.exports = {
  getTickSize,
  adjustPriceToTickSize,
  adjustSellPriceToTickSize,
  roundAvgCostForDisplay,
  computeBuyQtyFromAmount,
  normalizeBuyOrderFields,
};

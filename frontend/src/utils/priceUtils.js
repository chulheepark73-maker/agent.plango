/**
 * 주식 가격에 따른 호가 단위 반환 (국내)
 * @param {number} price - 주식 가격
 * @returns {number} 호가 단위
 */
export const getTickSize = (price) => {
  if (price < 2000) {
    return 1;
  } else if (price < 5000) {
    return 5;
  } else if (price < 20000) {
    return 10;
  } else if (price < 50000) {
    return 50;
  } else if (price < 200000) {
    return 100;
  } else if (price < 500000) {
    return 500;
  } else {
    return 1000;
  }
};

/** 미국주식: 센트(소수 2자리) 호가 */
export const getUsTickSize = () => 0.01;

/**
 * 미국 가격을 센트 단위로 반올림 (소수 2자리)
 * @param {number} price
 * @returns {number}
 */
export const adjustUsPriceToCents = (price) => {
  if (!price || price <= 0) return 0;
  return Math.round(Number(price) * 100) / 100;
};

/**
 * 주식 가격을 호가 단위에 맞게 조정
 * @param {number} price - 조정할 가격
 * @param {string} [stockMarket='KRX'] - US면 센트(2자리), 그 외 국내 호가 버림
 * @returns {number} 호가 단위에 맞게 조정된 가격
 */
export const adjustPriceToTickSize = (price, stockMarket = 'KRX') => {
  if (!price || price <= 0) return 0;

  if (String(stockMarket || '').toUpperCase() === 'US') {
    return adjustUsPriceToCents(price);
  }

  const tickSize = getTickSize(price);
  // 버림 처리
  return Math.floor(price / tickSize) * tickSize;
};

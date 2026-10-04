/**
 * 실현 손익 계산 (KR/US 수수료·거래세 반영)
 * 계좌별 비율은 broker_accounts → feeRates 로 전달.
 */

/** 기본값 (broker_accounts 컬럼 DEFAULT 와 동일) */
export const DEFAULT_FEE_RATES = {
  buyFeeRate: 0.000125,
  sellFeeRate: 0.000125,
  sellTaxRate: 0.0018,
  usBuyFeeRate: 0,
  usSellFeeRate: 0,
  usSellTaxRate: 0,
};

const isUsMarket = (stockMarket) => String(stockMarket || '').toUpperCase() === 'US';

const resolveMarketRates = (feeRates, isUs) => {
  if (isUs) {
    return {
      buyFeeRate:
        feeRates?.usBuyFeeRate != null && Number.isFinite(Number(feeRates.usBuyFeeRate))
          ? Number(feeRates.usBuyFeeRate)
          : DEFAULT_FEE_RATES.usBuyFeeRate,
      sellFeeRate:
        feeRates?.usSellFeeRate != null && Number.isFinite(Number(feeRates.usSellFeeRate))
          ? Number(feeRates.usSellFeeRate)
          : DEFAULT_FEE_RATES.usSellFeeRate,
      sellTaxRate:
        feeRates?.usSellTaxRate != null && Number.isFinite(Number(feeRates.usSellTaxRate))
          ? Number(feeRates.usSellTaxRate)
          : DEFAULT_FEE_RATES.usSellTaxRate,
    };
  }
  return {
    buyFeeRate: Number(feeRates?.buyFeeRate) || DEFAULT_FEE_RATES.buyFeeRate,
    sellFeeRate: Number(feeRates?.sellFeeRate) || DEFAULT_FEE_RATES.sellFeeRate,
    sellTaxRate: Number(feeRates?.sellTaxRate) || DEFAULT_FEE_RATES.sellTaxRate,
  };
};

/** KR: 원미만 절사 / US: 센트 미만 절사 */
const truncFee = (raw, isUs) =>
  isUs ? Math.floor(raw * 100) / 100 : Math.floor(raw);

/** 왕복 제비용 (수수료+거래세) */
export const calcTradeFees = (buyAmount, sellAmount, feeRates, stockMarket = 'KRX') => {
  const buyAmt = Number(buyAmount) || 0;
  const sellAmt = Number(sellAmount) || 0;
  if (!(buyAmt > 0) || !(sellAmt > 0)) return 0;
  const isUs = isUsMarket(stockMarket);
  const rates = resolveMarketRates(feeRates, isUs);
  return (
    truncFee(buyAmt * rates.buyFeeRate, isUs) +
    truncFee(sellAmt * rates.sellFeeRate, isUs) +
    truncFee(sellAmt * rates.sellTaxRate, isUs)
  );
};

/** @deprecated calcTradeFees 사용 */
export const calcKrTradeFees = (buyAmount, sellAmount, feeRates) =>
  calcTradeFees(buyAmount, sellAmount, feeRates, 'KRX');

/** 비율(0.000125) → 화면 표시용 % (0.0125) */
export const rateToPercent = (rate) => {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000000) / 10000;
};

/** 화면 % (0.0125) → 비율(0.000125) */
export const percentToRate = (percent) => {
  const n = Number(percent);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
};

export const calculateProfit = ({
  buyPrice = 0,
  sellPrice = 0,
  qty = 0,
  stockMarket = 'KRX',
  feeRates,
} = {}) => {
  const parsedBuyPrice = Number(buyPrice) || 0;
  const parsedSellPrice = Number(sellPrice) || 0;
  const parsedQty = Number(qty) || 0;

  const buyAmount = parsedBuyPrice * parsedQty;
  const sellAmount = parsedSellPrice * parsedQty;
  const gross = sellAmount - buyAmount;

  const fees = calcTradeFees(buyAmount, sellAmount, feeRates, stockMarket);
  const profitAmount = gross - fees;
  const profitRate = buyAmount > 0 ? (profitAmount / buyAmount) * 100 : 0;

  return {
    profitAmount,
    profitRate,
    fees,
    gross,
    isProfit: profitAmount >= 0,
    isValid: parsedBuyPrice > 0 && parsedQty > 0,
  };
};

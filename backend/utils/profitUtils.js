/**
 * 실현 손익 — KR/US 수수료·거래세 반영 (프론트 profitUtils와 동일)
 */

const { DEFAULT_FEE_RATES: STORE_DEFAULTS } = (() => {
  try {
    return require('./brokerCredentialsStore');
  } catch {
    return {
      DEFAULT_FEE_RATES: {
        buyFeeRate: 0.000125,
        sellFeeRate: 0.000125,
        sellTaxRate: 0.0018,
        usBuyFeeRate: 0,
        usSellFeeRate: 0,
        usSellTaxRate: 0,
      },
    };
  }
})();

const DEFAULT_FEE_RATES = {
  buyFeeRate: 0.000125,
  sellFeeRate: 0.000125,
  sellTaxRate: 0.0018,
  usBuyFeeRate: 0,
  usSellFeeRate: 0,
  usSellTaxRate: 0,
  ...STORE_DEFAULTS,
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

const truncFee = (raw, isUs) => (isUs ? Math.floor(raw * 100) / 100 : Math.floor(raw));

const calcTradeFees = (buyAmount, sellAmount, feeRates, stockMarket = 'KRX') => {
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

const calcKrTradeFees = (buyAmount, sellAmount, feeRates) =>
  calcTradeFees(buyAmount, sellAmount, feeRates, 'KRX');

/**
 * @param {{ buyPrice:number, sellPrice:number, qty:number, stockMarket?:string, feeRates?: object }} opts
 */
const calculateProfit = ({
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
  return {
    profitAmount,
    fees,
    gross,
    isProfit: profitAmount >= 0,
    isValid: parsedBuyPrice > 0 && parsedQty > 0,
  };
};

module.exports = {
  calculateProfit,
  calcTradeFees,
  calcKrTradeFees,
  DEFAULT_FEE_RATES,
};

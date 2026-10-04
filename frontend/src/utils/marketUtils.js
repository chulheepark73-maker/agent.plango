/**
 * 국내/미국 종목 구분
 * - 미국 티커: 첫 글자가 영문 (AAPL, NVDA, BRK.B)
 * - 국내: 첫 글자가 숫자 (005930, 0181B0, 0011T0)
 *   코드 중간 영문만으로는 미국으로 보지 않음
 */

export const looksLikeUsTicker = (stockCode) => {
  const first = String(stockCode || '').trim().charAt(0);
  return /[A-Za-z]/.test(first);
};

export const isUsMarket = (stockMarket, stockCode) => {
  const m = String(stockMarket || '').toUpperCase();
  if (m === 'US') return true;
  if (m === 'KRX' || m === 'NXT' || m === 'KR') return false;
  return looksLikeUsTicker(stockCode);
};

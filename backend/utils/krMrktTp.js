/**
 * 키움 ka10099 mrkt_tp
 * 0 코스피, 10 코스닥, 8 ETF, 60 ETN, 70 손실제한 ETN, 90 변동성 ETN
 */

const ETF_LIKE_MRKT_TPS = new Set(['8', '60', '70', '90']);

/** 종목 목록 동기화 시 조회할 시장 (일반 → ETF/ETN 순, 뒤가 덮어씀) */
const KR_MRKT_TPS_TO_FETCH = ['0', '10', '8', '60', '70', '90'];

const isEtfLikeMrktTp = (tp) => ETF_LIKE_MRKT_TPS.has(String(tp ?? '').trim());

const normalizeKrSymbol = (symbol) =>
  String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/_NX$/i, '')
    .substring(0, 6);

module.exports = {
  ETF_LIKE_MRKT_TPS,
  KR_MRKT_TPS_TO_FETCH,
  isEtfLikeMrktTp,
  normalizeKrSymbol,
};

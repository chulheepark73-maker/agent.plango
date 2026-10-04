/**
 * 국내/미국 자동매매 공통 헬퍼 (스토어·주문·세션·종목키)
 */

/** 종목코드 첫 글자: 영문→US 티커, 숫자→국내(영문 포함 코드 0011T0 등) */
const looksLikeUsTicker = (stockCode) => {
  const first = String(stockCode || '').trim().charAt(0);
  return /[A-Za-z]/.test(first);
};

const isUsMarket = (stockMarket, stockCode) => {
  const m = String(stockMarket || '').toUpperCase();
  if (m === 'US') return true;
  if (m === 'KRX' || m === 'NXT') return false;
  return looksLikeUsTicker(stockCode);
};

/** 감시·맵 키: 미국=티커 전체, 국내=6자리 */
const normalizeAutoCode = (stockCode, stockMarket) => {
  const s = String(stockCode || '').trim();
  if (!s) return '';
  if (isUsMarket(stockMarket, s)) return s.toUpperCase();
  return s.substring(0, 6);
};

const autoCodesMatch = (a, b, stockMarket) => {
  const left = normalizeAutoCode(a, stockMarket);
  const right = normalizeAutoCode(b, stockMarket);
  if (!left || !right) return false;
  if (isUsMarket(stockMarket, left) || isUsMarket(stockMarket, right)) {
    return left.toUpperCase() === right.toUpperCase();
  }
  return left === right || left.startsWith(right) || right.startsWith(left);
};

const isSessionOpenForMarket = (stockMarket) => {
  const { isNXTTradingHours, isUsTradingHours, isKRXSessionOpen } = require('./stockUtils');
  if (stockMarket === 'US') return isUsTradingHours();
  if (stockMarket === 'NXT') return isNXTTradingHours() || isKRXSessionOpen();
  return isKRXSessionOpen();
};

/** 체결가 반올림: 미국 센트, 국내 원 */
const roundFillPrice = (raw, stockMarket) => {
  const n = Math.abs(parseFloat(raw) || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (stockMarket === 'US') return Math.round(n * 100) / 100;
  return Math.round(n) || 0;
};

/** 텔레그램 등 표시용 가격 (US: $12.34, KR: 12,345원) */
const formatTelegramPrice = (raw, stockMarket) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw ?? '');
  if (stockMarket === 'US') {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${Math.round(n).toLocaleString('ko-KR')}원`;
};

const getMarketCutoffConfig = (stockMarket) => {
  if (stockMarket === 'US') {
    // 애프터마켓 종료(NY 20:00 ≈ KST 09:00)까지 체결확인·감시 유지
    return { label: '20:00(US/NY애프터)', tz: 'America/New_York', hour: 20, minute: 0 };
  }
  const { isNXTTradingHours, isKRXAfterMarketHours, isKRXExtendedCloseHours } = require('./stockUtils');
  // NXT는 오전만 — 오전 세션 중 컷오프 08:50
  if (stockMarket === 'NXT' && isNXTTradingHours()) {
    return { hour: 8, minute: 50, label: '08:50(NXT)', tz: 'Asia/Seoul' };
  }
  // NXT 상장 종목이라도 이후 장은 KRX로 거래 → KRX 컷오프
  if (isKRXAfterMarketHours()) {
    return { hour: 20, minute: 0, label: '20:00(KRX애프터)', tz: 'Asia/Seoul' };
  }
  if (isKRXExtendedCloseHours()) {
    return { hour: 16, minute: 0, label: '16:00(KRX시간외종가)', tz: 'Asia/Seoul' };
  }
  return { hour: 15, minute: 30, label: '15:30(KRX)', tz: 'Asia/Seoul' };
};

const getMsUntilMarketCutoff = (stockMarket) => {
  const { tz, hour, minute } = getMarketCutoffConfig(stockMarket);
  const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const cutoff = new Date(localNow);
  cutoff.setHours(hour, minute, 0, 0);
  return cutoff.getTime() - localNow.getTime();
};

const resolveUsStexTp = async (ticker) => {
  const { getUsStockByTicker } = require('./usStockListStore');
  const { normalizeUsStexTp } = require('../services/kiwoomRealtimeClient');
  const master = await getUsStockByTicker(ticker);
  return normalizeUsStexTp(master?.exchange || 'ND');
};

/**
 * 미국 stex_tp — us_stock_list 마스터 우선 (V2 venue 기본 NASDAQ 오지정 방지)
 * @param {string} ticker
 * @param {string|null} [hint] 클라이언트/venue 힌트
 */
const resolveUsStexTpPreferMaster = async (ticker, hint = null) => {
  const { getUsStockByTicker } = require('./usStockListStore');
  const { normalizeUsStexTp } = require('../services/kiwoomRealtimeClient');
  const master = await getUsStockByTicker(ticker);
  if (master?.exchange) return normalizeUsStexTp(master.exchange);
  if (hint != null && String(hint).trim() !== '') return normalizeUsStexTp(hint);
  return 'ND';
};

/**
 * @param {object} kiwoomInfo
 * @param {{ symbol, orderType, quantity, priceType, price }} orderData
 * @param {string} stockMarket
 */
const placeAutoMarketOrder = async (kiwoomInfo, orderData, stockMarket = 'KRX') => {
  const kiwoomAPI = require('../services/kiwoomApi');
  if (stockMarket === 'US') {
    const stexTp = await resolveUsStexTp(orderData.symbol);
    return kiwoomAPI.placeUsOrder(
      {
        ...orderData,
        symbol: String(orderData.symbol || '').trim().toUpperCase(),
      },
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      kiwoomInfo.accountNo,
      stexTp
    );
  }
  return kiwoomAPI.placeOrder(
    orderData,
    kiwoomInfo.accessToken,
    kiwoomInfo.appKey,
    kiwoomInfo.appSecret,
    kiwoomInfo.accountNo,
    stockMarket
  );
};

module.exports = {
  isUsMarket,
  looksLikeUsTicker,
  normalizeAutoCode,
  autoCodesMatch,
  isSessionOpenForMarket,
  roundFillPrice,
  formatTelegramPrice,
  getMarketCutoffConfig,
  getMsUntilMarketCutoff,
  resolveUsStexTp,
  resolveUsStexTpPreferMaster,
  placeAutoMarketOrder,
};

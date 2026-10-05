const { isFixedHolidayDate } = require('./holidays');

/** 한국(Asia/Seoul) 기준 오늘 날짜 YYYY-MM-DD */
const getKoreaDateString = (date = new Date()) => {
  const koreaDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const year = koreaDate.getFullYear();
  const month = String(koreaDate.getMonth() + 1).padStart(2, '0');
  const day = String(koreaDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// 주말 여부 확인 (한국 시간 기준)
const isWeekend = () => {
  const now = new Date();
  const koreaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const dayOfWeek = koreaTime.getDay();
  return dayOfWeek === 0 || dayOfWeek === 6; // 일요일(0) 또는 토요일(6)
};

// 휴장일 확인 (한국 시간 기준, frontend/src/data/holidays.json 목록)
const isHolidaySync = () => isFixedHolidayDate(getKoreaDateString());

const isHoliday = async () => isHolidaySync();

// 거래시간 확인 (한국 시간 기준 09:00-15:30 정규장)
const isTradingHours = () => {
  const now = new Date();
  const koreaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const hour = koreaTime.getHours();
  const minute = koreaTime.getMinutes();
  const timeInMinutes = hour * 60 + minute;
  
  // 평일만 확인 (토요일, 일요일 제외)
  if (isWeekend()) {
    return false; // 주말
  }
  
  // 휴일 체크 (동기 방식, 캐시 사용)
  if (isHolidaySync()) {
    return false; // 휴일
  }
  
  // 09:00-15:30 거래시간
  const startTime = 9 * 60; // 09:00
  const endTime = 15 * 60 + 30; // 15:30
  
  return timeInMinutes >= startTime && timeInMinutes <= endTime;
};

/** KRX 장후 시간외 종가 (15:30~16:00, 주중·비공휴) — 정규장과 15:30 분 겹침 시 정규장 우선 */
const isKRXExtendedCloseHours = () => {
  if (isWeekend()) return false;
  if (isHolidaySync()) return false;

  const koreaTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const timeInMinutes = koreaTime.getHours() * 60 + koreaTime.getMinutes();
  const startTime = 15 * 60 + 30; // 15:30
  const endTime = 16 * 60; // 16:00 (미만)
  return timeInMinutes >= startTime && timeInMinutes < endTime;
};

/** KRX 애프터마켓 (한국 시간 16:00-20:00, 주중·비공휴) */
const isKRXAfterMarketHours = () => {
  if (isWeekend()) return false;
  if (isHolidaySync()) return false;

  const koreaTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const timeInMinutes = koreaTime.getHours() * 60 + koreaTime.getMinutes();
  const startTime = 16 * 60; // 16:00
  const endTime = 20 * 60; // 20:00
  return timeInMinutes >= startTime && timeInMinutes <= endTime;
};

/** KRX 정규장 · 장후 시간외 종가 · 애프터마켓 */
const isKRXSessionOpen = () =>
  isTradingHours() || isKRXExtendedCloseHours() || isKRXAfterMarketHours();

// NXT 거래시간 확인 (한국 시간 기준 08:00-08:50만 — 이후는 KRX)
const isNXTTradingHours = () => {
  const now = new Date();
  const koreaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const hour = koreaTime.getHours();
  const minute = koreaTime.getMinutes();
  const timeInMinutes = hour * 60 + minute;
  
  // 평일만 확인 (토요일, 일요일 제외)
  if (isWeekend()) {
    return false; // 주말
  }
  
  // 휴일 체크 (동기 방식, 캐시 사용)
  if (isHolidaySync()) {
    return false; // 휴일
  }
  
  // 08:00-08:50 NXT 거래시간
  const morningStartTime = 8 * 60; // 08:00
  const morningEndTime = 8 * 60 + 50; // 08:50
  
  return timeInMinutes >= morningStartTime && timeInMinutes <= morningEndTime;
};

/**
 * KRX 개장 직전 예열 구간 (한국시간 08:50~09:00)
 *
 * NXT 종료(08:50)와 KRX 개장(09:00) 사이 공백에 실시간 연결이 끊기면
 * 09:00 직후 편입 종목을 놓친다. 주문 가능 여부(isTradingHours)와는 무관하며,
 * WebSocket·시세 REG를 미리 붙여두는 용도. 조건검색 CNSRREQ는
 * isConditionRealtimeSubscribeTime(08:58~)에서 별도 허용한다.
 */
const isPreMarketWarmup = () => {
  const now = new Date();
  const koreaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const timeInMinutes = koreaTime.getHours() * 60 + koreaTime.getMinutes();

  if (isWeekend()) return false;
  if (isHolidaySync()) return false;

  return timeInMinutes >= 8 * 60 + 50 && timeInMinutes < 9 * 60;
};

/**
 * 조건검색 실시간(CNSRREQ) 구독 허용 시각 — 한국시간 08:58 이후
 * 그 전에는 키움이 응답하지 않아 타임아웃·재연결만 반복되는 경우가 많음.
 */
const CONDITION_SUBSCRIBE_START_MINUTES = 8 * 60 + 58;

const isConditionRealtimeSubscribeTime = () => {
  if (isWeekend()) return false;
  if (isHolidaySync()) return false;

  const koreaTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const timeInMinutes = koreaTime.getHours() * 60 + koreaTime.getMinutes();
  return timeInMinutes >= CONDITION_SUBSCRIBE_START_MINUTES;
};

/** 일봉(종가) API 조회 가능 시각 — 한국시간 08:00 이후 (NXT 프리마켓·당일 봉 반영) */
const isDailyBarFetchTime = () => {
  const koreaTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const timeInMinutes = koreaTime.getHours() * 60 + koreaTime.getMinutes();
  return timeInMinutes >= 8 * 60;
};

// 종목명 추출 (다양한 응답 구조 대응)
const extractStockName = (stockInfo) => {
  if (!stockInfo) return '';
  
  // atn_stk_infr 배열에서 추출
  if (stockInfo.atn_stk_infr && Array.isArray(stockInfo.atn_stk_infr) && stockInfo.atn_stk_infr.length > 0) {
    return stockInfo.atn_stk_infr[0].stk_nm || '';
  }
  
  // output 배열에서 추출
  if (stockInfo.output && Array.isArray(stockInfo.output) && stockInfo.output.length > 0) {
    return stockInfo.output[0].stk_nm || stockInfo.output[0].itm_nm || stockInfo.output[0].pdno_nm || '';
  }
  
  // output 객체에서 추출
  if (stockInfo.output && typeof stockInfo.output === 'object') {
    return stockInfo.output.stk_nm || stockInfo.output.itm_nm || stockInfo.output.pdno_nm || '';
  }
  
  // 직접 필드에서 추출
  return stockInfo.stk_nm || stockInfo.itm_nm || stockInfo.pdno_nm || '';
};

// 가격 정보 추출 (atn_stk_infr 배열 기준)
const extractPriceData = (stockInfo) => {
  if (!stockInfo || !stockInfo.atn_stk_infr || !Array.isArray(stockInfo.atn_stk_infr) || stockInfo.atn_stk_infr.length === 0) {
    return { price: 0, change: 0, changeRate: 0 };
  }
  
  const firstItem = stockInfo.atn_stk_infr[0];
  
  // 현재가: cur_prc (예: "+104500" -> 104500)
  const curPrcStr = String(firstItem.cur_prc || '0').replace(/[+\-]/g, '');
  const price = parseFloat(curPrcStr) || 0;
  
  // 전일대비: pred_pre (예: "+1100" -> 1100, "-1100" -> -1100)
  const predPreStr = String(firstItem.pred_pre || '0');
  const isNegative = predPreStr.startsWith('-');
  const predPreNum = parseFloat(predPreStr.replace(/[+\-]/g, '')) || 0;
  const change = isNegative ? -predPreNum : predPreNum;
  
  // 등락률: flu_rt (예: "+1.06" -> 1.06, "-1.06" -> -1.06)
  const fluRtStr = String(firstItem.flu_rt || '0');
  const isRateNegative = fluRtStr.startsWith('-');
  const fluRtNum = parseFloat(fluRtStr.replace(/[+\-%]/g, '')) || 0;
  const changeRate = isRateNegative ? -fluRtNum : fluRtNum;
  
  return { price, change, changeRate };
};

/** 거래량 정보 추출 (atn_stk_infr) — now_trde_qty, pred_trde_qty */
const extractVolumeData = (stockInfo) => {
  if (!stockInfo || !stockInfo.atn_stk_infr || !Array.isArray(stockInfo.atn_stk_infr) || stockInfo.atn_stk_infr.length === 0) {
    return { volume: null, prevVolume: null, volumeChangeRate: null };
  }

  const item = stockInfo.atn_stk_infr[0];
  const parseQty = (raw) => {
    if (raw === undefined || raw === null || raw === '') return null;
    const val = parseFloat(String(raw).trim().replace(/[+\-,]/g, ''));
    return Number.isFinite(val) && val >= 0 ? val : null;
  };

  const volumeFields = ['now_trde_qty', 'acml_vol', 'trde_qty', 'vol', 'volume'];
  const prevVolumeFields = ['pred_trde_qty', 'prev_trde_qty', 'pred_vol', 'prev_volume'];

  let volume = null;
  for (const field of volumeFields) {
    volume = parseQty(item[field]);
    if (volume != null) break;
  }

  let prevVolume = null;
  for (const field of prevVolumeFields) {
    prevVolume = parseQty(item[field]);
    if (prevVolume != null) break;
  }

  return { volume, prevVolume, volumeChangeRate: null };
};

/**
 * America/New_York 기준 요일·분(0–1439). 주말이면 weekday만 유효.
 * @returns {{ weekday: string, mins: number } | null}
 */
const getNewYorkTimeParts = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get('minute'), 10) || 0;
  if (!Number.isFinite(hour)) return null;
  return { weekday, mins: hour * 60 + minute };
};

const isNyWeekday = (weekday) => weekday !== 'Sat' && weekday !== 'Sun';

/**
 * 미국 프리마켓 (NY Mon–Fri 04:00–09:30)
 * ≈ KST 17:00–22:30 (EDT 기준, DST 시 ±1h)
 */
const isUsPreMarketHours = () => {
  const t = getNewYorkTimeParts();
  if (!t || !isNyWeekday(t.weekday)) return false;
  return t.mins >= 4 * 60 && t.mins < 9 * 60 + 30;
};

/**
 * 미국 정규장 (NY Mon–Fri 09:30–16:00)
 * ≈ KST 22:30–05:00 (EDT 기준)
 */
const isUsRegularHours = () => {
  const t = getNewYorkTimeParts();
  if (!t || !isNyWeekday(t.weekday)) return false;
  return t.mins >= 9 * 60 + 30 && t.mins < 16 * 60;
};

/**
 * 미국 애프터마켓 (NY Mon–Fri 16:00–20:00)
 * ≈ KST 05:00–09:00 (EDT 기준)
 */
const isUsAfterMarketHours = () => {
  const t = getNewYorkTimeParts();
  if (!t || !isNyWeekday(t.weekday)) return false;
  return t.mins >= 16 * 60 && t.mins < 20 * 60;
};

/**
 * 미국 감시·주문 가능 세션 (프리 + 정규 + 애프터)
 * NY Mon–Fri 04:00–20:00 ≈ KST 17:00–09:00(익일)
 * 한국 주말/공휴일과 무관 — 금요 야간(KST 토요 새벽) 등에도 true 가능
 */
const isUsTradingHours = () => {
  const t = getNewYorkTimeParts();
  if (!t || !isNyWeekday(t.weekday)) return false;
  return t.mins >= 4 * 60 && t.mins < 20 * 60;
};

/** 로그용: US-pre | US | US-AH | null */
const getUsSessionLabel = () => {
  if (isUsPreMarketHours()) return 'US-pre';
  if (isUsRegularHours()) return 'US';
  if (isUsAfterMarketHours()) return 'US-AH';
  return null;
};

module.exports = {
  getKoreaDateString,
  isWeekend,
  isHoliday,
  isHolidaySync,
  isTradingHours,
  isKRXExtendedCloseHours,
  isKRXAfterMarketHours,
  isKRXSessionOpen,
  isNXTTradingHours,  
  isPreMarketWarmup,
  isUsPreMarketHours,
  isUsRegularHours,
  isUsAfterMarketHours,
  isUsTradingHours,
  getUsSessionLabel,
  isConditionRealtimeSubscribeTime,
  CONDITION_SUBSCRIBE_START_MINUTES,
  isDailyBarFetchTime,
  extractStockName,
  extractPriceData,
  extractVolumeData,
};


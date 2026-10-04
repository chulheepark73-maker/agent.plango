import holidaysData from '../data/holidays.json';

const HOLIDAY_SET = new Set(holidaysData.holidays || []);

const getKoreaTime = () =>
  new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));

const getKoreaMinutes = (koreaTime) => koreaTime.getHours() * 60 + koreaTime.getMinutes();

// 주말 확인 (토요일, 일요일)
export const isWeekend = () => {
  const dayOfWeek = getKoreaTime().getDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
};

// 휴일 확인 (frontend/src/data/holidays.json)
export const isHolidaySync = () => {
  const koreaTime = getKoreaTime();
  const year = koreaTime.getFullYear();
  const month = String(koreaTime.getMonth() + 1).padStart(2, '0');
  const day = String(koreaTime.getDate()).padStart(2, '0');
  return HOLIDAY_SET.has(`${year}-${month}-${day}`);
};

export const isMarketClosedDay = () => isWeekend() || isHolidaySync();

// 거래시간 확인 (한국 시간 기준 09:00-15:30 정규장, 주중만)
export const isTradingHours = () => {
  if (isWeekend() || isHolidaySync()) return false;

  const timeInMinutes = getKoreaMinutes(getKoreaTime());
  const startTime = 9 * 60;
  const endTime = 15 * 60 + 30;
  return timeInMinutes >= startTime && timeInMinutes <= endTime;
};

/** KRX 장후 시간외 종가 (15:30~16:00, 주중·비공휴) — 정규장과 15:30 분 겹침 시 정규장 우선 */
export const isKRXExtendedCloseHours = () => {
  if (isWeekend() || isHolidaySync()) return false;
  const timeInMinutes = getKoreaMinutes(getKoreaTime());
  return timeInMinutes >= 15 * 60 + 30 && timeInMinutes < 16 * 60;
};

/** KRX 애프터마켓 (16:00-20:00, 주중·비공휴) */
export const isKRXAfterMarketHours = () => {
  if (isWeekend() || isHolidaySync()) return false;
  const timeInMinutes = getKoreaMinutes(getKoreaTime());
  return timeInMinutes >= 16 * 60 && timeInMinutes <= 20 * 60;
};

/** KRX 정규장 · 장후 시간외 종가 · 애프터마켓 */
export const isKRXSessionOpen = () =>
  isTradingHours() || isKRXExtendedCloseHours() || isKRXAfterMarketHours();

// NXT 거래시간 확인 (한국 시간 기준 08:00-08:50만 — 이후는 KRX, 주중만)
export const isNXTTradingHours = () => {
  if (isWeekend() || isHolidaySync()) return false;

  const timeInMinutes = getKoreaMinutes(getKoreaTime());
  const morningStartTime = 8 * 60;
  const morningEndTime = 8 * 60 + 50;

  return timeInMinutes >= morningStartTime && timeInMinutes <= morningEndTime;
};

/** America/New_York 요일·분 */
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

/** NY 주말 (US 휴장일 판별) */
export const isUsWeekend = () => {
  const t = getNewYorkTimeParts();
  if (!t) return isWeekend();
  return !isNyWeekday(t.weekday);
};

/** 미국 프리마켓 NY 04:00–09:30 ≈ KST 17:00–22:30 (EDT) */
export const isUsPreMarketHours = () => {
  const t = getNewYorkTimeParts();
  if (!t || !isNyWeekday(t.weekday)) return false;
  return t.mins >= 4 * 60 && t.mins < 9 * 60 + 30;
};

/** 미국 정규장 NY 09:30–16:00 */
export const isUsRegularHours = () => {
  const t = getNewYorkTimeParts();
  if (!t || !isNyWeekday(t.weekday)) return false;
  return t.mins >= 9 * 60 + 30 && t.mins < 16 * 60;
};

/** 미국 애프터 NY 16:00–20:00 ≈ KST 05:00–09:00 (EDT) */
export const isUsAfterMarketHours = () => {
  const t = getNewYorkTimeParts();
  if (!t || !isNyWeekday(t.weekday)) return false;
  return t.mins >= 16 * 60 && t.mins < 20 * 60;
};

/** 미국 감시 세션 전체 NY 04:00–20:00 */
export const isUsTradingHours = () => {
  const t = getNewYorkTimeParts();
  if (!t || !isNyWeekday(t.weekday)) return false;
  return t.mins >= 4 * 60 && t.mins < 20 * 60;
};

/** 대시보드 표시: US PRE | US | US AH | null(휴장) */
export const getUsSessionLabel = () => {
  if (isUsPreMarketHours()) return 'US PRE';
  if (isUsRegularHours()) return 'US';
  if (isUsAfterMarketHours()) return 'US AH';
  return null;
};

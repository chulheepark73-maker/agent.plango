import holidaysData from '../data/holidays.json';
import usHolidaysData from '../data/usHolidays.json';

const HOLIDAY_SET = new Set(holidaysData.holidays || []);
/** 미국 휴장일·조기폐장일 (NY 날짜, frontend/src/data/usHolidays.json) */
const US_HOLIDAY_SET = new Set(usHolidaysData.holidays || []);
const US_EARLY_CLOSE_SET = new Set(usHolidaysData.earlyCloses || []);

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

/** America/New_York 날짜·요일·분 */
const getNewYorkTimeParts = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
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
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday, mins: hour * 60 + minute };
};

const isNyWeekday = (weekday) => weekday !== 'Sat' && weekday !== 'Sun';

const isUsMarketDayParts = (t) => !!t && isNyWeekday(t.weekday) && !US_HOLIDAY_SET.has(t.date);

/** 정규장·애프터 종료(NY 분) — 조기폐장일은 13:00 / 17:00 */
const getUsSessionEnds = (t) =>
  t && US_EARLY_CLOSE_SET.has(t.date)
    ? { regularEnd: 13 * 60, afterEnd: 17 * 60 }
    : { regularEnd: 16 * 60, afterEnd: 20 * 60 };

/** NY 주말 */
export const isUsWeekend = () => {
  const t = getNewYorkTimeParts();
  if (!t) return isWeekend();
  return !isNyWeekday(t.weekday);
};

/** 미국 휴장일 (NY 날짜, usHolidays.json) */
export const isUsHolidaySync = () => {
  const t = getNewYorkTimeParts();
  return !!t && US_HOLIDAY_SET.has(t.date);
};

/** 미국 휴장 (주말 또는 휴장일) */
export const isUsMarketClosedDay = () => isUsWeekend() || isUsHolidaySync();

/** 미국 프리마켓 NY 04:00–09:30 ≈ KST 17:00–22:30 (EDT) */
export const isUsPreMarketHours = () => {
  const t = getNewYorkTimeParts();
  if (!isUsMarketDayParts(t)) return false;
  return t.mins >= 4 * 60 && t.mins < 9 * 60 + 30;
};

/** 미국 정규장 NY 09:30–16:00 (조기폐장일 13:00) */
export const isUsRegularHours = () => {
  const t = getNewYorkTimeParts();
  if (!isUsMarketDayParts(t)) return false;
  return t.mins >= 9 * 60 + 30 && t.mins < getUsSessionEnds(t).regularEnd;
};

/** 미국 애프터 NY 16:00–20:00 ≈ KST 05:00–09:00 (EDT), 조기폐장일 13:00–17:00 */
export const isUsAfterMarketHours = () => {
  const t = getNewYorkTimeParts();
  if (!isUsMarketDayParts(t)) return false;
  const { regularEnd, afterEnd } = getUsSessionEnds(t);
  return t.mins >= regularEnd && t.mins < afterEnd;
};

/** 미국 감시 세션 전체 NY 04:00–20:00 (조기폐장일 17:00) */
export const isUsTradingHours = () => {
  const t = getNewYorkTimeParts();
  if (!isUsMarketDayParts(t)) return false;
  return t.mins >= 4 * 60 && t.mins < getUsSessionEnds(t).afterEnd;
};

/** 대시보드 표시: US PRE | US | US AH | null(휴장) */
export const getUsSessionLabel = () => {
  if (isUsPreMarketHours()) return 'US PRE';
  if (isUsRegularHours()) return 'US';
  if (isUsAfterMarketHours()) return 'US AH';
  return null;
};

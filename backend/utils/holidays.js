/** 프론트와 공유하는 휴장일 목록 (frontend/src/data/holidays.json) */
const holidaysData = require('../../frontend/src/data/holidays.json');
/** 미국(NYSE·NASDAQ) 휴장일·조기폐장일 — NY 날짜 기준 (frontend/src/data/usHolidays.json) */
const usHolidaysData = require('../../frontend/src/data/usHolidays.json');

let holidaySet = null;

const loadHolidaySet = () => {
  if (holidaySet) return holidaySet;
  const list = Array.isArray(holidaysData.holidays) ? holidaysData.holidays : [];
  holidaySet = new Set(list);
  return holidaySet;
};

const getFixedHolidays = () => Array.from(loadHolidaySet());

const isFixedHolidayDate = (dateStr) => loadHolidaySet().has(dateStr);

const US_HOLIDAY_SET = new Set(Array.isArray(usHolidaysData.holidays) ? usHolidaysData.holidays : []);
const US_EARLY_CLOSE_SET = new Set(Array.isArray(usHolidaysData.earlyCloses) ? usHolidaysData.earlyCloses : []);

/** @param {string} nyDateStr YYYY-MM-DD (America/New_York) */
const isUsHolidayDate = (nyDateStr) => US_HOLIDAY_SET.has(nyDateStr);

/** 정규장 13:00 ET 조기폐장일 (애프터는 17:00 ET 종료) */
const isUsEarlyCloseDate = (nyDateStr) => US_EARLY_CLOSE_SET.has(nyDateStr);

module.exports = {
  getFixedHolidays,
  isFixedHolidayDate,
  isUsHolidayDate,
  isUsEarlyCloseDate,
};

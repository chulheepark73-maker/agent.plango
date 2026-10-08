/** 프론트와 공유하는 휴장일 목록 (frontend/src/data/holidays.json) */
const holidaysData = require('../../frontend/src/data/holidays.json');

let holidaySet = null;

const loadHolidaySet = () => {
  if (holidaySet) return holidaySet;
  const list = Array.isArray(holidaysData.holidays) ? holidaysData.holidays : [];
  holidaySet = new Set(list);
  return holidaySet;
};

const getFixedHolidays = () => Array.from(loadHolidaySet());

const isFixedHolidayDate = (dateStr) => loadHolidaySet().has(dateStr);

module.exports = {
  getFixedHolidays,
  isFixedHolidayDate,
};

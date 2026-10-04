const fs = require('fs');
const path = require('path');

/** 프론트와 공유하는 휴장일 목록 (frontend/src/data/holidays.json) */
const HOLIDAYS_FILE = path.join(__dirname, '../../frontend/src/data/holidays.json');

let holidaySet = null;

const loadHolidaySet = () => {
  if (holidaySet) return holidaySet;
  const raw = fs.readFileSync(HOLIDAYS_FILE, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data.holidays) ? data.holidays : [];
  holidaySet = new Set(list);
  return holidaySet;
};

const getFixedHolidays = () => Array.from(loadHolidaySet());

const isFixedHolidayDate = (dateStr) => loadHolidaySet().has(dateStr);

module.exports = {
  getFixedHolidays,
  isFixedHolidayDate,
};

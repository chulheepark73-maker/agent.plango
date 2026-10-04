// 숫자 포맷팅 유틸리티
export const formatNumber = (value) => {
  if (value === null || value === undefined) return '-';
  const numValue = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(numValue)) return '-';
  return numValue.toLocaleString();
};

/** 미국 달러 가격 (항상 소수 2자리) */
export const formatUsMoney = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  const numValue =
    typeof value === 'string' ? parseFloat(String(value).replace(/,/g, '')) : Number(value);
  if (!Number.isFinite(numValue)) return '-';
  return numValue.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

// 등락률 포맷팅 유틸리티
export const formatChangeRate = (rate) => {
  if (rate === null || rate === undefined) return '-';
  const numValue = typeof rate === 'string' ? parseFloat(rate) : rate;
  if (isNaN(numValue)) return '-';
  return `${numValue >= 0 ? '+' : ''}${numValue.toFixed(2)}%`;
};

/** ISO/Date → KST 표시 (예: 2026-09-09 00:10:25) */
export const formatKstDateTime = (value) => {
  if (value == null || value === '') return '-';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
};

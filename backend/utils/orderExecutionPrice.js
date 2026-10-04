/**
 * 키움 REST(kt00009) / WS(00) 체결단가 파싱
 * - 현재가(FID 10 / cur_prc / price)는 체결가로 사용하지 않음
 */

function parseKiwoomNumber(raw) {
  if (raw == null || raw === '') return 0;
  const n = parseFloat(String(raw).replace(/,/g, '').replace(/^\+/, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseAbsPrice(raw) {
  return Math.abs(parseKiwoomNumber(raw));
}

/**
 * kt00009 체결 행에서 체결단가 추출
 * @param {object} row
 * @param {number} [fallbackOrderPrice] 주문가(지정가) — 체결단가 필드가 없을 때만
 */
function parseRestExecutionPrice(row, fallbackOrderPrice = 0) {
  if (!row || typeof row !== 'object') return 0;

  const candidates = [
    row.cntr_uv,
    row.cntr_pric,
    row.unit_cntr_pric,
    row.exec_uv,
    row.exec_prc,
    row.execPrice,
    row.ord_uv,
    row.ord_pric,
  ];

  for (const raw of candidates) {
    const price = parseAbsPrice(raw);
    if (price > 0) return Math.round(price);
  }

  const fallback = parseAbsPrice(fallbackOrderPrice);
  return fallback > 0 ? Math.round(fallback) : 0;
}

/**
 * kt00009 체결 행에서 체결수량 추출
 */
function parseRestExecutionQty(row) {
  if (!row || typeof row !== 'object') return 0;
  return Math.abs(
    parseKiwoomNumber(
      row.cntr_qty || row.exec_qty || row.executedQty || row.execQty || 0
    )
  );
}

/**
 * 동일 주문의 체결 행들을 합산 (부분체결·다건 체결)
 */
function aggregateRestExecutions(rows, fallbackOrderPrice = 0) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let totalQty = 0;
  let totalAmount = 0;

  for (const row of rows) {
    const qty = parseRestExecutionQty(row);
    const price = parseRestExecutionPrice(row, fallbackOrderPrice);
    if (qty > 0 && price > 0) {
      totalQty += qty;
      totalAmount += qty * price;
    }
  }

  if (totalQty <= 0) return null;

  return {
    execQty: totalQty,
    execPrice: Math.round(totalAmount / totalQty),
  };
}

/**
 * WS 00 values에서 체결단가 (pickOrderFillPrice와 동일 우선순위)
 */
function parseWsExecutionPrice(values) {
  const v = values && typeof values === 'object' ? values : {};
  const candidates = [
    v['910'],
    v['914'],
    v.cntr_uv,
    v.exec_uv,
    v.exec_prc,
    v['체결가'],
    v['단위체결가'],
    v.ord_uv,
    v['주문가격'],
    v['901'],
  ];

  for (const raw of candidates) {
    const price = parseAbsPrice(raw);
    if (price > 0) return Math.round(price);
  }
  return 0;
}

module.exports = {
  parseKiwoomNumber,
  parseAbsPrice,
  parseRestExecutionPrice,
  parseRestExecutionQty,
  aggregateRestExecutions,
  parseWsExecutionPrice,
};

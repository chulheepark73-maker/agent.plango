/**
 * 지표기반매매 — 포지션·주문 이력
 * tracking_stocks(JSON)는 조건식 감시 목록만 담당
 */

const pool = require('./tradingDb');

const ACTIVE_STATUSES = ['pending_buy', 'open', 'selling'];

/** 스키마는 db/trading_schema.sql 에서 생성된다 */
const ensurePositionTables = async () => {};

const mapPosition = (row) => {
  if (!row) return null;
  const buyOrderPrice = row.buy_order_price != null ? Number(row.buy_order_price) : null;
  const buyFilledPrice = row.buy_filled_price != null ? Number(row.buy_filled_price) : null;
  const buyQty = Number(row.buy_qty) || 0;
  const buyFilledQty = Number(row.buy_filled_qty) || 0;
  return {
    id: Number(row.id),
    userId: row.user_id,
    stockCode: row.stock_code,
    stockName: row.stock_name || '',
    venue: row.venue || 'KRX',
    buyConditionSeq: row.buy_condition_seq || '',
    /** tracking source 보존용 (manual 등) */
    entrySource: row.entry_source || null,
    status: row.status,
    buyOrderNo: row.buy_order_no || null,
    buyOrderPrice,
    buyFilledPrice,
    buyPrice: buyFilledPrice ?? buyOrderPrice,
    buyQty,
    buyFilledQty,
    buyOrderedAt: row.buy_ordered_at ? new Date(row.buy_ordered_at).toISOString() : null,
    buyFilledAt: row.buy_filled_at ? new Date(row.buy_filled_at).toISOString() : null,
    sellOrderNo: row.sell_order_no || null,
    sellOrderPrice: row.sell_order_price != null ? Number(row.sell_order_price) : null,
    sellFilledPrice: row.sell_filled_price != null ? Number(row.sell_filled_price) : null,
    sellQty: Number(row.sell_qty) || 0,
    sellFilledQty: Number(row.sell_filled_qty) || 0,
    sellReason: row.sell_reason || null,
    sellOrderedAt: row.sell_ordered_at ? new Date(row.sell_ordered_at).toISOString() : null,
    sellFilledAt: row.sell_filled_at ? new Date(row.sell_filled_at).toISOString() : null,
    highPriceSinceBuy:
      row.high_price_since_buy != null ? Number(row.high_price_since_buy) : null,
    lastPrice: row.last_price != null ? Number(row.last_price) : null,
    lastProfitRate: row.last_profit_rate != null ? Number(row.last_profit_rate) : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
  };
};

const mapOrder = (row) => {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: row.user_id,
    positionId: row.position_id != null ? Number(row.position_id) : null,
    stockCode: row.stock_code,
    side: row.side,
    action: row.action,
    venue: row.venue || 'KRX',
    priceType: row.price_type,
    orderPrice: row.order_price != null ? Number(row.order_price) : null,
    qty: row.qty != null ? Number(row.qty) : null,
    filledPrice: row.filled_price != null ? Number(row.filled_price) : null,
    filledQty: row.filled_qty != null ? Number(row.filled_qty) : null,
    orderNo: row.order_no || null,
    parentOrderNo: row.parent_order_no || null,
    reason: row.reason || null,
    rawMessage: row.raw_message || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
};

const statusToBuyUi = (status) => {
  if (status === 'pending_buy' || status === 'open') return '체결 완료';
  if (status === 'selling') return '매도중';
  if (status === 'closed') return '청산';
  if (status === 'cancelled') return '취소';
  return '대기';
};

const statusToSellUi = (status) => {
  if (status === 'selling') return '주문 완료';
  if (status === 'closed') return '체결 완료';
  return '대기';
};

/** UI/트래킹 행에 포지션 필드 병합 */
const mergePositionIntoTrackingRow = (row, position) => {
  if (!row) return row;
  const source =
    row.source ||
    (position?.entrySource ? position.entrySource : null) ||
    null;
  if (!position) {
    return {
      ...row,
      source: source || row.source || null,
      positionId: null,
      buyPrice: row.buyPrice ?? null,
      buyQty: row.buyQty ?? null,
      buyOrderNo: row.buyOrderNo ?? null,
      buyOrderStatus: row.buyOrderStatus || '대기',
      sellOrderStatus: row.sellOrderStatus || '대기',
    };
  }
  const posLastPrice =
    position.lastPrice != null && Number(position.lastPrice) > 0
      ? Math.round(Number(position.lastPrice))
      : null;
  return {
    ...row,
    source,
    positionId: position.id,
    stockMarket: row.stockMarket || position.venue || 'KRX',
    price: posLastPrice ?? row.price ?? null,
    buyPrice: position.buyPrice,
    buyQty: position.buyFilledQty || position.buyQty || null,
    buyOrderNo: position.buyOrderNo,
    buyOrderStatus: statusToBuyUi(position.status),
    sellOrderStatus: statusToSellUi(position.status),
    profitRate: position.lastProfitRate ?? row.profitRate ?? null,
  };
};

const getActivePositions = async (userId) => {
  await ensurePositionTables();
  const result = await pool.query(
    `SELECT * FROM indicator_positions
     WHERE user_id = $1 AND status = ANY($2::text[])
     ORDER BY created_at ASC`,
    [String(userId), ACTIVE_STATUSES]
  );
  return result.rows.map(mapPosition);
};

const getOpenPositions = async (userId) => {
  await ensurePositionTables();
  const result = await pool.query(
    `SELECT * FROM indicator_positions
     WHERE user_id = $1 AND status = 'open'
     ORDER BY created_at ASC`,
    [String(userId)]
  );
  return result.rows.map(mapPosition);
};

const getActivePositionByCode = async (userId, stockCode) => {
  await ensurePositionTables();
  const result = await pool.query(
    `SELECT * FROM indicator_positions
     WHERE user_id = $1 AND stock_code = $2 AND status = ANY($3::text[])
     LIMIT 1`,
    [String(userId), String(stockCode), ACTIVE_STATUSES]
  );
  return result.rows[0] ? mapPosition(result.rows[0]) : null;
};

/** 당일(KST) 체결가 기준 수익 청산 여부 — 익절 후 재매수 금지 판단용 */
const hasProfitableCloseToday = async (userId, stockCode) => {
  await ensurePositionTables();
  const code6 = String(stockCode || '').substring(0, 6);
  if (!code6) return false;

  const soldAtExpr = `COALESCE(sell_filled_at, closed_at, sell_ordered_at, updated_at)`;
  const result = await pool.query(
    `SELECT 1 FROM indicator_positions
     WHERE user_id = $1
       AND LEFT(stock_code, 6) = $2
       AND status = 'closed'
       AND COALESCE(buy_filled_price, buy_order_price) > 0
       AND COALESCE(sell_filled_price, sell_order_price) > COALESCE(buy_filled_price, buy_order_price)
       AND date(${soldAtExpr}, '+9 hours') = date('now', '+9 hours')
     LIMIT 1`,
    [String(userId), code6]
  );
  return result.rows.length > 0;
};

const getActivePositionsMap = async (userId) => {
  const list = await getActivePositions(userId);
  return new Map(list.map((p) => [p.stockCode, p]));
};

const summarizeActiveUsage = async (userId) => {
  const list = await getActivePositions(userId);
  let usedAmount = 0;
  for (const p of list) {
    const price = Number(p.buyFilledPrice ?? p.buyOrderPrice) || 0;
    const qty = Number(p.buyFilledQty || p.buyQty) || 0;
    usedAmount += price * qty;
  }
  return { holdingCount: list.length, usedAmount, positions: list };
};

/** 체결·포지션 생성 시 종목명 보완 (미체결 복구·WS 체결 등에서 이름 누락 방지) */
const resolveIndicatorStockName = async (userId, stockCode, fallback = '') => {
  const trimmed = String(fallback || '').trim();
  if (trimmed) return trimmed;

  const code6 = String(stockCode || '').substring(0, 6);
  if (!code6) return '';

  try {
    const { getTrackingStocks } = require('./indicatorTradingStore');
    const list = await getTrackingStocks(String(userId));
    const hit = list.find((r) => String(r?.stockCode || '').substring(0, 6) === code6);
    if (hit?.stockName) return String(hit.stockName).trim();
  } catch {
    /* ignore */
  }

  try {
    const result = await pool.query(
      `SELECT stock_name FROM stock_list WHERE stock_code = $1 LIMIT 1`,
      [code6]
    );
    const dbName = result.rows[0]?.stock_name;
    if (dbName) return String(dbName).trim();
  } catch {
    /* ignore */
  }

  try {
    const nxtResult = await pool.query(
      `SELECT stock_name FROM stock_list_nxt
       WHERE stock_code = $1 OR stock_code = $2 OR LEFT(stock_code, 6) = $3
       LIMIT 1`,
      [code6, `${code6}_NX`, code6]
    );
    const nxtName = nxtResult.rows[0]?.stock_name;
    if (nxtName) return String(nxtName).trim();
  } catch {
    /* ignore */
  }

  return '';
};

/** 트래킹 행 종목명 보완 (조건검색 편입 시 코드만 오는 경우) */
const enrichTrackingRowsWithNames = async (userId, rows) => {
  const uid = String(userId);
  const out = [];
  for (const row of rows || []) {
    if (!row) {
      out.push(row);
      continue;
    }
    const name = await resolveIndicatorStockName(uid, row.stockCode, row.stockName);
    out.push(name ? { ...row, stockName: name } : row);
  }
  return out;
};

/** tracking_stocks.source 조회 (포지션 entry_source 기록용) */
const resolveTrackingEntrySource = async (userId, stockCode, fallback = null) => {
  if (fallback) return String(fallback);
  const code6 = String(stockCode || '').substring(0, 6);
  if (!code6) return null;
  try {
    const { getTrackingStocks } = require('./indicatorTradingStore');
    const list = await getTrackingStocks(String(userId));
    const hit = list.find((r) => String(r?.stockCode || '').substring(0, 6) === code6);
    return hit?.source ? String(hit.source) : null;
  } catch {
    return null;
  }
};

const insertBuyOrder = async (userId, data) => {
  await ensurePositionTables();
  const {
    stockCode,
    stockName,
    venue = 'KRX',
    buyConditionSeq = '',
    buyOrderNo,
    buyOrderPrice,
    buyQty,
    priceType = 'limit',
    rawMessage = null,
    entrySource = null,
  } = data;

  const resolvedName = await resolveIndicatorStockName(userId, stockCode, stockName);
  const resolvedSource = await resolveTrackingEntrySource(userId, stockCode, entrySource);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const posRes = await client.query(
      `INSERT INTO indicator_positions (
         user_id, stock_code, stock_name, venue, buy_condition_seq, status,
         buy_order_no, buy_order_price, buy_qty, buy_filled_qty,
         buy_ordered_at, updated_at, entry_source
       ) VALUES (
         $1, $2, $3, $4, $5, 'pending_buy',
         $6, $7, $8, 0,
         NOW(), NOW(), $9
       )
       RETURNING *`,
      [
        String(userId),
        String(stockCode),
        resolvedName,
        venue || 'KRX',
        String(buyConditionSeq || ''),
        buyOrderNo ? String(buyOrderNo) : null,
        buyOrderPrice != null ? Math.round(Number(buyOrderPrice)) : null,
        Math.max(0, parseInt(buyQty, 10) || 0),
        resolvedSource,
      ]
    );
    const position = mapPosition(posRes.rows[0]);
    await client.query(
      `INSERT INTO indicator_orders (
         user_id, position_id, stock_code, side, action, venue, price_type,
         order_price, qty, order_no, raw_message
       ) VALUES ($1, $2, $3, 'buy', 'place', $4, $5, $6, $7, $8, $9)`,
      [
        String(userId),
        position.id,
        String(stockCode),
        venue || 'KRX',
        priceType || 'limit',
        buyOrderPrice != null ? Math.round(Number(buyOrderPrice)) : null,
        Math.max(0, parseInt(buyQty, 10) || 0),
        buyOrderNo ? String(buyOrderNo) : null,
        rawMessage,
      ]
    );
    await client.query('COMMIT');
    return position;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const insertOrderLog = async (userId, data) => {
  await ensurePositionTables();
  const result = await pool.query(
    `INSERT INTO indicator_orders (
       user_id, position_id, stock_code, side, action, venue, price_type,
       order_price, qty, filled_price, filled_qty, order_no, parent_order_no,
       reason, raw_message
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      String(userId),
      data.positionId ?? null,
      String(data.stockCode),
      data.side || 'buy',
      data.action || 'place',
      data.venue || 'KRX',
      data.priceType || 'limit',
      data.orderPrice != null ? Math.round(Number(data.orderPrice)) : null,
      data.qty != null ? parseInt(data.qty, 10) : null,
      data.filledPrice != null ? Math.round(Number(data.filledPrice)) : null,
      data.filledQty != null ? parseInt(data.filledQty, 10) : null,
      data.orderNo ? String(data.orderNo) : null,
      data.parentOrderNo ? String(data.parentOrderNo) : null,
      data.reason || null,
      data.rawMessage || null,
    ]
  );
  return mapOrder(result.rows[0]);
};

/** 동일 주문번호 buy fill 로그 존재 여부 (WS+REST 중복 합산 방지) */
const hasBuyFillForOrderNo = async (userId, orderNo, client = null) => {
  if (!orderNo) return false;
  const q = client || pool;
  const result = await q.query(
    `SELECT 1 FROM indicator_orders
     WHERE user_id = $1 AND order_no = $2 AND side = 'buy' AND action = 'fill'
     LIMIT 1`,
    [String(userId), String(orderNo)]
  );
  return result.rows.length > 0;
};

/**
 * 분할매수 추가 체결 — open 포지션에 수량 합산 + 가중평균 평단 갱신
 * @returns {Promise<object|null>} 갱신된 포지션 (합산 불가·중복이면 기존/null)
 */
const addBuyFillToOpenPosition = async (userId, positionId, data) => {
  await ensurePositionTables();
  const {
    stockCode,
    venue = 'KRX',
    orderNo,
    orderPrice,
    buyQty,
    filledPrice,
    filledQty,
    priceType = 'limit',
  } = data;

  const addPrice = Math.round(Number(filledPrice) || 0);
  const addQty = parseInt(filledQty, 10) || 0;
  const addOrderedQty = Math.max(0, parseInt(buyQty, 10) || addQty);
  if (!(addPrice > 0) || addQty < 1 || !positionId) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const posRes = await client.query(
      `SELECT * FROM indicator_positions
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [positionId, String(userId)]
    );
    const row = posRes.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    if (row.status !== 'open') {
      await client.query('COMMIT');
      return mapPosition(row);
    }

    if (orderNo && (await hasBuyFillForOrderNo(userId, orderNo, client))) {
      await client.query('COMMIT');
      return mapPosition(row);
    }

    const oldQty = Number(row.buy_filled_qty) || 0;
    const oldAvg = Number(row.buy_filled_price) || 0;
    const newQty = oldQty + addQty;
    const newAvg =
      newQty > 0 ? Math.round((oldAvg * oldQty + addPrice * addQty) / newQty) : addPrice;
    const newBuyQty = (Number(row.buy_qty) || 0) + addOrderedQty;

    const upd = await client.query(
      `UPDATE indicator_positions SET
         buy_filled_qty = $3,
         buy_filled_price = $4,
         buy_qty = $5,
         updated_at = NOW()
       WHERE id = $2 AND user_id = $1 AND status = 'open'
       RETURNING *`,
      [String(userId), positionId, newQty, newAvg, newBuyQty]
    );
    if (!upd.rows[0]) {
      await client.query('ROLLBACK');
      return mapPosition(row);
    }

    await client.query(
      `INSERT INTO indicator_orders (
         user_id, position_id, stock_code, side, action, venue, price_type,
         order_price, qty, filled_price, filled_qty, order_no, raw_message
       ) VALUES ($1, $2, $3, 'buy', 'fill', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        String(userId),
        positionId,
        String(stockCode || row.stock_code),
        venue || row.venue || 'KRX',
        priceType || 'limit',
        orderPrice != null ? Math.round(Number(orderPrice)) : addPrice,
        addOrderedQty,
        addPrice,
        addQty,
        orderNo ? String(orderNo) : null,
        'merged_split_fill',
      ]
    );

    await client.query('COMMIT');
    return mapPosition(upd.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * 매수 체결 확인 후에만 호출 — status=open 포지션 생성
 */
const createFilledBuyPosition = async (userId, data) => {
  await ensurePositionTables();
  const {
    stockCode,
    stockName,
    venue = 'KRX',
    buyConditionSeq = '',
    buyOrderNo,
    buyOrderPrice,
    buyFilledPrice,
    buyQty,
    buyFilledQty,
    priceType = 'limit',
    entrySource = null,
  } = data;

  const filledPrice = Math.round(Number(buyFilledPrice ?? buyOrderPrice) || 0);
  const filledQty = parseInt(buyFilledQty ?? buyQty, 10) || 0;
  const resolvedName = await resolveIndicatorStockName(userId, stockCode, stockName);
  const resolvedSource = await resolveTrackingEntrySource(userId, stockCode, entrySource);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const posRes = await client.query(
      `INSERT INTO indicator_positions (
         user_id, stock_code, stock_name, venue, buy_condition_seq, status,
         buy_order_no, buy_order_price, buy_filled_price,
         buy_qty, buy_filled_qty,
         buy_ordered_at, buy_filled_at,
         high_price_since_buy, last_price, updated_at, entry_source
       ) VALUES (
         $1, $2, $3, $4, $5, 'open',
         $6, $7, $8,
         $9, $10,
         NOW(), NOW(),
         $8, $8, NOW(), $11
       )
       RETURNING *`,
      [
        String(userId),
        String(stockCode),
        resolvedName,
        venue || 'KRX',
        String(buyConditionSeq || ''),
        buyOrderNo ? String(buyOrderNo) : null,
        buyOrderPrice != null ? Math.round(Number(buyOrderPrice)) : filledPrice,
        filledPrice,
        Math.max(0, parseInt(buyQty, 10) || filledQty),
        filledQty,
        resolvedSource,
      ]
    );
    const position = mapPosition(posRes.rows[0]);
    await client.query(
      `INSERT INTO indicator_orders (
         user_id, position_id, stock_code, side, action, venue, price_type,
         order_price, qty, filled_price, filled_qty, order_no, raw_message
       ) VALUES ($1, $2, $3, 'buy', 'fill', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        String(userId),
        position.id,
        String(stockCode),
        venue || 'KRX',
        priceType || 'limit',
        buyOrderPrice != null ? Math.round(Number(buyOrderPrice)) : filledPrice,
        Math.max(0, parseInt(buyQty, 10) || filledQty),
        filledPrice,
        filledQty,
        buyOrderNo ? String(buyOrderNo) : null,
        'created_on_fill_only',
      ]
    );
    await client.query('COMMIT');
    return position;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/** 유령/미보유 포지션 폐기 */
const markPositionCancelled = async (userId, positionId, reason = 'cancelled') => {
  await ensurePositionTables();
  const result = await pool.query(
    `UPDATE indicator_positions SET
       status = 'cancelled',
       sell_reason = $3,
       closed_at = NOW(),
       updated_at = NOW()
     WHERE id = $2 AND user_id = $1
       AND status IN ('pending_buy', 'open', 'selling')
     RETURNING *`,
    [String(userId), positionId, reason]
  );
  return result.rows[0] ? mapPosition(result.rows[0]) : null;
};

/** 종목의 pending_buy 포지션만 취소 (체결·매도중은 유지) */
const cancelPendingBuyPositionsForCode = async (userId, stockCode, reason = 'manual_remove') => {
  await ensurePositionTables();
  const code6 = String(stockCode || '').substring(0, 6);
  if (!code6) return [];
  const result = await pool.query(
    `UPDATE indicator_positions SET
       status = 'cancelled',
       sell_reason = $3,
       closed_at = NOW(),
       updated_at = NOW()
     WHERE user_id = $1 AND stock_code = $2 AND status = 'pending_buy'
     RETURNING id, stock_code`,
    [String(userId), code6, reason]
  );
  return result.rows;
};

/** 미체결·낙관적 open 등 활성 포지션 일괄 취소 */
const cancelActivePositionsForUser = async (userId, reason = 'cleanup') => {
  await ensurePositionTables();
  const result = await pool.query(
    `UPDATE indicator_positions SET
       status = 'cancelled',
       sell_reason = $2,
       closed_at = NOW(),
       updated_at = NOW()
     WHERE user_id = $1 AND status IN ('pending_buy', 'open', 'selling')
     RETURNING id, stock_code`,
    [String(userId), reason]
  );
  return result.rows;
};

const markBuyFilled = async (userId, positionId, { filledPrice, filledQty }) => {
  await ensurePositionTables();
  const result = await pool.query(
    `UPDATE indicator_positions SET
       status = 'open',
       buy_filled_price = $3,
       buy_filled_qty = $4,
       buy_filled_at = NOW(),
       high_price_since_buy = COALESCE(high_price_since_buy, $3),
       last_price = $3,
       updated_at = NOW()
     WHERE id = $2 AND user_id = $1 AND status = 'pending_buy'
     RETURNING *`,
    [
      String(userId),
      positionId,
      filledPrice != null ? Math.round(Number(filledPrice)) : null,
      filledQty != null ? parseInt(filledQty, 10) : 0,
    ]
  );
  return result.rows[0] ? mapPosition(result.rows[0]) : null;
};

/** 시세·고가·수익률 갱신 (open 포지션) */
const updatePositionPriceState = async (
  userId,
  positionId,
  { lastPrice, highPriceSinceBuy, lastProfitRate }
) => {
  await ensurePositionTables();
  const result = await pool.query(
    `UPDATE indicator_positions SET
       last_price = COALESCE($3, last_price),
       high_price_since_buy = COALESCE($4, high_price_since_buy),
       last_profit_rate = COALESCE($5, last_profit_rate),
       updated_at = NOW()
     WHERE id = $2 AND user_id = $1 AND status = 'open'
     RETURNING *`,
    [
      String(userId),
      positionId,
      lastPrice != null ? Math.round(Number(lastPrice)) : null,
      highPriceSinceBuy != null ? Math.round(Number(highPriceSinceBuy)) : null,
      lastProfitRate != null ? Number(lastProfitRate) : null,
    ]
  );
  return result.rows[0] ? mapPosition(result.rows[0]) : null;
};

/**
 * 매도 주문 접수 → selling
 * CAS: status가 open일 때만 성공 (중복 매도 방지)
 */
const markPositionSelling = async (
  userId,
  positionId,
  { sellOrderNo, sellOrderPrice, sellQty, sellReason }
) => {
  await ensurePositionTables();
  const result = await pool.query(
    `UPDATE indicator_positions SET
       status = 'selling',
       sell_order_no = $3,
       sell_order_price = $4,
       sell_qty = $5,
       sell_reason = $6,
       sell_ordered_at = NOW(),
       updated_at = NOW()
     WHERE id = $2 AND user_id = $1 AND status = 'open'
     RETURNING *`,
    [
      String(userId),
      positionId,
      sellOrderNo ? String(sellOrderNo) : null,
      sellOrderPrice != null ? Math.round(Number(sellOrderPrice)) : null,
      sellQty != null ? parseInt(sellQty, 10) : 0,
      sellReason || null,
    ]
  );
  return result.rows[0] ? mapPosition(result.rows[0]) : null;
};

/** selling 상태에서 주문번호 등 갱신 */
const updateSellingOrderDetails = async (
  userId,
  positionId,
  { sellOrderNo, sellOrderPrice, sellQty, sellReason }
) => {
  await ensurePositionTables();
  const result = await pool.query(
    `UPDATE indicator_positions SET
       sell_order_no = COALESCE($3, sell_order_no),
       sell_order_price = COALESCE($4, sell_order_price),
       sell_qty = COALESCE($5, sell_qty),
       sell_reason = COALESCE($6, sell_reason),
       updated_at = NOW()
     WHERE id = $2 AND user_id = $1 AND status = 'selling'
     RETURNING *`,
    [
      String(userId),
      positionId,
      sellOrderNo ? String(sellOrderNo) : null,
      sellOrderPrice != null ? Math.round(Number(sellOrderPrice)) : null,
      sellQty != null ? parseInt(sellQty, 10) : null,
      sellReason || null,
    ]
  );
  return result.rows[0] ? mapPosition(result.rows[0]) : null;
};

/** 매도 실패 시 open으로 복귀 */
const revertPositionToOpen = async (userId, positionId) => {
  await ensurePositionTables();
  const result = await pool.query(
    `UPDATE indicator_positions SET
       status = 'open',
       sell_order_no = NULL,
       sell_order_price = NULL,
       sell_qty = 0,
       sell_reason = NULL,
       sell_ordered_at = NULL,
       updated_at = NOW()
     WHERE id = $2 AND user_id = $1 AND status = 'selling'
     RETURNING *`,
    [String(userId), positionId]
  );
  return result.rows[0] ? mapPosition(result.rows[0]) : null;
};

/** 매도 체결(또는 주문 성공 후 청산 처리) */
const markPositionClosed = async (
  userId,
  positionId,
  { sellFilledPrice, sellFilledQty, sellOrderNo, sellReason } = {}
) => {
  await ensurePositionTables();
  const result = await pool.query(
    `UPDATE indicator_positions SET
       status = 'closed',
       sell_order_no = COALESCE($3, sell_order_no),
       sell_filled_price = COALESCE($4, sell_filled_price, sell_order_price),
       sell_filled_qty = COALESCE(
         NULLIF($5, 0),
         NULLIF(sell_filled_qty, 0),
         NULLIF(sell_qty, 0),
         NULLIF(buy_filled_qty, 0),
         buy_qty
       ),
       sell_reason = COALESCE($6, sell_reason),
       sell_filled_at = COALESCE(sell_filled_at, NOW()),
       closed_at = COALESCE(closed_at, NOW()),
       updated_at = NOW()
     WHERE id = $2 AND user_id = $1
       AND (
         status IN ('selling', 'open')
         OR (status = 'closed' AND sell_filled_at IS NULL)
       )
     RETURNING *`,
    [
      String(userId),
      positionId,
      sellOrderNo ? String(sellOrderNo) : null,
      sellFilledPrice != null ? Math.round(Number(sellFilledPrice)) : null,
      sellFilledQty != null ? parseInt(sellFilledQty, 10) : null,
      sellReason || null,
    ]
  );
  return result.rows[0] ? mapPosition(result.rows[0]) : null;
};

/**
 * 매도 주문 place + orders 로그 + selling/closed
 */
const placeSellForPosition = async (userId, positionId, orderMeta) => {
  await ensurePositionTables();
  const {
    stockCode,
    venue = 'KRX',
    priceType = 'limit',
    orderPrice,
    qty,
    orderNo,
    reason,
    closeImmediately = true,
  } = orderMeta;

  const selling = await markPositionSelling(userId, positionId, {
    sellOrderNo: orderNo,
    sellOrderPrice: orderPrice,
    sellQty: qty,
    sellReason: reason,
  });
  if (!selling) return null;

  await insertOrderLog(userId, {
    positionId,
    stockCode,
    side: 'sell',
    action: 'place',
    venue,
    priceType,
    orderPrice,
    qty,
    orderNo,
    reason,
  });

  if (closeImmediately) {
    const closed = await markPositionClosed(userId, positionId, {
      sellFilledPrice: orderPrice,
      sellFilledQty: qty,
      sellOrderNo: orderNo,
      sellReason: reason,
    });
    await insertOrderLog(userId, {
      positionId,
      stockCode,
      side: 'sell',
      action: 'fill',
      venue,
      priceType,
      orderPrice,
      qty,
      filledPrice: orderPrice,
      filledQty: qty,
      orderNo,
      reason,
      rawMessage: 'optimistic_close_after_place',
    });
    return closed;
  }
  return selling;
};

const getRecentOrders = async (userId, limit = 50) => {
  await ensurePositionTables();
  const result = await pool.query(
    `SELECT * FROM indicator_orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [String(userId), Math.min(200, Math.max(1, limit))]
  );
  return result.rows.map(mapOrder);
};

/**
 * 구버전 tracking JSON 매수정보 → positions 이관은 중단.
 * (미체결·스냅샷 가격으로 open이 생겨 유령 매도가 발생했음)
 */
const migrateBuysFromTrackingJson = async () => 0;

/** 감시 JSON에 남기지 않을 주문/포지션 필드 제거 */
const stripOrderFieldsFromTracking = (row) => {
  if (!row || typeof row !== 'object') return row;
  const next = { ...row };
  delete next.buyPrice;
  delete next.buyQty;
  delete next.buyOrderNo;
  delete next.buyOrderStatus;
  delete next.sellOrderStatus;
  delete next.lastReason;
  delete next.positionId;
  delete next.profitRate;
  delete next.executionStrength;
  delete next.programNetBuy;
  return next;
};

/**
 * DB 미체결 매도 place (fill/reject 없음)
 */
const getUnfilledSellPlacesFromOrders = async (userId) => {
  await ensurePositionTables();
  const result = await pool.query(
    `SELECT stock_code, order_no, order_price, qty, venue, position_id, created_at
     FROM (
       SELECT o.stock_code, o.order_no, o.order_price, o.qty, o.venue, o.position_id, o.created_at,
              ROW_NUMBER() OVER (PARTITION BY o.order_no ORDER BY o.created_at DESC) AS rn
       FROM indicator_orders o
       WHERE o.user_id = $1
         AND o.side = 'sell'
         AND o.action = 'place'
         AND o.created_at > NOW() - INTERVAL '1 day'
         AND o.order_no IS NOT NULL
         AND TRIM(o.order_no) <> ''
         AND NOT EXISTS (
           SELECT 1 FROM indicator_orders f
           WHERE f.user_id = o.user_id
             AND f.order_no = o.order_no
             AND f.side = 'sell'
             AND f.action IN ('fill', 'reject')
         )
     )
     WHERE rn = 1
     ORDER BY order_no`,
    [String(userId)]
  );
  return result.rows.map((r) => ({
    stockCode: String(r.stock_code).substring(0, 6),
    orderNo: r.order_no,
    orderPrice: r.order_price != null ? Number(r.order_price) : null,
    qty: r.qty != null ? Number(r.qty) : null,
    venue: r.venue || 'KRX',
    positionId: r.position_id != null ? Number(r.position_id) : null,
  }));
};

const getSellingPositions = async (userId) => {
  await ensurePositionTables();
  const result = await pool.query(
    `SELECT * FROM indicator_positions
     WHERE user_id = $1 AND status = 'selling'
     ORDER BY created_at ASC`,
    [String(userId)]
  );
  return result.rows.map(mapPosition);
};

/** status=selling 포지션이 있는 사용자 id 목록 */
const listUserIdsWithSellingPositions = async () => {
  await ensurePositionTables();
  const result = await pool.query(
    `SELECT DISTINCT user_id FROM indicator_positions WHERE status = 'selling'`
  );
  return result.rows.map((r) => String(r.user_id));
};

/**
 * DB 미체결 매수 place — 주문번호별 전량 (종목당 여러 건 가능)
 */
const getUnfilledBuyPlacesFromOrders = async (userId) => {
  await ensurePositionTables();
  const result = await pool.query(
    `SELECT o.stock_code, o.order_no, o.order_price, o.qty, o.venue, o.created_at
     FROM indicator_orders o
     WHERE o.user_id = $1
       AND o.side = 'buy'
       AND o.action = 'place'
       AND o.created_at > NOW() - INTERVAL '1 day'
       AND o.order_no IS NOT NULL
       AND TRIM(o.order_no) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM indicator_orders f
         WHERE f.user_id = o.user_id
           AND f.order_no IS NOT NULL
           AND o.order_no IS NOT NULL
           AND f.order_no = o.order_no
           AND f.side = 'buy'
           AND f.action IN ('fill', 'reject')
       )
     ORDER BY o.created_at DESC`,
    [String(userId)]
  );

  let nameByCode = new Map();
  try {
    const { getTrackingStocks } = require('./indicatorTradingStore');
    const tracking = await getTrackingStocks(userId);
    for (const row of tracking) {
      const code6 = String(row?.stockCode || '').substring(0, 6);
      if (code6 && row?.stockName) nameByCode.set(code6, String(row.stockName).trim());
    }
  } catch {
    /* ignore */
  }

  const rows = [];
  for (const r of result.rows) {
    const code6 = String(r.stock_code).substring(0, 6);
    let stockName = nameByCode.get(code6) || '';
    if (!stockName) {
      stockName = await resolveIndicatorStockName(userId, code6, '');
    }
    rows.push({
      stockCode: code6,
      stockName,
      stockMarket: r.venue || 'KRX',
      buyOrderNo: r.order_no || null,
      buyPrice: r.order_price != null ? Number(r.order_price) : null,
      buyQty: r.qty != null ? Number(r.qty) : null,
      buyOrderStatus: '주문 완료',
      sellOrderStatus: '대기',
      pendingFill: true,
    });
  }
  return rows;
};

const hasUnfilledBuyPlace = async (userId, stockCode) => {
  await ensurePositionTables();
  const code6 = String(stockCode || '').substring(0, 6);
  if (!code6) return false;
  const result = await pool.query(
    `SELECT 1
     FROM indicator_orders o
     WHERE o.user_id = $1
       AND LEFT(o.stock_code, 6) = $2
       AND o.side = 'buy'
       AND o.action = 'place'
       AND o.created_at > NOW() - INTERVAL '1 day'
       AND NOT EXISTS (
         SELECT 1 FROM indicator_orders f
         WHERE f.user_id = o.user_id
           AND f.side = 'buy'
           AND f.action IN ('fill', 'reject')
           AND f.order_no IS NOT NULL
           AND o.order_no IS NOT NULL
           AND f.order_no = o.order_no
       )
     LIMIT 1`,
    [String(userId), code6]
  );
  return result.rows.length > 0;
};

const mergeTrackingWithPositions = async (userId, trackingList) => {
  const posMap = await getActivePositionsMap(userId);

  // tracking에 manual이 남아 있으면 포지션 entry_source 보강 (이후 병합·재구성용)
  for (const row of Array.isArray(trackingList) ? trackingList : []) {
    if (row?.source !== 'manual') continue;
    const c6 = String(row.stockCode || '').substring(0, 6);
    const pos = posMap.get(c6) || posMap.get(row.stockCode);
    if (!pos?.id || pos.entrySource === 'manual') continue;
    try {
      await pool.query(
        `UPDATE indicator_positions SET entry_source = 'manual', updated_at = NOW()
         WHERE id = $1 AND user_id = $2
           AND (entry_source IS NULL OR entry_source = '')`,
        [pos.id, String(userId)]
      );
      pos.entrySource = 'manual';
    } catch {
      /* ignore */
    }
  }

  // 자동매매 OFF면 미체결(주문중) UI 숨김 — 보유(open/selling)만 표시
  let autoOn = false;
  try {
    const { getIndicatorTrading } = require('./indicatorTradingStore');
    const state = await getIndicatorTrading(userId);
    autoOn = !!state.autoTradingEnabled;
  } catch (_) {
    autoOn = false;
  }

  const pendingMap = new Map();
  if (autoOn) {
    let pendingList = [];
    try {
      const { listPendingIndicatorBuys } = require('./indicatorBuyFill');
      pendingList = listPendingIndicatorBuys(userId);
    } catch (_) {
      pendingList = [];
    }
    const pendingFromDb = await getUnfilledBuyPlacesFromOrders(userId);
    for (const p of [...pendingFromDb, ...pendingList]) {
      if (p?.stockCode) pendingMap.set(String(p.stockCode).substring(0, 6), p);
    }
  }

  const seen = new Set();
  const sourceByCode = new Map();
  for (const row of Array.isArray(trackingList) ? trackingList : []) {
    const c6 = String(row?.stockCode || '').substring(0, 6);
    if (c6 && row?.source) sourceByCode.set(c6, row.source);
  }
  for (const [code, pos] of posMap.entries()) {
    const c6 = String(code).substring(0, 6);
    if (c6 && pos?.entrySource && !sourceByCode.has(c6)) {
      sourceByCode.set(c6, pos.entrySource);
    }
  }

  const merged = (Array.isArray(trackingList) ? trackingList : []).map((row) => {
    const code = String(row.stockCode || '').substring(0, 6);
    seen.add(code);
    const withSource = {
      ...row,
      source: row.source || sourceByCode.get(code) || null,
    };
    if (withSource.source) sourceByCode.set(code, withSource.source);
    const withPos = mergePositionIntoTrackingRow(
      withSource,
      posMap.get(code) || posMap.get(row.stockCode) || null
    );
    const pending = pendingMap.get(code);
    if (pending && !withPos.positionId) {
      return {
        ...withPos,
        buyPrice: pending.buyPrice ?? withPos.buyPrice,
        buyQty: pending.buyQty ?? withPos.buyQty,
        buyOrderNo: pending.buyOrderNo ?? withPos.buyOrderNo,
        buyOrderStatus: '주문 완료',
        sellOrderStatus: withPos.sellOrderStatus || '대기',
        profitRate: null,
      };
    }
    // OFF이거나 미체결 없음 — 주문중/매입가 잔상 제거
    if (!withPos.positionId) {
      return {
        ...withPos,
        buyPrice: null,
        buyQty: null,
        buyOrderNo: null,
        buyOrderStatus: withPos.buyOrderStatus === '주문 완료' ? '대기' : withPos.buyOrderStatus || '대기',
      };
    }
    return withPos;
  });

  for (const [code, pos] of posMap.entries()) {
    const c6 = String(code).substring(0, 6);
    if (seen.has(c6)) continue;
    seen.add(c6);
    merged.push(
      mergePositionIntoTrackingRow(
        {
          stockCode: c6,
          stockName: pos.stockName || c6,
          stockMarket: pos.venue || 'KRX',
          price: pos.lastPrice,
          source: pos.entrySource || sourceByCode.get(c6) || null,
        },
        pos
      )
    );
  }

  if (autoOn) {
    for (const [code, pending] of pendingMap.entries()) {
      if (seen.has(code)) continue;
      seen.add(code);
      merged.push({
        stockCode: code,
        stockName: pending.stockName || code,
        stockMarket: pending.stockMarket || 'KRX',
        price: pending.buyPrice,
        buyPrice: pending.buyPrice,
        buyQty: pending.buyQty,
        buyOrderNo: pending.buyOrderNo,
        buyOrderStatus: '주문 완료',
        sellOrderStatus: '대기',
        dailyMa: null,
        minuteMa: null,
        profitRate: null,
      });
    }
  }

  return enrichTrackingRowsWithLivePrices(
    userId,
    await enrichTrackingRowsWithNames(userId, merged)
  );
};

const calcTrackingProfitRate = (buyPrice, currentPrice) => {
  const buy = Number(buyPrice);
  const cur = Number(currentPrice);
  if (!(buy > 0) || !(cur > 0)) return null;
  return Number((((cur - buy) / buy) * 100).toFixed(4));
};

/** 트래킹 목록 현재가 — WS/시세 hub 캐시만 사용 (REST 조회 없음) */
const enrichTrackingRowsWithLivePrices = (userId, rows) => {
  const uid = String(userId);
  let lookupLastPrice = null;
  try {
    lookupLastPrice = require('../services/watchlistPriceWsHub').lookupLastPrice;
  } catch {
    lookupLastPrice = () => null;
  }

  return (rows || []).map((row) => {
    const next = { ...row };
    const code6 = String(next.stockCode || '').substring(0, 6);
    if (!code6) return next;

    const live = lookupLastPrice(uid, code6);
    if (live?.price > 0) {
      next.price = Math.round(Number(live.price));
      if (live.changeRate != null) next.changeRate = live.changeRate;
    }

    const buyPrice = Number(next.buyPrice);
    const filledBuy = next.buyOrderStatus === '체결 완료' || !!next.positionId;
    if (filledBuy && buyPrice > 0 && Number(next.price) > 0) {
      next.profitRate = calcTrackingProfitRate(buyPrice, next.price);
    } else {
      next.profitRate = null;
    }
    return next;
  });
};

const sellReasonToLabel = (reason) => {
  const map = {
    take_profit: '익절',
    stop_loss: '손절',
    trailing: '트레일링',
    recovery: '복구',
    auto_trading_off: '자동매매OFF',
    auto_trading_off_cancel_failed: '자동매매OFF(취소실패)',
    eod_unfilled: '장마감미체결',
    eod_unfilled_cancel_failed: '장마감미체결(취소실패)',
    fill_timeout: '체결타임아웃',
    daily_ma: '일봉이평',
    minute_ma: '분봉이평',
  };
  const key = String(reason || '').trim();
  return map[key] || key || '-';
};

const formatKstDate = (value) => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const k = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const y = k.getFullYear();
  const m = String(k.getMonth() + 1).padStart(2, '0');
  const day = String(k.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseTradeDateParam = (value) => {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
};

const tradeSoldAtExpr = `COALESCE(p.sell_filled_at, p.closed_at, p.sell_ordered_at, p.updated_at)`;

const mapClosedTrade = (row) => {
  const buyPrice = Number(row.buy_filled_price ?? row.buy_order_price) || 0;
  const sellPrice =
    Number(row.sell_filled_price ?? row.sell_order_price ?? row.order_fill_price) || 0;
  const buyQty = Number(row.buy_filled_qty || row.buy_qty) || 0;
  const sellQty =
    Number(row.sell_filled_qty || row.sell_qty || row.order_fill_qty || row.buy_filled_qty) || 0;
  const qty = sellQty > 0 ? sellQty : buyQty;
  const profitAmount =
    qty > 0 && buyPrice > 0 && sellPrice > 0
      ? Math.round((sellPrice - buyPrice) * qty)
      : null;
  const profitRate =
    buyPrice > 0 && sellPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : null;
  const soldAt =
    row.sell_filled_at || row.closed_at || row.sell_ordered_at || row.updated_at;

  return {
    id: Number(row.id),
    tradeDate: formatKstDate(soldAt),
    soldAt: soldAt ? new Date(soldAt).toISOString() : null,
    stockCode: row.stock_code,
    stockName: row.stock_name || '',
    venue: row.venue || 'KRX',
    buyPrice: buyPrice > 0 ? buyPrice : null,
    buyQty: buyQty > 0 ? buyQty : null,
    sellPrice: sellPrice > 0 ? sellPrice : null,
    sellQty: qty > 0 ? qty : null,
    profitAmount,
    profitRate: profitRate != null ? Number(profitRate.toFixed(4)) : null,
    sellReason: row.sell_reason || null,
    sellReasonLabel: sellReasonToLabel(row.sell_reason),
    estimated: !row.sell_filled_at && !row.order_fill_price,
  };
};

/** 청산 기록이 불완전한 closed 포지션 보정 */
const repairIncompleteClosedPositions = async (userId) => {
  await ensurePositionTables();
  await pool.query(
    `UPDATE indicator_positions SET
       sell_filled_price = COALESCE(sell_filled_price, sell_order_price),
       sell_filled_qty = COALESCE(
         NULLIF(sell_filled_qty, 0),
         NULLIF(sell_qty, 0),
         NULLIF(buy_filled_qty, 0),
         buy_qty
       ),
       sell_filled_at = COALESCE(sell_filled_at, sell_ordered_at, updated_at),
       closed_at = COALESCE(closed_at, sell_filled_at, sell_ordered_at, updated_at),
       updated_at = NOW()
     WHERE user_id = $1
       AND status = 'closed'
       AND (
         sell_filled_at IS NULL
         OR closed_at IS NULL
         OR sell_filled_price IS NULL
         OR sell_filled_qty IS NULL
         OR sell_filled_qty = 0
       )`,
    [String(userId)]
  );
};

/**
 * 청산 완료 거래 내역 (매도일 기준 기간 조회)
 */
const getClosedTradeHistory = async (userId, { startDate, endDate } = {}) => {
  await ensurePositionTables();
  const start = parseTradeDateParam(startDate);
  const end = parseTradeDateParam(endDate);
  if (!start || !end) {
    throw new Error('startDate, endDate는 YYYY-MM-DD 형식이어야 합니다.');
  }
  if (start > end) {
    throw new Error('시작일이 종료일보다 늦을 수 없습니다.');
  }

  await repairIncompleteClosedPositions(userId);

  const lastSellFill = (col) => `(
       SELECT ${col} FROM indicator_orders
       WHERE position_id = p.id AND side = 'sell' AND action = 'fill'
       ORDER BY created_at DESC
       LIMIT 1
     )`;
  const result = await pool.query(
    `SELECT p.*,
            ${lastSellFill('filled_price')} AS order_fill_price,
            ${lastSellFill('filled_qty')} AS order_fill_qty
     FROM indicator_positions p
     WHERE p.user_id = $1
       AND p.status = 'closed'
       AND COALESCE(p.sell_filled_price, p.sell_order_price, ${lastSellFill('filled_price')}) IS NOT NULL
       AND date(${tradeSoldAtExpr}, '+9 hours') >= date($2)
       AND date(${tradeSoldAtExpr}, '+9 hours') <= date($3)
     ORDER BY ${tradeSoldAtExpr} DESC, p.id DESC`,
    [String(userId), start, end]
  );

  return {
    startDate: start,
    endDate: end,
    trades: result.rows.map(mapClosedTrade),
  };
};

module.exports = {
  ACTIVE_STATUSES,
  ensurePositionTables,
  mapPosition,
  mapOrder,
  statusToBuyUi,
  statusToSellUi,
  mergePositionIntoTrackingRow,
  getActivePositions,
  getOpenPositions,
  getActivePositionByCode,
  hasProfitableCloseToday,
  getActivePositionsMap,
  summarizeActiveUsage,
  resolveIndicatorStockName,
  enrichTrackingRowsWithNames,
  resolveTrackingEntrySource,
  insertBuyOrder,
  createFilledBuyPosition,
  addBuyFillToOpenPosition,
  hasBuyFillForOrderNo,
  insertOrderLog,
  markBuyFilled,
  updatePositionPriceState,
  markPositionSelling,
  updateSellingOrderDetails,
  revertPositionToOpen,
  markPositionClosed,
  markPositionCancelled,
  cancelPendingBuyPositionsForCode,
  cancelActivePositionsForUser,
  placeSellForPosition,
  getRecentOrders,
  migrateBuysFromTrackingJson,
  stripOrderFieldsFromTracking,
  getUnfilledBuyPlacesFromOrders,
  getUnfilledSellPlacesFromOrders,
  getSellingPositions,
  listUserIdsWithSellingPositions,
  hasUnfilledBuyPlace,
  mergeTrackingWithPositions,
  enrichTrackingRowsWithLivePrices,
  getClosedTradeHistory,
  sellReasonToLabel,
};

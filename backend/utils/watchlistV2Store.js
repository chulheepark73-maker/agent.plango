/**
 * 관심종목 V2 — instruments FK, KRX/US 통합
 * 레거시 users.watchlist / us_watchlist 와 분리
 */
const pool = require('./db');
const {
  ensureTradingV2Tables,
  upsertInstrument,
  releaseTradingPlansForUnwatchedInstrument,
} = require('./tradingV2Store');
const { getUserPlanLimits } = require('./subscriptionStore');
const { looksLikeUsTicker } = require('./autoTradingMarket');

const MAX_GROUP_NO = 8;

const normalizeGroupNo = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_GROUP_NO) return 1;
  return n;
};

/** UI용: 첫 글자 영문→US, 숫자→KRX (0181B0 등 국내 영문포함 코드) */
const toUiMarket = (symbol) => (looksLikeUsTicker(symbol) ? 'US' : 'KRX');

const mapRow = (row) => {
  if (!row) return null;
  const symbol = row.symbol;
  const market = looksLikeUsTicker(symbol) ? 'US' : 'KR';
  return {
    id: Number(row.id),
    instrumentId: Number(row.instrument_id),
    stockCode: symbol,
    stockName: row.name || symbol,
    stockMarket: toUiMarket(symbol),
    market,
    currency: row.currency || (market === 'US' ? 'USD' : 'KRW'),
    exchange: row.exchange || null,
    groupNo: normalizeGroupNo(row.group_no),
    createdAt: row.created_at,
  };
};

const countWatchlistV2 = async (userId) => {
  await ensureTradingV2Tables();
  const result = await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM watchlist_v2 WHERE user_id = $1',
    [String(userId)]
  );
  return result.rows[0]?.cnt || 0;
};

const assertCanAddWatchlistV2 = async (userId) => {
  const limits = await getUserPlanLimits(userId);
  if (limits.maxWatchlist == null) return limits;
  const count = await countWatchlistV2(userId);
  if (count >= limits.maxWatchlist) {
    const err = new Error(
      `일반회원은 관심종목을 ${limits.maxWatchlist}개까지 등록할 수 있습니다. 프리미엄 구독 시 무제한입니다.`
    );
    err.status = 403;
    err.code = 'PLAN_LIMIT_WATCHLIST';
    throw err;
  }
  return { ...limits, count };
};

const listWatchlistV2 = async (userId, { groupNo } = {}) => {
  await ensureTradingV2Tables();
  try {
    const { ensureUsStockListTable } = require('./usStockListStore');
    await ensureUsStockListTable();
  } catch {
    /* us_stock_list 없어도 venue exchange 로 동작 */
  }
  const uid = String(userId);
  const params = [uid];
  let sql = `
    SELECT w.id, w.user_id, w.instrument_id, w.group_no, w.created_at,
           i.market, i.symbol, i.name, i.currency,
           CASE
             WHEN UPPER(i.market) = 'US' THEN COALESCE(
               (SELECT u.exchange FROM us_stock_list u
                 WHERE u.ticker = i.symbol LIMIT 1),
               (SELECT v.exchange FROM instrument_venues v
                 WHERE v.instrument_id = i.id
                 ORDER BY v.id ASC LIMIT 1)
             )
             ELSE (
               SELECT v.exchange FROM instrument_venues v
               WHERE v.instrument_id = i.id
               ORDER BY v.id ASC LIMIT 1
             )
           END AS exchange
    FROM watchlist_v2 w
    JOIN instruments i ON i.id = w.instrument_id
    WHERE w.user_id = $1
  `;
  if (groupNo !== undefined && groupNo !== null && groupNo !== '') {
    params.push(normalizeGroupNo(groupNo));
    sql += ` AND w.group_no = $2`;
  }
  sql += ` ORDER BY w.created_at ASC, w.id ASC`;
  const result = await pool.query(sql, params);
  return result.rows.map(mapRow);
};

/**
 * 종목 추가: instruments upsert → watchlist_v2 insert
 * body: { market: 'KR'|'US'|'KRX', symbol, name?, exchange?, groupNo? }
 */
const addWatchlistV2Item = async (userId, body = {}) => {
  await ensureTradingV2Tables();
  await assertCanAddWatchlistV2(userId);

  let market = String(body.market || body.stockMarket || '').toUpperCase();
  if (market === 'KRX' || market === 'NXT') market = 'KR';
  const symbol = String(body.symbol || body.stockCode || '').trim();
  if (!market || !symbol) {
    throw Object.assign(new Error('market과 symbol(종목코드)은 필수입니다.'), { status: 400 });
  }

  const { instrument, venue } = await upsertInstrument({
    market,
    symbol,
    name: body.name || body.stockName || null,
    currency: body.currency || null,
    exchange: body.exchange || null,
    brokerSymbol: body.brokerSymbol || symbol,
    mrktTp: body.mrktTp || body.mrkt_tp || null,
    userId,
  });

  const groupNo = normalizeGroupNo(body.groupNo);
  try {
    const insert = await pool.query(
      `INSERT INTO watchlist_v2 (user_id, instrument_id, group_no)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, instrument_id, group_no, created_at`,
      [String(userId), instrument.id, groupNo]
    );
    return mapRow({
      ...insert.rows[0],
      market: instrument.market,
      symbol: instrument.symbol,
      name: instrument.name,
      currency: instrument.currency,
      exchange: venue?.exchange || null,
    });
  } catch (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error('이미 관심종목에 등록된 종목입니다.'), { status: 400 });
    }
    throw error;
  }
};

const removeWatchlistV2Item = async (userId, { id, instrumentId, symbol, market } = {}) => {
  await ensureTradingV2Tables();
  const uid = String(userId);

  let targetId = id != null ? Number(id) : null;
  let targetInstrumentId = instrumentId != null ? Number(instrumentId) : null;

  // instrument_id 확보 (플랜 정리 + watchlist 삭제에 필요)
  if (targetId && !targetInstrumentId) {
    const found = await pool.query(
      'SELECT id, instrument_id FROM watchlist_v2 WHERE user_id = $1 AND id = $2',
      [uid, targetId]
    );
    if (!found.rowCount) {
      throw Object.assign(new Error('관심종목을 찾을 수 없습니다.'), { status: 404 });
    }
    targetInstrumentId = Number(found.rows[0].instrument_id);
  } else if (!targetInstrumentId && (symbol || market)) {
    let mkt = String(market || '').toUpperCase();
    if (mkt === 'KRX' || mkt === 'NXT') mkt = 'KR';
    const sym = String(symbol || '').trim().toUpperCase();
    if (!mkt || !sym) {
      throw Object.assign(new Error('삭제할 id 또는 market+symbol이 필요합니다.'), { status: 400 });
    }
    const found = await pool.query(
      `SELECT w.id, w.instrument_id
       FROM watchlist_v2 w
       JOIN instruments i ON i.id = w.instrument_id
       WHERE w.user_id = $1 AND i.market = $2 AND UPPER(i.symbol) = $3`,
      [uid, mkt, sym]
    );
    if (!found.rowCount) {
      throw Object.assign(new Error('관심종목을 찾을 수 없습니다.'), { status: 404 });
    }
    targetId = Number(found.rows[0].id);
    targetInstrumentId = Number(found.rows[0].instrument_id);
  } else if (targetInstrumentId && !targetId) {
    const found = await pool.query(
      'SELECT id, instrument_id FROM watchlist_v2 WHERE user_id = $1 AND instrument_id = $2',
      [uid, targetInstrumentId]
    );
    if (!found.rowCount) {
      throw Object.assign(new Error('관심종목을 찾을 수 없습니다.'), { status: 404 });
    }
    targetId = Number(found.rows[0].id);
  }

  if (!targetId || !targetInstrumentId) {
    throw Object.assign(new Error('삭제할 id 또는 market+symbol이 필요합니다.'), { status: 400 });
  }

  // 보유·미체결 있으면 거부 / 이력 없으면 플랜 삭제 / 전량 매도 완료면 플랜 보존(paused)
  const plansResult = await releaseTradingPlansForUnwatchedInstrument(uid, targetInstrumentId);

  const result = await pool.query(
    'DELETE FROM watchlist_v2 WHERE user_id = $1 AND id = $2 RETURNING id',
    [uid, targetId]
  );
  if (!result.rowCount) {
    throw Object.assign(new Error('관심종목을 찾을 수 없습니다.'), { status: 404 });
  }
  return {
    deleted: true,
    id: targetId,
    instrumentId: targetInstrumentId,
    deletedPlanCount: plansResult.deletedPlanCount,
    deletedPlanIds: plansResult.deletedPlanIds,
    pausedPlanIds: plansResult.pausedPlanIds || [],
  };
};

module.exports = {
  normalizeGroupNo,
  listWatchlistV2,
  addWatchlistV2Item,
  removeWatchlistV2Item,
  countWatchlistV2,
  assertCanAddWatchlistV2,
};

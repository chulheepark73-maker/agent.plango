/**
 * Trading V2 — ERD 기반 스토어
 * 기존 auto_tradings / us_auto_tradings 와 완전 분리
 */
const fs = require('fs');
const path = require('path');
const pool = require('./db');
const { getUserById } = require('./userStore');
const { looksLikeUsTicker } = require('./autoTradingMarket');
const { assertCanActivateTradingV2 } = require('./subscriptionStore');

const STRATEGY_TYPES = ['SPLIT_TRADE', 'INFINITE_TRADE'];
const PLAN_STATUSES = ['draft', 'active', 'paused', 'completed', 'cancelled'];
const STAGE_STATUSES = ['pending', 'ordered', 'filled', 'skipped', 'cancelled'];
const ORDER_STATUSES = ['pending', 'submitted', 'partial', 'filled', 'cancelled', 'rejected'];

/**
 * 레거시 POST /auto-trading 과 동일: 조건·설정 저장 시 armed trailing 무조건 중지
 * (메모리 클로저가 옛 targetPrice / trailing% 로 도는 것 방지 → 이후 시세에서 재 arm)
 */
const stopPlanTrailingsOnSave = (planId, { silent = false, reason = '설정 변경으로 중단됨' } = {}) => {
  const id = Number(planId);
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    const { stopV2BuyTrailingsByPlanId } = require('./autoTradingBuyTrailingStop');
    const { stopV2SellTrailingsByPlanId } = require('./autoTradingTrailingStop');
    stopV2BuyTrailingsByPlanId(id, { silent, reason });
    stopV2SellTrailingsByPlanId(id, { silent, reason });
    try {
      require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
    } catch {
      /* ignore */
    }
  } catch (err) {
    console.warn(`[TradingV2] plan=${id} trailing 중지 실패:`, err.message);
  }
};

let ensurePromise = null;

/** TIMESTAMP without tz → TIMESTAMPTZ (기존 값은 UTC 벽시계로 저장됨) */
const migrateCredentialsExpiresToTimestamptz = async () => {
  const cols = ['access_token_expires_at', 'app_key_expires_at'];
  for (const col of cols) {
    const { rows } = await pool.query(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'broker_account_credentials'
         AND column_name = $1`,
      [col]
    );
    if (!rows.length) continue;
    if (rows[0].data_type !== 'timestamp without time zone') continue;
    await pool.query(`
      ALTER TABLE broker_account_credentials
      ALTER COLUMN ${col} TYPE TIMESTAMPTZ
      USING ${col} AT TIME ZONE 'UTC'
    `);
  }
};

const runSqlFile = async (relativePath) => {
  const full = path.join(__dirname, '..', relativePath);
  const sql = fs.readFileSync(full, 'utf8');
  await pool.query(sql);

  // 기존 DB 호환: account_name 추가, app_key/app_secret 제거 (키는 users 유지)
  await pool.query(`
    ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS account_name VARCHAR(100)
  `);
  await pool.query(`
    ALTER TABLE broker_accounts
    DROP COLUMN IF EXISTS app_key
  `);
  await pool.query(`
    ALTER TABLE broker_accounts
    DROP COLUMN IF EXISTS app_secret
  `);

  // 유저+브로커당 1계좌로 유니크 정리 (옛 uq_broker_accounts_user_broker_acct 제거)
  await pool.query(`DROP INDEX IF EXISTS uq_broker_accounts_user_broker_acct`);
  await pool.query(`
    UPDATE trading_plans p
    SET broker_account_id = keep.id
    FROM broker_accounts dup
    JOIN LATERAL (
      SELECT id FROM broker_accounts b
      WHERE b.user_id = dup.user_id AND b.broker = dup.broker
      ORDER BY b.id ASC
      LIMIT 1
    ) keep ON true
    WHERE p.broker_account_id = dup.id
      AND dup.id <> keep.id
  `);
  await pool.query(`
    DELETE FROM broker_accounts a
    USING broker_accounts b
    WHERE a.user_id = b.user_id
      AND a.broker = b.broker
      AND a.id > b.id
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_accounts_user_broker
    ON broker_accounts (user_id, broker)
  `);

  await pool.query(`
    ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS buy_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0.000125
  `);
  await pool.query(`
    ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS sell_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0.000125
  `);
  await pool.query(`
    ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS sell_tax_rate NUMERIC(12, 8) NOT NULL DEFAULT 0.0018
  `);
  await pool.query(`
    ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS us_buy_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS us_sell_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS us_sell_tax_rate NUMERIC(12, 8) NOT NULL DEFAULT 0
  `);

  await pool.query(`ALTER TABLE instruments ADD COLUMN IF NOT EXISTS mrkt_tp VARCHAR(10)`);

  // 계좌별 API 자격증명 (users.kiwoom_* 미러 — 컬럼명 *_encrypted, 현재는 users 와 동일 저장)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broker_account_credentials (
      id BIGSERIAL PRIMARY KEY,
      broker_account_id BIGINT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
      app_key_encrypted TEXT,
      app_secret_encrypted TEXT,
      app_key_expires_at TIMESTAMPTZ NULL,
      access_token_encrypted TEXT,
      access_token_expires_at TIMESTAMPTZ NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_account_credentials_account
    ON broker_account_credentials (broker_account_id)
  `);

  // TIMESTAMP(without tz) → TIMESTAMPTZ: 기존 값은 UTC 벽시계로 저장돼 있었음
  await migrateCredentialsExpiresToTimestamptz();
};

const ensureTradingV2Tables = async () => {
  if (!ensurePromise) {
    ensurePromise = runSqlFile('scripts/create_trading_v2_tables.sql')
      .then(() => {
        console.log('[TradingV2] 테이블 준비 완료');
      })
      .catch((err) => {
        ensurePromise = null;
        console.error('[TradingV2] 테이블 준비 실패:', err.message);
        throw err;
      });
  }
  await ensurePromise;
};

const toNum = (v, fallback = null) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const mapInstrument = (row) =>
  row
    ? {
        id: Number(row.id),
        market: row.market,
        symbol: row.symbol,
        name: row.name,
        currency: row.currency,
        country: row.country,
        mrktTp: row.mrkt_tp != null && row.mrkt_tp !== '' ? String(row.mrkt_tp) : null,
        isActive: row.is_active,
      }
    : null;

const mapInstrumentFromPlanRow = (row) =>
  mapInstrument({
    id: row.instrument_id,
    market: row.i_market,
    symbol: row.i_symbol,
    name: row.i_name,
    currency: row.i_currency,
    country: row.i_country,
    is_active: row.i_is_active,
    mrkt_tp: row.i_mrkt_tp,
  });

const mapVenue = (row) =>
  row
    ? {
        id: Number(row.id),
        instrumentId: Number(row.instrument_id),
        exchange: row.exchange,
        brokerSymbol: row.broker_symbol,
        isTradable: row.is_tradable,
      }
    : null;

const mapBrokerAccount = (row) =>
  row
    ? {
        id: Number(row.id),
        userId: row.user_id,
        broker: row.broker,
        accountNo: row.account_no,
        accountName: row.account_name || null,
        accountType: row.account_type,
        isActive: row.is_active,
      }
    : null;

const mapStage = (row) =>
  row
    ? {
        id: Number(row.id),
        cycleId: Number(row.cycle_id),
        side: row.side,
        stage: Number(row.stage),
        percent: toNum(row.percent),
        targetPrice: toNum(row.target_price),
        targetAmount: toNum(row.target_amount),
        targetQty: toNum(row.target_qty),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const mapCycle = (row) =>
  row
    ? {
        id: Number(row.id),
        tradingId: Number(row.trading_id),
        cycleNo: Number(row.cycle_no),
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const mapOrder = (row) =>
  row
    ? {
        id: Number(row.id),
        tradingId: Number(row.trading_id),
        cycleId: row.cycle_id != null ? Number(row.cycle_id) : null,
        stageId: row.stage_id != null ? Number(row.stage_id) : null,
        brokerAccountId: row.broker_account_id != null ? Number(row.broker_account_id) : null,
        instrumentId: Number(row.instrument_id),
        venueId: row.venue_id != null ? Number(row.venue_id) : null,
        side: row.side,
        orderType: row.order_type,
        requestedPrice: toNum(row.requested_price),
        requestedQty: toNum(row.requested_qty),
        requestedAmount: toNum(row.requested_amount),
        brokerOrderNo: row.broker_order_no,
        stageNo: row.stage_no != null ? Number(row.stage_no) : null,
        orderReason: row.order_reason || null,
        status: row.status,
        orderedAt: row.ordered_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const mapFill = (row) =>
  row
    ? {
        id: Number(row.id),
        orderId: Number(row.order_id),
        fillPrice: toNum(row.fill_price),
        fillQty: toNum(row.fill_qty),
        fillAmount: toNum(row.fill_amount),
        brokerFillNo: row.broker_fill_no,
        filledAt: row.filled_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const mapPlan = (row) =>
  row
    ? {
        id: Number(row.id),
        userId: row.user_id,
        brokerAccountId: row.broker_account_id != null ? Number(row.broker_account_id) : null,
        instrumentId: Number(row.instrument_id),
        venueId: row.venue_id != null ? Number(row.venue_id) : null,
        strategyType: row.strategy_type,
        status: row.status,
        strategyConfig: row.strategy_config || {},
        currentCycleId: row.current_cycle_id != null ? Number(row.current_cycle_id) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

/**
 * broker_accounts 행 보장
 * account_no / account_name 은 overrides 또는 기존 값 유지 (users.kiwoom_* 미사용)
 */
const ensureBrokerAccountForUser = async (userId, overrides = {}) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  let accountName = overrides.accountName;
  if (accountName === undefined) {
    try {
      const user = await getUserById(uid);
      accountName = user?.username || user?.email || null;
    } catch {
      accountName = null;
    }
  }
  const accountNo = overrides.accountNo !== undefined ? overrides.accountNo || null : null;

  const existing = await pool.query(
    `SELECT * FROM broker_accounts
     WHERE user_id = $1 AND broker = 'kiwoom'
     ORDER BY is_active DESC, id ASC
     LIMIT 1`,
    [uid]
  );

  if (existing.rows[0]) {
    const updated = await pool.query(
      `UPDATE broker_accounts SET
         account_no = COALESCE(NULLIF($2::text, ''), account_no),
         account_name = COALESCE(NULLIF($3::text, ''), account_name),
         account_type = COALESCE(account_type, 'integrated'),
         is_active = true,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [existing.rows[0].id, accountNo, accountName]
    );
    return mapBrokerAccount(updated.rows[0]);
  }

  try {
    const result = await pool.query(
      `INSERT INTO broker_accounts (
         user_id, broker, account_no, account_name, account_type, is_active
       ) VALUES ($1, 'kiwoom', $2, $3, 'integrated', true)
       ON CONFLICT (user_id, broker) DO UPDATE SET
         account_no = COALESCE(NULLIF(EXCLUDED.account_no, ''), broker_accounts.account_no),
         account_name = COALESCE(NULLIF(EXCLUDED.account_name, ''), broker_accounts.account_name),
         account_type = COALESCE(broker_accounts.account_type, 'integrated'),
         is_active = true,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [uid, accountNo, accountName]
    );
    return mapBrokerAccount(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      const again = await pool.query(
        `SELECT * FROM broker_accounts
         WHERE user_id = $1 AND broker = 'kiwoom'
         ORDER BY id ASC LIMIT 1`,
        [uid]
      );
      if (again.rows[0]) return mapBrokerAccount(again.rows[0]);
    }
    throw err;
  }
};

/** @deprecated brokerCredentialsStore 사용 */
const upsertBrokerAccountCredentialsFromUser = async (userId, overrides = {}) => {
  const {
    saveAppCredentials,
    saveAccessToken,
    getBrokerKiwoomBundle,
  } = require('./brokerCredentialsStore');
  if (overrides.appKey !== undefined || overrides.appSecret !== undefined) {
    await saveAppCredentials(userId, {
      appKey: overrides.appKey,
      appSecret: overrides.appSecret,
    });
  }
  if (overrides.accessToken !== undefined || overrides.accessTokenExpiresAt !== undefined) {
    await saveAccessToken(userId, {
      accessToken: overrides.accessToken,
      expiresAt: overrides.accessTokenExpiresAt,
    });
  }
  if (overrides.accountNo !== undefined || overrides.accountName !== undefined) {
    await ensureBrokerAccountForUser(userId, {
      accountNo: overrides.accountNo,
      accountName: overrides.accountName,
    });
  }
  return getBrokerKiwoomBundle(userId);
};

const upsertInstrument = async ({
  market,
  symbol,
  name = null,
  currency = null,
  country = null,
  exchange = null,
  brokerSymbol = null,
  mrktTp = null,
  userId = null,
}) => {
  await ensureTradingV2Tables();
  let mkt = String(market || '').toUpperCase();
  let sym = String(symbol || '').trim().toUpperCase();
  if (!mkt || !sym) throw new Error('market과 symbol은 필수입니다.');
  if (mkt === 'KRX' || mkt === 'NXT') mkt = 'KR';
  mkt = looksLikeUsTicker(sym) ? 'US' : 'KR';
  if (!['KR', 'US'].includes(mkt)) throw new Error('market은 KR 또는 US여야 합니다.');
  if (mkt === 'KR') {
    const { normalizeKrSymbol } = require('./krMrktTp');
    sym = normalizeKrSymbol(sym) || sym;
  }

  const cur = currency || (mkt === 'US' ? 'USD' : 'KRW');
  const ctry = country || (mkt === 'US' ? 'US' : 'KR');
  let exch = exchange;
  if (mkt === 'US') {
    // V2 기본 NASDAQ 오지정 방지 — us_stock_list 마스터 우선
    try {
      const { getUsStockByTicker } = require('./usStockListStore');
      const master = await getUsStockByTicker(sym);
      if (master?.exchange) exch = master.exchange;
    } catch {
      /* ignore */
    }
    exch = exch || 'NASDAQ';
  } else {
    exch = exch || 'KRX';
  }

  let resolvedMrktTp = mrktTp != null && String(mrktTp).trim() !== '' ? String(mrktTp).trim() : null;
  if (mkt === 'KR' && !resolvedMrktTp) {
    try {
      const { resolveKrMrktTp } = require('./stockListStore');
      resolvedMrktTp = await resolveKrMrktTp(userId, sym);
    } catch {
      /* stock_list / 키움 조회 실패 시 스킵 */
    }
  }
  if (mkt === 'US') resolvedMrktTp = null;

  const instRes = await pool.query(
    `INSERT INTO instruments (market, symbol, name, currency, country, mrkt_tp, is_active, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, CURRENT_TIMESTAMP)
     ON CONFLICT (market, symbol) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, instruments.name),
       currency = EXCLUDED.currency,
       country = EXCLUDED.country,
       mrkt_tp = COALESCE(EXCLUDED.mrkt_tp, instruments.mrkt_tp),
       is_active = true,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [mkt, sym, name, cur, ctry, resolvedMrktTp]
  );
  const instrument = instRes.rows[0];

  const venueRes = await pool.query(
    `INSERT INTO instrument_venues (instrument_id, exchange, broker_symbol, is_tradable, updated_at)
     VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)
     ON CONFLICT (instrument_id, exchange) DO UPDATE SET
       broker_symbol = COALESCE(EXCLUDED.broker_symbol, instrument_venues.broker_symbol),
       is_tradable = true,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [instrument.id, exch, brokerSymbol || sym]
  );

  return {
    instrument: mapInstrument(instrument),
    venue: mapVenue(venueRes.rows[0]),
  };
};

const defaultSplitStages = (config = {}) => {
  const maxStages = Math.min(10, Math.max(1, Number(config.maxStages) || 5));
  const defaultBuyTotal = toNum(config.defaultBuyTotal, 1000000);
  const buyDrop1 = toNum(config.buyDropPercent1, 2);
  const buyDropN = toNum(config.buyDropPercentN, 5);
  const sellProfit = toNum(config.sellProfitPercent, 5);
  const stages = [];
  for (let i = 1; i <= maxStages; i += 1) {
    stages.push({
      side: 'BUY',
      stage: i,
      percent: i === 1 ? buyDrop1 : buyDropN,
      targetPrice: null,
      targetAmount: defaultBuyTotal,
      targetQty: null,
      status: 'pending',
    });
    stages.push({
      side: 'SELL',
      stage: i,
      percent: sellProfit,
      targetPrice: null,
      targetAmount: null,
      targetQty: null,
      status: 'pending',
    });
  }
  return stages;
};

const createTradingPlan = async (userId, body = {}) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const strategyType = String(body.strategyType || 'SPLIT_TRADE').toUpperCase();
  if (!STRATEGY_TYPES.includes(strategyType)) {
    throw new Error(`지원하지 않는 strategyType: ${strategyType}`);
  }

  const brokerAccount = await ensureBrokerAccountForUser(uid);
  const { instrument, venue } = await upsertInstrument({
    market: body.market,
    symbol: body.symbol,
    name: body.name,
    currency: body.currency,
    country: body.country,
    exchange: body.exchange,
    brokerSymbol: body.brokerSymbol,
    userId: uid,
  });

  const strategyConfig = {
    buyTrailingPercent: 0.3,
    sellTrailingPercent: 0.3,
    maxStages: 5,
    ...(body.strategyConfig && typeof body.strategyConfig === 'object'
      ? body.strategyConfig
      : {}),
    // 표시용: trailing 동기화와 구분 (사용자 저장 시각)
    lastUserSaveAt:
      body.strategyConfig?.lastUserSaveAt != null
        ? Number(body.strategyConfig.lastUserSaveAt) || Date.now()
        : Date.now(),
  };

  const status = PLAN_STATUSES.includes(body.status) ? body.status : 'draft';

  if (status === 'active') {
    await assertCanActivateTradingV2(uid, { instrumentId: instrument.id });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const planRes = await client.query(
      `INSERT INTO trading_plans (
         user_id, broker_account_id, instrument_id, venue_id,
         strategy_type, status, strategy_config, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, instrument_id, venue_id, strategy_type) DO UPDATE SET
         broker_account_id = COALESCE(EXCLUDED.broker_account_id, trading_plans.broker_account_id),
         status = EXCLUDED.status,
         strategy_config = EXCLUDED.strategy_config,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        uid,
        brokerAccount?.id || null,
        instrument.id,
        venue.id,
        strategyType,
        status,
        JSON.stringify(strategyConfig),
      ]
    );
    const plan = planRes.rows[0];

    let cycleRow = (
      await client.query(
        `SELECT * FROM trading_cycles
         WHERE trading_id = $1 AND status = 'open'
         ORDER BY cycle_no DESC LIMIT 1`,
        [plan.id]
      )
    ).rows[0];

    if (!cycleRow) {
      const nextNoRes = await client.query(
        `SELECT COALESCE(MAX(cycle_no), 0) + 1 AS n FROM trading_cycles WHERE trading_id = $1`,
        [plan.id]
      );
      const cycleNo = Number(nextNoRes.rows[0].n) || 1;
      const cycleRes = await client.query(
        `INSERT INTO trading_cycles (trading_id, cycle_no, status, started_at, updated_at)
         VALUES ($1, $2, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING *`,
        [plan.id, cycleNo]
      );
      cycleRow = cycleRes.rows[0];
    }

    await client.query(
      `UPDATE trading_plans SET current_cycle_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [cycleRow.id, plan.id]
    );

    const stageInputs =
      Array.isArray(body.stages) && body.stages.length > 0
        ? body.stages
        : strategyType === 'SPLIT_TRADE'
          ? defaultSplitStages(strategyConfig)
          : [];

    if (stageInputs.length > 0) {
      await client.query(`DELETE FROM trading_stages WHERE cycle_id = $1`, [cycleRow.id]);
      for (const s of stageInputs) {
        const side = String(s.side || '').toUpperCase();
        if (side !== 'BUY' && side !== 'SELL') continue;
        const stageNo = parseInt(s.stage, 10);
        if (!Number.isInteger(stageNo) || stageNo < 1) continue;
        await client.query(
          `INSERT INTO trading_stages (
             cycle_id, side, stage, percent, target_price, target_amount, target_qty, status, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
          [
            cycleRow.id,
            side,
            stageNo,
            toNum(s.percent),
            toNum(s.targetPrice ?? s.target_price),
            toNum(s.targetAmount ?? s.target_amount),
            toNum(s.targetQty ?? s.target_qty),
            STAGE_STATUSES.includes(s.status) ? s.status : 'pending',
          ]
        );
      }
    }

    await client.query('COMMIT');
    // 조건/스테이지 upsert 후 이전 trailing 중지 (레거시 auto-trading 저장과 동일)
    stopPlanTrailingsOnSave(plan.id, { reason: '설정 변경으로 중단됨' });
    return getTradingPlanById(uid, plan.id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const listTradingPlans = async (userId, { status } = {}) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const params = [uid];
  let sql = `
    SELECT p.*,
           i.market AS i_market, i.symbol AS i_symbol, i.name AS i_name,
           i.currency AS i_currency, i.country AS i_country, i.is_active AS i_is_active,
           i.mrkt_tp AS i_mrkt_tp,
           v.exchange AS v_exchange, v.broker_symbol AS v_broker_symbol, v.is_tradable AS v_is_tradable
    FROM trading_plans p
    JOIN instruments i ON i.id = p.instrument_id
    LEFT JOIN instrument_venues v ON v.id = p.venue_id
    WHERE p.user_id = $1`;
  if (status) {
    params.push(status);
    sql += ` AND p.status = $${params.length}`;
  }
  sql += ' ORDER BY p.updated_at DESC';

  const result = await pool.query(sql, params);
  return result.rows.map((row) => ({
    ...mapPlan(row),
    instrument: mapInstrumentFromPlanRow(row),
    venue: row.venue_id
      ? mapVenue({
          id: row.venue_id,
          instrument_id: row.instrument_id,
          exchange: row.v_exchange,
          broker_symbol: row.v_broker_symbol,
          is_tradable: row.v_is_tradable,
        })
      : null,
  }));
};

const getTradingPlanById = async (userId, planId) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const id = Number(planId);
  if (!Number.isFinite(id)) throw new Error('유효하지 않은 planId');

  const planRes = await pool.query(
    `SELECT p.*,
            i.market AS i_market, i.symbol AS i_symbol, i.name AS i_name,
            i.currency AS i_currency, i.country AS i_country, i.is_active AS i_is_active,
            i.mrkt_tp AS i_mrkt_tp,
            v.exchange AS v_exchange, v.broker_symbol AS v_broker_symbol, v.is_tradable AS v_is_tradable
     FROM trading_plans p
     JOIN instruments i ON i.id = p.instrument_id
     LEFT JOIN instrument_venues v ON v.id = p.venue_id
     WHERE p.id = $1 AND p.user_id = $2`,
    [id, uid]
  );
  if (!planRes.rows[0]) return null;
  const row = planRes.rows[0];
  const plan = {
    ...mapPlan(row),
    instrument: mapInstrumentFromPlanRow(row),
    venue: row.venue_id
      ? mapVenue({
          id: row.venue_id,
          instrument_id: row.instrument_id,
          exchange: row.v_exchange,
          broker_symbol: row.v_broker_symbol,
          is_tradable: row.v_is_tradable,
        })
      : null,
  };

  const cyclesRes = await pool.query(
    `SELECT * FROM trading_cycles WHERE trading_id = $1 ORDER BY cycle_no ASC`,
    [id]
  );
  const cycles = cyclesRes.rows.map(mapCycle);

  const stagesRes = await pool.query(
    `SELECT s.* FROM trading_stages s
     JOIN trading_cycles c ON c.id = s.cycle_id
     WHERE c.trading_id = $1
     ORDER BY c.cycle_no ASC, s.side ASC, s.stage ASC`,
    [id]
  );
  let stages = stagesRes.rows.map(mapStage);

  const ordersRes = await pool.query(
    `SELECT * FROM trading_orders WHERE trading_id = $1 ORDER BY id ASC`,
    [id]
  );
  let orders = ordersRes.rows.map(mapOrder);

  const fillsRes = await pool.query(
    `SELECT f.* FROM trading_fills f
     JOIN trading_orders o ON o.id = f.order_id
     WHERE o.trading_id = $1
     ORDER BY f.id ASC`,
    [id]
  );
  const fills = fillsRes.rows.map(mapFill);

  if (String(plan.strategyType).toUpperCase() === 'SPLIT_TRADE' && plan.currentCycleId) {
    const client = await pool.connect();
    try {
      await syncSplitStageStatusesFromFills(client, id, Number(plan.currentCycleId));
      const stages2 = await client.query(
        `SELECT s.* FROM trading_stages s
         JOIN trading_cycles c ON c.id = s.cycle_id
         WHERE c.trading_id = $1
         ORDER BY c.cycle_no ASC, s.side ASC, s.stage ASC`,
        [id]
      );
      stages = stages2.rows.map(mapStage);
    } catch (err) {
      console.warn(`[TradingV2] plan=${id} 분할 차수 상태 동기화 실패:`, err.message);
    } finally {
      client.release();
    }
  }

  const result = { ...plan, cycles, stages, orders, fills };
  if (String(plan.strategyType).toUpperCase() === 'SPLIT_TRADE') {
    const { buildSplitLots } = require('./splitTradeLots');
    const { positions } = buildSplitLots(result, {
      cycleId: plan.currentCycleId != null ? Number(plan.currentCycleId) : null,
    });
    result.splitPositions = [...positions.values()]
      .filter((p) => p.stage != null && p.qty > 0)
      .map((p) => ({ stage: p.stage, qty: Math.floor(p.qty), avgPrice: p.avgPrice, at: p.at }))
      .sort((a, b) => a.stage - b.stage);
  }
  return result;
};

const updateTradingPlan = async (userId, planId, patch = {}) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const id = Number(planId);
  const existing = await getTradingPlanById(uid, id);
  if (!existing) return null;

  const nextStatus = PLAN_STATUSES.includes(patch.status) ? patch.status : existing.status;
  const patchCfg =
    patch.strategyConfig && typeof patch.strategyConfig === 'object'
      ? patch.strategyConfig
      : null;
  const nextConfig = patchCfg
    ? {
        ...existing.strategyConfig,
        ...patchCfg,
        // trailing만 온 경우 lastUserSaveAt 유지
        lastUserSaveAt:
          patchCfg.lastUserSaveAt != null
            ? Number(patchCfg.lastUserSaveAt) || existing.strategyConfig?.lastUserSaveAt
            : existing.strategyConfig?.lastUserSaveAt,
      }
    : existing.strategyConfig;

  if (nextStatus === 'active') {
    const instrumentId =
      existing.instrumentId ?? existing.instrument?.id ?? existing.instrument_id;
    await assertCanActivateTradingV2(uid, { instrumentId });
  }

  await pool.query(
    `UPDATE trading_plans
     SET status = $1, strategy_config = $2::jsonb, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND user_id = $4`,
    [nextStatus, JSON.stringify(nextConfig), id, uid]
  );

  const stagesPatched = Array.isArray(patch.stages);
  const configPatched = !!patchCfg;
  const deactivated = existing.status === 'active' && nextStatus !== 'active';
  // 레거시와 같이 조건·trailing%·스테이지 저장 시 armed trailing 무조건 중지
  if (stagesPatched || configPatched || deactivated) {
    stopPlanTrailingsOnSave(id, {
      reason: deactivated ? '플랜 중지·삭제' : '설정 변경으로 중단됨',
    });
  }

  if (stagesPatched && existing.currentCycleId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await syncStagesForCycle(client, existing.currentCycleId, patch.stages, {
        preserveProgress: true,
      });
      const rematched = await rematchOrphanOrdersToStages(
        client,
        id,
        existing.currentCycleId
      );
      if (rematched > 0) {
        console.log(`[TradingV2] plan=${id} orphan 주문 ${rematched}건 stage 재연결`);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return getTradingPlanById(uid, id);
};

/**
 * 분할 차수 동기화 — DELETE 재생성 금지 (stage_id → ON DELETE SET NULL 로 체결이 끊김)
 * UNIQUE(cycle_id, side, stage) UPSERT + filled/ordered 상태 유지
 */
const syncStagesForCycle = async (client, cycleId, stageInputs, { preserveProgress = true } = {}) => {
  const cid = Number(cycleId);
  const keepKeys = new Set();

  for (const s of stageInputs || []) {
    const side = String(s.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') continue;
    const stageNo = parseInt(s.stage, 10);
    if (!Number.isInteger(stageNo) || stageNo < 1) continue;
    keepKeys.add(`${side}:${stageNo}`);

    const existing = await client.query(
      `SELECT id, status FROM trading_stages
       WHERE cycle_id = $1 AND side = $2 AND stage = $3`,
      [cid, side, stageNo]
    );

    let status = STAGE_STATUSES.includes(s.status) ? s.status : 'pending';
    if (preserveProgress && existing.rows[0]) {
      const cur = String(existing.rows[0].status || '');
      // 가격/수량만 고칠 때 체결·주문중 상태를 pending으로 되돌리지 않음
      if (['filled', 'ordered'].includes(cur) && status === 'pending') {
        status = cur;
      }
    }

    await client.query(
      `INSERT INTO trading_stages (
         cycle_id, side, stage, percent, target_price, target_amount, target_qty, status, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
       ON CONFLICT (cycle_id, side, stage) DO UPDATE SET
         percent = EXCLUDED.percent,
         target_price = EXCLUDED.target_price,
         target_amount = EXCLUDED.target_amount,
         target_qty = EXCLUDED.target_qty,
         status = EXCLUDED.status,
         updated_at = CURRENT_TIMESTAMP`,
      [
        cid,
        side,
        stageNo,
        toNum(s.percent),
        toNum(s.targetPrice ?? s.target_price),
        toNum(s.targetAmount ?? s.target_amount),
        toNum(s.targetQty ?? s.target_qty),
        status,
      ]
    );
  }

  const all = await client.query(
    `SELECT id, side, stage, status FROM trading_stages WHERE cycle_id = $1`,
    [cid]
  );
  for (const row of all.rows) {
    const key = `${row.side}:${row.stage}`;
    if (keepKeys.has(key)) continue;
    if (preserveProgress && ['filled', 'ordered'].includes(String(row.status))) continue;
    await client.query(`DELETE FROM trading_stages WHERE id = $1`, [row.id]);
  }
};

/**
 * stage DELETE 후 stage_id=NULL 이 된 체결 주문을 재연결
 * - filled/partial 만 (미체결·취소 주문이 앞 슬롯을 차지해 1차 매도가 3차로 붙는 것 방지)
 * - 이미 체결이 붙은 차수는 건너뜀
 * - 남은 차수가 없으면 마지막 차수에 몰아넣지 않음
 */
const rematchOrphanOrdersToStages = async (client, tradingId, cycleId) => {
  const tid = Number(tradingId);
  const cid = Number(cycleId);
  if (!Number.isFinite(tid) || !Number.isFinite(cid)) return 0;

  let n = 0;
  for (const side of ['BUY', 'SELL']) {
    const orphans = await client.query(
      `SELECT id, status, requested_price, stage_no FROM trading_orders
       WHERE trading_id = $1
         AND (cycle_id = $2 OR cycle_id IS NULL)
         AND stage_id IS NULL
         AND UPPER(side) = $3
         AND status IN ('filled', 'partial')
       ORDER BY id ASC`,
      [tid, cid, side]
    );
    if (!orphans.rows.length) continue;

    const stages = await client.query(
      `SELECT id, stage, target_price FROM trading_stages
       WHERE cycle_id = $1 AND UPPER(side) = $2
       ORDER BY stage ASC`,
      [cid, side]
    );
    if (!stages.rows.length) continue;

    const taken = new Set();
    const occupied = await client.query(
      `SELECT stage_id FROM trading_orders
       WHERE trading_id = $1
         AND (cycle_id = $2 OR cycle_id IS NULL)
         AND UPPER(side) = $3
         AND stage_id IS NOT NULL
         AND status IN ('filled', 'partial')`,
      [tid, cid, side]
    );
    for (const row of occupied.rows) {
      if (row.stage_id != null) taken.add(Number(row.stage_id));
    }

    for (const orphan of orphans.rows) {
      // 저장된 stage_no 가 있으면 그 차수에만 연결 (차수 행은 재오픈 시 재사용되므로 점유 여부 무관).
      // 해당 차수 행이 없으면 다른 차수로 옮기지 않고 그대로 둔다 — 완료 거래의 차수가 바뀌면 안 됨.
      // stage_no 가 없을 때만 가장 낮은 미사용 차수. 가격 근접 매칭은 쓰지 않음.
      const snap = parseInt(orphan.stage_no, 10);
      let st = null;
      if (Number.isInteger(snap) && snap > 0) {
        st = stages.rows.find((s) => Number(s.stage) === snap);
        if (!st) continue;
      } else {
        st = stages.rows.find((s) => !taken.has(Number(s.id)));
        if (!st) continue;
      }

      const orderId = orphan.id;
      await client.query(
        `UPDATE trading_orders
         SET stage_id = $1,
             stage_no = COALESCE(stage_no, $2),
             cycle_id = COALESCE(cycle_id, $3),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [st.id, Number(st.stage), cid, orderId]
      );
      await client.query(
        `UPDATE trading_stages s
         SET status = CASE
           WHEN o.status = 'filled' THEN 'filled'
           WHEN o.status IN ('submitted', 'partial', 'pending') THEN 'ordered'
           ELSE s.status
         END,
         updated_at = CURRENT_TIMESTAMP
         FROM trading_orders o
         WHERE s.id = $1 AND o.id = $2
           AND s.status = 'pending'`,
        [st.id, orderId]
      );
      taken.add(Number(st.id));
      n += 1;
    }
  }

  await syncSplitStageStatusesFromFills(client, tid, cid);
  return n;
};

/**
 * 분할 차수 상태 = 체결 로트 잔량 기준 (차수 번호는 바꾸지 않음, 매도로 소진된 매수 제외)
 * - 매수 잔량 > 0 → BUY filled, SELL pending(매도 감시)
 * - 매수·매도 완료(잔량 0) → BUY/SELL pending(해당 차수 재매수)
 * - 매수 체결 없음 → BUY/SELL pending
 */
const syncSplitStageStatusesFromFills = async (client, tradingId, cycleId) => {
  const tid = Number(tradingId);
  const cid = Number(cycleId);
  if (!Number.isFinite(tid) || !Number.isFinite(cid)) return;

  const stages = await client.query(
    `SELECT * FROM trading_stages WHERE cycle_id = $1`,
    [cid]
  );
  const [ordRes, fillRes] = await Promise.all([
    client.query(
      `SELECT * FROM trading_orders
       WHERE trading_id = $1 AND (cycle_id = $2 OR cycle_id IS NULL)
       ORDER BY id ASC`,
      [tid, cid]
    ),
    client.query(
      `SELECT f.* FROM trading_fills f
       JOIN trading_orders o ON o.id = f.order_id
       WHERE o.trading_id = $1 AND (o.cycle_id = $2 OR o.cycle_id IS NULL)
       ORDER BY f.id ASC`,
      [tid, cid]
    ),
  ]);
  const { buildSplitLots } = require('./splitTradeLots');
  const { positions } = buildSplitLots(
    {
      orders: ordRes.rows.map(mapOrder),
      fills: fillRes.rows.map(mapFill),
      stages: stages.rows.map(mapStage),
    },
    { cycleId: null }
  );

  const openByStage = await client.query(
    `SELECT COALESCE(o.stage_no, st.stage) AS stage_no,
            UPPER(o.side) AS side
     FROM trading_orders o
     LEFT JOIN trading_stages st ON st.id = o.stage_id
     WHERE o.trading_id = $1
       AND (o.cycle_id = $2 OR o.cycle_id IS NULL)
       AND o.status IN ('submitted', 'pending', 'partial')
       AND COALESCE(o.stage_no, st.stage) IS NOT NULL`,
    [tid, cid]
  );
  const openSet = new Set(
    openByStage.rows.map((r) => `${r.side}:${Number(r.stage_no)}`)
  );

  for (const s of stages.rows) {
    const side = String(s.side).toUpperCase();
    const n = Number(s.stage);
    const rem = Math.floor(positions.get(n)?.qty || 0);
    let next = 'pending';
    if (side === 'BUY') {
      if (openSet.has(`BUY:${n}`)) next = 'ordered';
      else if (rem > 0) next = 'filled';
      else next = 'pending';
    } else {
      if (openSet.has(`SELL:${n}`)) next = 'ordered';
      else if (rem > 0) next = 'pending';
      else next = 'pending';
    }
    await client.query(
      `UPDATE trading_stages SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [next, s.id]
    );
  }
};

const deleteTradingPlan = async (userId, planId) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const id = Number(planId);

  try {
    const { stopV2BuyTrailingsByPlanId } = require('./autoTradingBuyTrailingStop');
    const { stopV2SellTrailingsByPlanId } = require('./autoTradingTrailingStop');
    stopV2BuyTrailingsByPlanId(id, { silent: true });
    stopV2SellTrailingsByPlanId(id, { silent: true });
  } catch (err) {
    console.warn(`[TradingV2] plan=${id} 삭제 전 trailing 중지 실패:`, err.message);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE trading_plans SET current_cycle_id = NULL WHERE id = $1 AND user_id = $2`,
      [id, uid]
    );
    const result = await client.query(
      `DELETE FROM trading_plans WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, uid]
    );
    await client.query('COMMIT');
    if (result.rowCount > 0) {
      try {
        require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
      } catch {
        /* ignore */
      }
    }
    return result.rowCount > 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * 관심종목 삭제용: 해당 종목 플랜에 주문(거래) 이력이 있으면 거부,
 * 없으면 trading_plans 삭제 (cycles/stages/orders/fills CASCADE).
 * instruments / instrument_venues / broker_accounts 는 유지.
 */
const deleteTradingPlansForInstrumentIfClean = async (userId, instrumentId) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const iid = Number(instrumentId);
  if (!Number.isFinite(iid) || iid < 1) {
    throw Object.assign(new Error('instrumentId가 필요합니다.'), { status: 400 });
  }

  const hist = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM trading_orders o
     JOIN trading_plans p ON p.id = o.trading_id
     WHERE p.user_id = $1 AND p.instrument_id = $2`,
    [uid, iid]
  );
  if ((hist.rows[0]?.cnt || 0) > 0) {
    const err = new Error(
      '매수/매도 거래 이력이 있어 관심종목을 삭제할 수 없습니다.'
    );
    err.status = 403;
    err.code = 'TRADING_HISTORY_EXISTS';
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const plansRes = await client.query(
      `SELECT id FROM trading_plans WHERE user_id = $1 AND instrument_id = $2`,
      [uid, iid]
    );
    const ids = plansRes.rows.map((r) => Number(r.id));
    if (ids.length > 0) {
      try {
        const { stopV2BuyTrailingsByPlanId } = require('./autoTradingBuyTrailingStop');
        const { stopV2SellTrailingsByPlanId } = require('./autoTradingTrailingStop');
        for (const pid of ids) {
          stopV2BuyTrailingsByPlanId(pid, { silent: true });
          stopV2SellTrailingsByPlanId(pid, { silent: true });
        }
      } catch {
        /* ignore */
      }
      await client.query(
        `UPDATE trading_plans SET current_cycle_id = NULL WHERE id = ANY($1::bigint[])`,
        [ids]
      );
      await client.query(`DELETE FROM trading_plans WHERE id = ANY($1::bigint[])`, [ids]);
    }
    await client.query('COMMIT');
    if (ids.length > 0) {
      try {
        require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
      } catch {
        /* ignore */
      }
    }
    return { deletedPlanIds: ids, deletedPlanCount: ids.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/** 플랜 잔량(전 사이클 합산) — 분할은 lot 매칭, 그 외는 체결 순수량 */
const planRemainingQty = (plan) => {
  if (String(plan?.strategyType) === 'SPLIT_TRADE') {
    const { buildSplitLots } = require('./splitTradeLots');
    let qty = 0;
    for (const pos of buildSplitLots(plan, { cycleId: null }).positions.values()) {
      qty += Number(pos?.qty) || 0;
    }
    return qty;
  }
  const { avgCostFromPlanFills } = require('./infiniteTradeBands');
  return Number(avgCostFromPlanFills(plan, { cycleId: null }).remQty) || 0;
};

/**
 * 관심종목 삭제 시 해당 종목 플랜 정리
 * - 주문 이력 없음 → 플랜 삭제
 * - 미체결 주문 또는 보유 잔량 있음 → 삭제 거부
 * - 전량 매도 완료 → 플랜·주문·체결 보존(매도완료 내역·통계), active 플랜만 paused 로 감시 중지
 */
const releaseTradingPlansForUnwatchedInstrument = async (userId, instrumentId) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const iid = Number(instrumentId);
  if (!Number.isFinite(iid) || iid < 1) {
    throw Object.assign(new Error('instrumentId가 필요합니다.'), { status: 400 });
  }

  const hist = await pool.query(
    `SELECT COUNT(*)::int AS cnt,
            COUNT(*) FILTER (WHERE o.status IN ('pending', 'submitted', 'partial'))::int AS open_cnt
     FROM trading_orders o
     JOIN trading_plans p ON p.id = o.trading_id
     WHERE p.user_id = $1 AND p.instrument_id = $2`,
    [uid, iid]
  );
  const { cnt = 0, open_cnt: openCnt = 0 } = hist.rows[0] || {};
  if (cnt === 0) {
    const out = await deleteTradingPlansForInstrumentIfClean(uid, iid);
    return { ...out, pausedPlanIds: [] };
  }
  if (openCnt > 0) {
    throw Object.assign(
      new Error('미체결 주문이 있어 관심종목을 삭제할 수 없습니다. 주문 정리 후 다시 시도해주세요.'),
      { status: 403, code: 'OPEN_ORDER_EXISTS' }
    );
  }

  const plansRes = await pool.query(
    `SELECT id FROM trading_plans WHERE user_id = $1 AND instrument_id = $2`,
    [uid, iid]
  );
  const ids = plansRes.rows.map((r) => Number(r.id));
  let remQty = 0;
  for (const id of ids) {
    const plan = await getTradingPlanById(uid, id);
    if (plan) remQty += planRemainingQty(plan);
  }
  if (remQty > 0) {
    throw Object.assign(
      new Error(`보유 중인 종목은 관심종목에서 삭제할 수 없습니다. (잔량 ${remQty}주)`),
      { status: 403, code: 'HOLDING_EXISTS' }
    );
  }

  try {
    const { stopV2BuyTrailingsByPlanId } = require('./autoTradingBuyTrailingStop');
    const { stopV2SellTrailingsByPlanId } = require('./autoTradingTrailingStop');
    for (const pid of ids) {
      stopV2BuyTrailingsByPlanId(pid, { silent: true });
      stopV2SellTrailingsByPlanId(pid, { silent: true });
    }
  } catch {
    /* ignore */
  }
  const paused = await pool.query(
    `UPDATE trading_plans SET status = 'paused', updated_at = CURRENT_TIMESTAMP
     WHERE id = ANY($1::bigint[]) AND status = 'active'
     RETURNING id`,
    [ids]
  );
  const pausedPlanIds = paused.rows.map((r) => Number(r.id));
  if (pausedPlanIds.length > 0) {
    try {
      require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
    } catch {
      /* ignore */
    }
  }
  return { deletedPlanIds: [], deletedPlanCount: 0, pausedPlanIds };
};

const openNewCycle = async (userId, planId) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const id = Number(planId);
  const plan = await getTradingPlanById(uid, id);
  if (!plan) throw new Error('플랜을 찾을 수 없습니다.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE trading_cycles
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE trading_id = $1 AND status = 'open'`,
      [id]
    );
    const nextNoRes = await client.query(
      `SELECT COALESCE(MAX(cycle_no), 0) + 1 AS n FROM trading_cycles WHERE trading_id = $1`,
      [id]
    );
    const cycleNo = Number(nextNoRes.rows[0].n) || 1;
    const cycleRes = await client.query(
      `INSERT INTO trading_cycles (trading_id, cycle_no, status, started_at, updated_at)
       VALUES ($1, $2, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [id, cycleNo]
    );
    await client.query(
      `UPDATE trading_plans SET current_cycle_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [cycleRes.rows[0].id, id]
    );
    await client.query('COMMIT');
    return getTradingPlanById(uid, id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const createTradingOrder = async (userId, planId, body = {}) => {
  await ensureTradingV2Tables();
  const plan = await getTradingPlanById(String(userId), planId);
  if (!plan) throw new Error('플랜을 찾을 수 없습니다.');

  const side = String(body.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new Error('side는 BUY 또는 SELL이어야 합니다.');

  let cycleId = body.cycleId != null ? Number(body.cycleId) : null;
  let stageNo = body.stageNo != null ? parseInt(body.stageNo, 10) : null;
  if (body.stageId != null) {
    const st = (plan.stages || []).find((s) => Number(s.id) === Number(body.stageId));
    if (st?.cycleId && cycleId == null) cycleId = Number(st.cycleId);
    if (st?.stage != null && !(Number.isInteger(stageNo) && stageNo > 0)) {
      stageNo = Number(st.stage);
    }
  }
  if (cycleId == null && plan.currentCycleId) cycleId = Number(plan.currentCycleId);
  if (!Number.isInteger(stageNo) || stageNo < 1) stageNo = null;

  const result = await pool.query(
    `INSERT INTO trading_orders (
       trading_id, cycle_id, stage_id, stage_no, broker_account_id, instrument_id, venue_id,
       side, order_type, requested_price, requested_qty, requested_amount,
       broker_order_no, status, order_reason, ordered_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     RETURNING *`,
    [
      plan.id,
      cycleId,
      body.stageId != null ? Number(body.stageId) : null,
      stageNo,
      plan.brokerAccountId,
      plan.instrumentId,
      plan.venueId,
      side,
      body.orderType || 'LIMIT',
      toNum(body.requestedPrice),
      toNum(body.requestedQty),
      toNum(body.requestedAmount),
      body.brokerOrderNo || null,
      ORDER_STATUSES.includes(body.status) ? body.status : 'pending',
      body.orderReason ? String(body.orderReason).toUpperCase().slice(0, 20) : null,
    ]
  );

  if (body.stageId && body.markStageOrdered) {
    await pool.query(
      `UPDATE trading_stages SET status = 'ordered', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'pending'`,
      [Number(body.stageId)]
    );
  }

  return mapOrder(result.rows[0]);
};

const createTradingFill = async (userId, planId, orderId, body = {}) => {
  await ensureTradingV2Tables();
  const plan = await getTradingPlanById(String(userId), planId);
  if (!plan) throw new Error('플랜을 찾을 수 없습니다.');

  const orderCheck = await pool.query(
    `SELECT * FROM trading_orders WHERE id = $1 AND trading_id = $2`,
    [Number(orderId), plan.id]
  );
  if (!orderCheck.rows[0]) throw new Error('주문을 찾을 수 없습니다.');

  const fillPrice = toNum(body.fillPrice);
  const fillQty = toNum(body.fillQty);
  if (fillPrice == null || fillQty == null) throw new Error('fillPrice, fillQty는 필수입니다.');

  // 동일 broker_fill_no 중복 INSERT 방지
  const brokerFillNo = body.brokerFillNo ? String(body.brokerFillNo).trim() : '';
  if (brokerFillNo) {
    const dup = await pool.query(
      `SELECT * FROM trading_fills WHERE order_id = $1 AND broker_fill_no = $2 LIMIT 1`,
      [Number(orderId), brokerFillNo]
    );
    if (dup.rows[0]) {
      return mapFill(dup.rows[0]);
    }
  }

  const fillAmount =
    toNum(body.fillAmount) != null ? toNum(body.fillAmount) : fillPrice * fillQty;

  const fillRes = await pool.query(
    `INSERT INTO trading_fills (
       order_id, fill_price, fill_qty, fill_amount, broker_fill_no, filled_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
     RETURNING *`,
    [
      Number(orderId),
      fillPrice,
      fillQty,
      fillAmount,
      brokerFillNo || null,
      body.filledAt || null,
    ]
  );

  const orderStatus =
    body.orderStatus && ORDER_STATUSES.includes(body.orderStatus)
      ? body.orderStatus
      : 'filled';
  await pool.query(
    `UPDATE trading_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [orderStatus, Number(orderId)]
  );

  // stage filled: 명시 true, 또는 완전체결(기본)이며 명시 false가 아닐 때
  const shouldMarkStage =
    body.markStageFilled === true ||
    (body.markStageFilled !== false && orderStatus === 'filled');
  if (orderCheck.rows[0].stage_id && shouldMarkStage) {
    await pool.query(
      `UPDATE trading_stages SET status = 'filled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [orderCheck.rows[0].stage_id]
    );
  }

  return mapFill(fillRes.rows[0]);
};

/** 주문에 적재된 체결수량 합 */
const sumFilledQtyForOrder = async (orderId) => {
  await ensureTradingV2Tables();
  const res = await pool.query(
    `SELECT COALESCE(SUM(fill_qty), 0) AS qty FROM trading_fills WHERE order_id = $1`,
    [Number(orderId)]
  );
  return Number(res.rows[0]?.qty) || 0;
};

/** 주문 상태만 갱신 (체결 없이 filled 확정 등) */
const updateTradingOrderStatus = async (orderId, status) => {
  if (!ORDER_STATUSES.includes(status)) return null;
  await ensureTradingV2Tables();
  const res = await pool.query(
    `UPDATE trading_orders SET status = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING *`,
    [status, Number(orderId)]
  );
  return res.rows[0] ? mapOrder(res.rows[0]) : null;
};

/** stage → filled */
const markTradingStageFilled = async (stageId) => {
  if (stageId == null) return;
  await ensureTradingV2Tables();
  await pool.query(
    `UPDATE trading_stages SET status = 'filled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [Number(stageId)]
  );
};

/**
 * 분할매매: N차 매도 체결 후 N차 매수·매도를 다시 pending
 * (레거시 buyEnd→N, buy_cur 감소와 동일 — 다시 N차 매수가 감시됨)
 */
const reopenSplitStageAfterSell = async (userId, planId, sellStageId, sellStageNo = null) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const plan = await getTradingPlanById(uid, planId);
  if (!plan || plan.strategyType !== 'SPLIT_TRADE') return null;

  const sellStage = (plan.stages || []).find((s) => Number(s.id) === Number(sellStageId));
  const cycleId =
    sellStage?.cycleId ||
    plan.currentCycleId ||
    null;
  if (!cycleId) return null;

  const { avgCostFromPlanFills } = require('./infiniteTradeBands');
  const { remQty } = avgCostFromPlanFills(plan, { cycleId, includeSubmitted: false });

  // 전량 매도면 매수완료로 남은 차수까지 pending (잘못된 stage_id로 3차만 재오픈되는 것 방지)
  if (!(remQty > 0)) {
    await pool.query(
      `UPDATE trading_stages
       SET status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE cycle_id = $1 AND status IN ('filled', 'ordered')`,
      [cycleId]
    );
    const stageNo = sellStage
      ? Number(sellStage.stage)
      : Number(sellStageNo) || 1;
    return { stageNo, cycleId, all: true };
  }

  let stageNo = sellStage ? Number(sellStage.stage) : NaN;
  if (!Number.isFinite(stageNo) && sellStageNo != null) {
    stageNo = Number(sellStageNo);
  }
  if (!Number.isFinite(stageNo)) return null;

  await pool.query(
    `UPDATE trading_stages
     SET status = 'pending', updated_at = CURRENT_TIMESTAMP
     WHERE cycle_id = $1 AND stage = $2 AND side IN ('BUY', 'SELL')`,
    [cycleId, stageNo]
  );

  // 매도 차수 표기가 매수 차수와 어긋나도 실제 소진된 로트 기준으로 전 차수 상태 재계산
  const client = await pool.connect();
  try {
    await syncSplitStageStatusesFromFills(client, planId, cycleId);
  } catch (err) {
    console.warn(`[TradingV2] plan=${planId} 매도후 차수 상태 동기화 실패:`, err.message);
  } finally {
    client.release();
  }

  return { stageNo, cycleId };
};

/**
 * 대시보드 주문번호 Status용 — 미체결 V2 주문 목록
 */
const listOpenTradingOrdersForUser = async (userId) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const result = await pool.query(
    `SELECT o.*, p.id AS plan_id,
            i.symbol AS i_symbol, i.market AS i_market, i.name AS i_name,
            v.exchange AS v_exchange,
            COALESCE(o.stage_no, s.stage) AS resolved_stage_no
     FROM trading_orders o
     JOIN trading_plans p ON p.id = o.trading_id
     JOIN instruments i ON i.id = o.instrument_id
     LEFT JOIN instrument_venues v ON v.id = o.venue_id
     LEFT JOIN trading_stages s ON s.id = o.stage_id
     WHERE p.user_id = $1
       AND o.broker_order_no IS NOT NULL
       AND TRIM(o.broker_order_no) <> ''
       AND o.status IN ('pending', 'submitted', 'partial')
     ORDER BY o.id DESC`,
    [uid]
  );
  return result.rows.map((row) => ({
    order: mapOrder(row),
    planId: Number(row.plan_id),
    symbol: row.i_symbol,
    market: row.i_market,
    name: row.i_name,
    exchange: row.v_exchange,
    stageNo:
      row.resolved_stage_no != null
        ? Number(row.resolved_stage_no)
        : row.stage_no != null
          ? Number(row.stage_no)
          : 1,
  }));
};

/**
 * broker_order_no 로 미체결/부분 주문 조회 (V2 WS 체결 매칭)
 */
const findTradingOrderByBrokerNo = async (userId, brokerOrderNo) => {
  await ensureTradingV2Tables();
  const uid = String(userId);
  const raw = String(brokerOrderNo || '').trim();
  if (!raw) return null;

  const result = await pool.query(
    `SELECT o.*, p.user_id, p.strategy_type, p.id AS plan_id,
            i.symbol AS i_symbol, i.market AS i_market, i.name AS i_name,
            v.exchange AS v_exchange
     FROM trading_orders o
     JOIN trading_plans p ON p.id = o.trading_id
     JOIN instruments i ON i.id = o.instrument_id
     LEFT JOIN instrument_venues v ON v.id = o.venue_id
     WHERE p.user_id = $1
       AND o.broker_order_no IS NOT NULL
       AND (
         o.broker_order_no = $2
         OR TRIM(LEADING '0' FROM o.broker_order_no) = TRIM(LEADING '0' FROM $2)
       )
       AND o.status IN ('pending', 'submitted', 'partial')
     ORDER BY o.id DESC
     LIMIT 1`,
    [uid, raw]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    order: mapOrder(row),
    planId: Number(row.plan_id),
    userId: row.user_id,
    strategyType: row.strategy_type,
    symbol: row.i_symbol,
    market: row.i_market,
    name: row.i_name,
    exchange: row.v_exchange,
  };
};

/** stock_list.mrkt_tp → instruments.mrkt_tp (국내 종목, 6자리 코드 기준) */
const applyMrktTpFromStockList = async () => {
  await ensureTradingV2Tables();
  try {
    const result = await pool.query(`
      UPDATE instruments i
      SET mrkt_tp = s.mrkt_tp, updated_at = CURRENT_TIMESTAMP
      FROM stock_list s
      WHERE UPPER(i.market) = 'KR'
        AND s.mrkt_tp IS NOT NULL
        AND s.mrkt_tp <> ''
        AND UPPER(LEFT(regexp_replace(TRIM(i.symbol), '(_NX|_AL)$', '', 'i'), 6))
          = UPPER(LEFT(regexp_replace(TRIM(s.stock_code), '(_NX|_AL)$', '', 'i'), 6))
        AND i.mrkt_tp IS DISTINCT FROM s.mrkt_tp
    `);
    return result.rowCount || 0;
  } catch (err) {
    console.error('[TradingV2] instruments mrkt_tp 동기화 실패:', err.message);
    return 0;
  }
};

/**
 * 대시보드 매도완료 — V2 SELL 주문(체결 합) 목록
 * @returns {Promise<Array<{userId, stockCode, stockName, stockMarket, buy_price, buy_qty, sell_price, sell_qty, sell_cur, createdAt, planId, strategyType, orderId, source}>>}
 */
const listCompletedSellsFromTradingV2 = async (userId) => {
  await ensureTradingV2Tables();
  const uid = String(userId);

  const sellRes = await pool.query(
    `SELECT o.id AS order_id,
            o.requested_qty,
            o.order_reason,
            o.stage_id,
            o.cycle_id,
            o.trading_id AS plan_id,
            p.strategy_type,
            i.symbol,
            i.name AS stock_name,
            i.market,
            COALESCE(o.stage_no, st.stage) AS stage_no,
            COALESCE(SUM(f.fill_qty), 0) AS fill_qty_sum,
            COALESCE(SUM(f.fill_amount), 0) AS fill_amt_sum,
            MAX(COALESCE(f.filled_at, f.created_at)) AS sold_at
     FROM trading_orders o
     JOIN trading_fills f ON f.order_id = o.id
     JOIN trading_plans p ON p.id = o.trading_id
     JOIN instruments i ON i.id = o.instrument_id
     LEFT JOIN trading_stages st ON st.id = o.stage_id
     WHERE p.user_id = $1
       AND UPPER(o.side) = 'SELL'
     GROUP BY o.id, o.requested_qty, o.order_reason, o.stage_id, o.cycle_id, o.trading_id,
              p.strategy_type, i.symbol, i.name, i.market, o.stage_no, st.stage
     ORDER BY sold_at DESC`,
    [uid]
  );

  const { normalizeAutoCode, isUsMarket } = require('./autoTradingMarket');
  const formatKoreaDateTimeFromDate = (date) => {
    const koreaTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const year = koreaTime.getFullYear();
    const month = String(koreaTime.getMonth() + 1).padStart(2, '0');
    const day = String(koreaTime.getDate()).padStart(2, '0');
    const hours = String(koreaTime.getHours()).padStart(2, '0');
    const minutes = String(koreaTime.getMinutes()).padStart(2, '0');
    const seconds = String(koreaTime.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  };
  const rows = [];

  // 분할: 매도 체결 시점까지의 매수 로트로 매수가 확정 (이후 매수·차수 재연결에 영향 없음)
  const { buildSplitLots } = require('./splitTradeLots');
  const splitSellsByPlan = new Map();
  const splitSellMatch = async (planId, orderId) => {
    if (!splitSellsByPlan.has(planId)) {
      const [ordRes, fillRes, stageRes] = await Promise.all([
        pool.query(`SELECT * FROM trading_orders WHERE trading_id = $1 ORDER BY id ASC`, [planId]),
        pool.query(
          `SELECT f.* FROM trading_fills f
           JOIN trading_orders o ON o.id = f.order_id
           WHERE o.trading_id = $1
           ORDER BY f.id ASC`,
          [planId]
        ),
        pool.query(
          `SELECT s.* FROM trading_stages s
           JOIN trading_cycles c ON c.id = s.cycle_id
           WHERE c.trading_id = $1`,
          [planId]
        ),
      ]);
      const lotPlan = {
        orders: ordRes.rows.map(mapOrder),
        fills: fillRes.rows.map(mapFill),
        stages: stageRes.rows.map(mapStage),
      };
      splitSellsByPlan.set(planId, buildSplitLots(lotPlan, { cycleId: null }).sells);
    }
    return splitSellsByPlan.get(planId).get(Number(orderId)) || null;
  };

  for (const row of sellRes.rows) {
    const fillQtySum = Math.floor(Number(row.fill_qty_sum) || 0);
    const requestedQty = Math.floor(Number(row.requested_qty) || 0);
    // 중복 체결 적재 시 합이 요청수량보다 커질 수 있음 → 요청수량으로 캡
    const sellQty =
      requestedQty > 0 ? Math.min(fillQtySum, requestedQty) : fillQtySum;
    if (!(sellQty > 0)) continue;

    const fillAmtSum = Number(row.fill_amt_sum) || 0;
    const sellPrice =
      fillQtySum > 0 ? fillAmtSum / fillQtySum : 0;
    if (!(sellPrice > 0)) continue;

    const planId = Number(row.plan_id);
    const cycleId = row.cycle_id != null ? Number(row.cycle_id) : null;
    const stageNo = row.stage_no != null ? Number(row.stage_no) : null;
    const strategyType = String(row.strategy_type || '').toUpperCase();

    // 매수가: 같은 플랜 BUY 체결 평단
    // stage/cycle 이 저장 후 NULL 이 되면 같은 차수 매칭이 실패하므로 단계적으로 완화
    const amtExpr = `COALESCE(NULLIF(f.fill_amount, 0), f.fill_price * f.fill_qty)`;
    const queryBuyAvg = async ({ cid, sn, orphanStageOk = false, anyStage = false }) => {
      const params = [planId];
      let sql = `
        SELECT COALESCE(SUM(f.fill_qty), 0) AS qty,
               COALESCE(SUM(${amtExpr}), 0) AS amt
        FROM trading_fills f
        JOIN trading_orders o ON o.id = f.order_id
        LEFT JOIN trading_stages st ON st.id = o.stage_id
        WHERE o.trading_id = $1
          AND UPPER(o.side) = 'BUY'`;
      if (cid != null) {
        params.push(cid);
        sql += ` AND (o.cycle_id = $${params.length} OR o.cycle_id IS NULL OR st.cycle_id = $${params.length})`;
      }
      if (!anyStage && sn != null && Number.isFinite(sn)) {
        params.push(sn);
        if (orphanStageOk) {
          sql += ` AND (COALESCE(o.stage_no, st.stage) = $${params.length}
                        OR COALESCE(o.stage_no, st.stage) IS NULL)`;
        } else {
          sql += ` AND COALESCE(o.stage_no, st.stage) = $${params.length}`;
        }
      }
      const buyRes = await pool.query(sql, params);
      const qty = Math.floor(Number(buyRes.rows[0]?.qty) || 0);
      const amt = Number(buyRes.rows[0]?.amt) || 0;
      const price = qty > 0 && amt > 0 ? amt / qty : 0;
      return { qty, price };
    };

    let buyPrice = 0;
    let buyQty = 0;
    if (strategyType === 'SPLIT_TRADE') {
      try {
        const m = await splitSellMatch(planId, row.order_id);
        if (m && m.matchedQty > 0 && m.cost > 0) {
          buyPrice = m.cost / m.matchedQty;
          buyQty = Math.floor(m.matchedQty);
        }
      } catch (err) {
        console.warn(`[TradingV2] plan=${planId} 매도 로트 매칭 실패:`, err.message);
      }
    }
    const buyAttempts = buyPrice > 0 ? [] : [
      { cid: cycleId, sn: strategyType === 'SPLIT_TRADE' ? stageNo : null, orphanStageOk: false, anyStage: strategyType !== 'SPLIT_TRADE' },
      { cid: cycleId, sn: strategyType === 'SPLIT_TRADE' ? stageNo : null, orphanStageOk: true, anyStage: false },
      { cid: cycleId, sn: null, anyStage: true },
      { cid: null, sn: null, anyStage: true },
    ];
    for (const attempt of buyAttempts) {
      try {
        const found = await queryBuyAvg(attempt);
        if (found.price > 0) {
          buyPrice = found.price;
          buyQty = found.qty;
          break;
        }
      } catch {
        /* 다음 완화 조건 */
      }
    }

    if (!(buyPrice > 0)) {
      try {
        const ordRes = await pool.query(
          `SELECT requested_price, requested_qty
           FROM trading_orders
           WHERE trading_id = $1
             AND UPPER(side) = 'BUY'
             AND status IN ('filled', 'partial')
             AND requested_price > 0
           ORDER BY id ASC
           LIMIT 1`,
          [planId]
        );
        const p = Number(ordRes.rows[0]?.requested_price) || 0;
        const q = Math.floor(Number(ordRes.rows[0]?.requested_qty) || 0);
        if (p > 0) {
          buyPrice = p;
          buyQty = q > 0 ? q : sellQty;
        }
      } catch {
        /* ignore */
      }
    }

    const market = String(row.market || '').toUpperCase();
    const symbol = String(row.symbol || '').trim();
    const stockMarket =
      market === 'US' || isUsMarket(market, symbol) ? 'US' : market === 'NXT' ? 'NXT' : 'KRX';
    const stockCode = normalizeAutoCode(symbol, stockMarket) || symbol;
    const soldAt = row.sold_at ? new Date(row.sold_at) : null;

    const sellCur = stageNo != null && stageNo > 0 ? stageNo : 1;

    rows.push({
      userId: uid,
      stockCode,
      stockName: row.stock_name || stockCode,
      stockMarket,
      buy_price: buyPrice > 0 ? buyPrice : null,
      buy_qty: buyQty > 0 ? buyQty : sellQty,
      sell_price: sellPrice,
      sell_qty: sellQty,
      orderReason: row.order_reason || null,
      sell_cur: sellCur,
      createdAt: soldAt ? formatKoreaDateTimeFromDate(soldAt) : null,
      planId,
      strategyType,
      orderId: Number(row.order_id),
      source: 'v2',
    });
  }

  return rows;
};

module.exports = {
  STRATEGY_TYPES,
  PLAN_STATUSES,
  STAGE_STATUSES,
  ORDER_STATUSES,
  ensureTradingV2Tables,
  ensureBrokerAccountForUser,
  upsertBrokerAccountCredentialsFromUser,
  upsertInstrument,
  applyMrktTpFromStockList,
  createTradingPlan,
  listTradingPlans,
  getTradingPlanById,
  updateTradingPlan,
  deleteTradingPlan,
  deleteTradingPlansForInstrumentIfClean,
  releaseTradingPlansForUnwatchedInstrument,
  openNewCycle,
  createTradingOrder,
  createTradingFill,
  sumFilledQtyForOrder,
  updateTradingOrderStatus,
  markTradingStageFilled,
  reopenSplitStageAfterSell,
  findTradingOrderByBrokerNo,
  listOpenTradingOrdersForUser,
  rematchOrphanOrdersToStages,
  listCompletedSellsFromTradingV2,
};

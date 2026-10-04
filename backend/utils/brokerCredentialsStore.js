/**
 * 키움 계좌·자격증명: broker_accounts + broker_account_credentials
 * (users.kiwoom_* 컬럼은 마이그레이션 후 제거)
 */
const pool = require('./db');

const KIWOOM_USER_COLUMNS = [
  'kiwoom_app_key',
  'kiwoom_app_secret',
  'kiwoom_access_token',
  'kiwoom_token_expires_at',
  'kiwoom_account_no',
];

let migratePromise = null;

const ensureBrokerTables = async () => {
  const { ensureTradingV2Tables } = require('./tradingV2Store');
  await ensureTradingV2Tables();
};

const DEFAULT_FEE_RATES = {
  buyFeeRate: 0.000125,
  sellFeeRate: 0.000125,
  sellTaxRate: 0.0018,
  usBuyFeeRate: 0,
  usSellFeeRate: 0,
  usSellTaxRate: 0,
};

const mapBundle = (row) => {
  if (!row) return null;
  return {
    brokerAccountId: Number(row.broker_account_id || row.id),
    accountNo: row.account_no || null,
    accountName: row.account_name || null,
    appKey: row.app_key_encrypted || null,
    appSecret: row.app_secret_encrypted || null,
    accessToken: row.access_token_encrypted || null,
    // TIMESTAMPTZ → 절대시각 ISO (Z)
    tokenExpiresAt: row.access_token_expires_at
      ? new Date(row.access_token_expires_at).toISOString()
      : null,
    buyFeeRate:
      row.buy_fee_rate != null ? Number(row.buy_fee_rate) : DEFAULT_FEE_RATES.buyFeeRate,
    sellFeeRate:
      row.sell_fee_rate != null ? Number(row.sell_fee_rate) : DEFAULT_FEE_RATES.sellFeeRate,
    sellTaxRate:
      row.sell_tax_rate != null ? Number(row.sell_tax_rate) : DEFAULT_FEE_RATES.sellTaxRate,
    usBuyFeeRate:
      row.us_buy_fee_rate != null ? Number(row.us_buy_fee_rate) : DEFAULT_FEE_RATES.usBuyFeeRate,
    usSellFeeRate:
      row.us_sell_fee_rate != null ? Number(row.us_sell_fee_rate) : DEFAULT_FEE_RATES.usSellFeeRate,
    usSellTaxRate:
      row.us_sell_tax_rate != null ? Number(row.us_sell_tax_rate) : DEFAULT_FEE_RATES.usSellTaxRate,
  };
};

/** 사용자 kiwoom 번들 조회 (계좌 + credentials) */
const getBrokerKiwoomBundle = async (userId) => {
  await ensureBrokerTables();
  const uid = String(userId);
  const result = await pool.query(
    `SELECT
       ba.id AS broker_account_id,
       ba.account_no,
       ba.account_name,
       ba.buy_fee_rate,
       ba.sell_fee_rate,
       ba.sell_tax_rate,
       ba.us_buy_fee_rate,
       ba.us_sell_fee_rate,
       ba.us_sell_tax_rate,
       c.app_key_encrypted,
       c.app_secret_encrypted,
       c.access_token_encrypted,
       c.access_token_expires_at
     FROM broker_accounts ba
     LEFT JOIN broker_account_credentials c ON c.broker_account_id = ba.id
     WHERE ba.user_id = $1 AND ba.broker = 'kiwoom'
     ORDER BY ba.is_active DESC, ba.id ASC
     LIMIT 1`,
    [uid]
  );
  return mapBundle(result.rows[0]);
};

/** 실현손익용 수수료·거래세율 (계좌 없으면 기본값) */
const getBrokerFeeRates = async (userId) => {
  const bundle = await getBrokerKiwoomBundle(userId);
  if (!bundle) return { ...DEFAULT_FEE_RATES };
  return {
    buyFeeRate: Number(bundle.buyFeeRate) || DEFAULT_FEE_RATES.buyFeeRate,
    sellFeeRate: Number(bundle.sellFeeRate) || DEFAULT_FEE_RATES.sellFeeRate,
    sellTaxRate: Number(bundle.sellTaxRate) || DEFAULT_FEE_RATES.sellTaxRate,
    usBuyFeeRate:
      bundle.usBuyFeeRate != null && Number.isFinite(Number(bundle.usBuyFeeRate))
        ? Number(bundle.usBuyFeeRate)
        : DEFAULT_FEE_RATES.usBuyFeeRate,
    usSellFeeRate:
      bundle.usSellFeeRate != null && Number.isFinite(Number(bundle.usSellFeeRate))
        ? Number(bundle.usSellFeeRate)
        : DEFAULT_FEE_RATES.usSellFeeRate,
    usSellTaxRate:
      bundle.usSellTaxRate != null && Number.isFinite(Number(bundle.usSellTaxRate))
        ? Number(bundle.usSellTaxRate)
        : DEFAULT_FEE_RATES.usSellTaxRate,
  };
};

/**
 * @param {string} userId
 * @param {{ buyFeeRate?: number, sellFeeRate?: number, sellTaxRate?: number,
 *           usBuyFeeRate?: number, usSellFeeRate?: number, usSellTaxRate?: number }} rates
 *   소수율 (예: 0.000125 = 0.0125%)
 */
const saveBrokerFeeRates = async (userId, rates = {}) => {
  await ensureBrokerTables();
  const account = await ensureAccountRow(userId);
  const current = await getBrokerFeeRates(userId);

  const toRate = (v, fallback) => {
    if (v == null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 0.1) {
      throw Object.assign(new Error('수수료/세금 비율이 올바르지 않습니다. (0 ~ 10%)'), {
        status: 400,
      });
    }
    return n;
  };

  const buyFeeRate = toRate(rates.buyFeeRate, current.buyFeeRate);
  const sellFeeRate = toRate(rates.sellFeeRate, current.sellFeeRate);
  const sellTaxRate = toRate(rates.sellTaxRate, current.sellTaxRate);
  const usBuyFeeRate = toRate(rates.usBuyFeeRate, current.usBuyFeeRate);
  const usSellFeeRate = toRate(rates.usSellFeeRate, current.usSellFeeRate);
  const usSellTaxRate = toRate(rates.usSellTaxRate, current.usSellTaxRate);

  await pool.query(
    `UPDATE broker_accounts SET
       buy_fee_rate = $2,
       sell_fee_rate = $3,
       sell_tax_rate = $4,
       us_buy_fee_rate = $5,
       us_sell_fee_rate = $6,
       us_sell_tax_rate = $7,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      account.id,
      buyFeeRate,
      sellFeeRate,
      sellTaxRate,
      usBuyFeeRate,
      usSellFeeRate,
      usSellTaxRate,
    ]
  );

  return {
    buyFeeRate,
    sellFeeRate,
    sellTaxRate,
    usBuyFeeRate,
    usSellFeeRate,
    usSellTaxRate,
  };
};

const ensureAccountRow = async (userId, { accountNo, accountName } = {}) => {
  const { ensureBrokerAccountForUser } = require('./tradingV2Store');
  return ensureBrokerAccountForUser(userId, { accountNo, accountName });
};

const upsertCredentials = async (
  brokerAccountId,
  { appKey, appSecret, accessToken, accessTokenExpiresAt, clearSecretIfNull = false }
) => {
  const existing = await pool.query(
    `SELECT * FROM broker_account_credentials WHERE broker_account_id = $1`,
    [brokerAccountId]
  );
  const prev = existing.rows[0];

  let nextSecret = appSecret;
  if (nextSecret === undefined) {
    nextSecret = prev?.app_secret_encrypted ?? null;
  } else if (nextSecret == null && !clearSecretIfNull) {
    nextSecret = prev?.app_secret_encrypted ?? null;
  }

  const nextKey = appKey !== undefined ? appKey : prev?.app_key_encrypted ?? null;
  const nextToken =
    accessToken !== undefined ? accessToken : prev?.access_token_encrypted ?? null;
  const nextExpires =
    accessTokenExpiresAt !== undefined
      ? accessTokenExpiresAt
      : prev?.access_token_expires_at ?? null;

  await pool.query(
    `INSERT INTO broker_account_credentials (
       broker_account_id,
       app_key_encrypted,
       app_secret_encrypted,
       access_token_encrypted,
       access_token_expires_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (broker_account_id) DO UPDATE SET
       app_key_encrypted = EXCLUDED.app_key_encrypted,
       app_secret_encrypted = EXCLUDED.app_secret_encrypted,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       updated_at = CURRENT_TIMESTAMP`,
    [brokerAccountId, nextKey, nextSecret, nextToken, nextExpires]
  );
};

const saveAccountNo = async (userId, accountNo) => {
  const { getUserById } = require('./userStore');
  const user = await getUserById(userId);
  const account = await ensureAccountRow(userId, {
    accountNo,
    accountName: user?.username || user?.email || null,
  });
  return account;
};

const saveAppCredentials = async (userId, { appKey, appSecret }) => {
  const account = await ensureAccountRow(userId);
  await upsertCredentials(account.id, {
    appKey,
    appSecret: appSecret !== undefined ? appSecret : undefined,
    accessToken: null,
    accessTokenExpiresAt: null,
  });
  return getBrokerKiwoomBundle(userId);
};

const saveAccessToken = async (userId, { accessToken, expiresAt }) => {
  const account = await ensureAccountRow(userId);
  // Date로 넘겨 TIMESTAMPTZ에 절대시각으로 저장 (ISO Z 문자열의 tz 유실 방지)
  let expiresDate = null;
  if (expiresAt != null && expiresAt !== '') {
    expiresDate = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(expiresDate.getTime())) expiresDate = null;
  }
  await upsertCredentials(account.id, {
    accessToken: accessToken ?? null,
    accessTokenExpiresAt: expiresDate,
  });
  return getBrokerKiwoomBundle(userId);
};

const clearAccessToken = async (userId) => {
  return saveAccessToken(userId, { accessToken: null, expiresAt: null });
};

const usersHasKiwoomColumns = async () => {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'users'
       AND column_name = 'kiwoom_app_key'
     LIMIT 1`
  );
  return result.rows.length > 0;
};

/** users.kiwoom_* → broker_* 이관 후 users 컬럼 DROP */
const migrateAndDropUsersKiwoomColumns = async () => {
  if (migratePromise) return migratePromise;
  migratePromise = (async () => {
    await ensureBrokerTables();
    if (!(await usersHasKiwoomColumns())) return { migrated: 0, dropped: false };

    const users = await pool.query(
      `SELECT id, username, email,
              kiwoom_app_key, kiwoom_app_secret,
              kiwoom_access_token, kiwoom_token_expires_at, kiwoom_account_no
       FROM users`
    );

    let migrated = 0;
    for (const u of users.rows) {
      const uid = String(u.id);
      const accountNo = u.kiwoom_account_no || null;
      const accountName = u.username || u.email || null;
      const account = await ensureAccountRow(uid, { accountNo, accountName });
      if (
        u.kiwoom_app_key ||
        u.kiwoom_app_secret ||
        u.kiwoom_access_token ||
        u.kiwoom_token_expires_at
      ) {
        await upsertCredentials(account.id, {
          appKey: u.kiwoom_app_key || null,
          appSecret: u.kiwoom_app_secret || null,
          accessToken: u.kiwoom_access_token || null,
          accessTokenExpiresAt: u.kiwoom_token_expires_at || null,
          clearSecretIfNull: true,
        });
      }
      migrated += 1;
    }

    for (const col of KIWOOM_USER_COLUMNS) {
      await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS ${col}`);
    }
    console.log(
      `[brokerCredentials] users.kiwoom_* → broker_* 이관 ${migrated}명, users 컬럼 삭제 완료`
    );
    return { migrated, dropped: true };
  })().catch((err) => {
    migratePromise = null;
    throw err;
  });
  return migratePromise;
};

module.exports = {
  DEFAULT_FEE_RATES,
  getBrokerKiwoomBundle,
  getBrokerFeeRates,
  saveBrokerFeeRates,
  saveAccountNo,
  saveAppCredentials,
  saveAccessToken,
  clearAccessToken,
  migrateAndDropUsersKiwoomColumns,
  usersHasKiwoomColumns,
};

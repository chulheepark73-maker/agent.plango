/**
 * 키움 계좌·자격증명: broker_accounts + broker_account_credentials
 *
 * 실전투자(live)와 모의투자(mock) 자격증명을 따로 저장하고,
 * broker_accounts.trading_mode 로 선택된 쪽을 번들의 appKey/accessToken/accountNo 로 돌려준다.
 */
const pool = require('./tradingDb');
const {
  TRADING_MODES,
  normalizeTradingMode,
  getTradingMode,
  setCachedTradingMode,
} = require('./kiwoomMode');

const MODE_COLUMNS = {
  live: {
    appKey: 'app_key_encrypted',
    appSecret: 'app_secret_encrypted',
    accessToken: 'access_token_encrypted',
    expiresAt: 'access_token_expires_at',
  },
  mock: {
    appKey: 'mock_app_key',
    appSecret: 'mock_app_secret',
    accessToken: 'mock_access_token',
    expiresAt: 'mock_access_token_expires_at',
  },
};

const assertMode = (mode) => {
  if (!TRADING_MODES.includes(mode)) {
    throw Object.assign(new Error(`지원하지 않는 투자 모드: ${mode}`), { status: 400 });
  }
  return mode;
};

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

const mapModeCredentials = (row, mode) => {
  const cols = MODE_COLUMNS[mode];
  const expires = row[cols.expiresAt];
  return {
    appKey: row[cols.appKey] || null,
    appSecret: row[cols.appSecret] || null,
    accessToken: row[cols.accessToken] || null,
    tokenExpiresAt: expires ? new Date(expires).toISOString() : null,
  };
};

const mapBundle = (row) => {
  if (!row) return null;
  const tradingMode = normalizeTradingMode(row.trading_mode);
  const live = mapModeCredentials(row, 'live');
  const mock = mapModeCredentials(row, 'mock');
  const active = tradingMode === 'mock' ? mock : live;
  return {
    brokerAccountId: Number(row.broker_account_id || row.id),
    accountName: row.account_name || null,
    tradingMode,
    accountNo: row.account_no || null,
    ...active,
    credentials: { live, mock },
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
       ba.trading_mode,
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
       c.access_token_expires_at,
       c.mock_app_key,
       c.mock_app_secret,
       c.mock_access_token,
       c.mock_access_token_expires_at
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

/** 지정 모드의 자격증명 컬럼만 갱신한다 (undefined 인 값은 기존 값 유지) */
const upsertCredentials = async (
  brokerAccountId,
  mode,
  { appKey, appSecret, accessToken, accessTokenExpiresAt }
) => {
  const cols = MODE_COLUMNS[assertMode(mode)];
  const existing = await pool.query(
    `SELECT * FROM broker_account_credentials WHERE broker_account_id = $1`,
    [brokerAccountId]
  );
  const prev = existing.rows[0];
  const pick = (value, col) => (value !== undefined ? value : prev?.[col] ?? null);

  const nextKey = pick(appKey, cols.appKey);
  const nextSecret = appSecret == null ? prev?.[cols.appSecret] ?? null : appSecret;
  const nextToken = pick(accessToken, cols.accessToken);
  const nextExpires = pick(accessTokenExpiresAt, cols.expiresAt);

  await pool.query(
    `INSERT INTO broker_account_credentials (
       broker_account_id, ${cols.appKey}, ${cols.appSecret}, ${cols.accessToken}, ${cols.expiresAt}, updated_at
     ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (broker_account_id) DO UPDATE SET
       ${cols.appKey} = EXCLUDED.${cols.appKey},
       ${cols.appSecret} = EXCLUDED.${cols.appSecret},
       ${cols.accessToken} = EXCLUDED.${cols.accessToken},
       ${cols.expiresAt} = EXCLUDED.${cols.expiresAt},
       updated_at = CURRENT_TIMESTAMP`,
    [brokerAccountId, nextKey, nextSecret, nextToken, nextExpires]
  );
};

const saveAccountNo = async (userId, accountNo) => {
  const { getUserById } = require('./userStore');
  const user = await getUserById(userId);
  const accountName = user?.username || user?.email || null;
  return ensureAccountRow(userId, { accountNo, accountName });
};

/** 키를 바꾸면 그 모드의 기존 토큰은 무효이므로 함께 지운다 */
const saveAppCredentials = async (userId, { appKey, appSecret, mode = getTradingMode() }) => {
  const account = await ensureAccountRow(userId);
  await upsertCredentials(account.id, mode, {
    appKey,
    appSecret,
    accessToken: null,
    accessTokenExpiresAt: null,
  });
  return getBrokerKiwoomBundle(userId);
};

/** 토큰은 기본적으로 현재 선택된 모드에 저장 (발급도 현재 모드 서버에서 받는다) */
const saveAccessToken = async (userId, { accessToken, expiresAt, mode = getTradingMode() }) => {
  const account = await ensureAccountRow(userId);
  let expiresDate = null;
  if (expiresAt != null && expiresAt !== '') {
    expiresDate = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(expiresDate.getTime())) expiresDate = null;
  }
  await upsertCredentials(account.id, mode, {
    accessToken: accessToken ?? null,
    accessTokenExpiresAt: expiresDate,
  });
  return getBrokerKiwoomBundle(userId);
};

const clearAccessToken = async (userId, mode = getTradingMode()) => {
  return saveAccessToken(userId, { accessToken: null, expiresAt: null, mode });
};

const setTradingMode = async (userId, mode) => {
  assertMode(mode);
  const account = await ensureAccountRow(userId);
  await pool.query(
    `UPDATE broker_accounts SET trading_mode = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [account.id, mode]
  );
  setCachedTradingMode(mode);
  return getBrokerKiwoomBundle(userId);
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
  setTradingMode,
};

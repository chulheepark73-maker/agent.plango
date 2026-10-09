const pool = require('./tradingDb');

const DEFAULT_GROUP_NAME = '제목없음';
const DEFAULT_THEME = 'dark';
const DEFAULT_PRICE_REFRESH_INTERVAL = 5;
const GROUP_NAME_COUNT = 8;
const DEFAULT_HOLDINGS_ROTATE_SEC = 10;
const HOLDINGS_ROTATE_SEC_MIN = 3;
const HOLDINGS_ROTATE_SEC_MAX = 600;

const isValidHoldingsRotateSec = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= HOLDINGS_ROTATE_SEC_MIN && n <= HOLDINGS_ROTATE_SEC_MAX;
};

const groupNameCol = (n) => `group_name${n}`;
const groupNameKey = (n) => `groupName${n}`;

/** 스키마는 db/trading_schema.sql 에서 생성된다 */
const ensureUserSettingsTable = async () => {};

const normalizeGroupName = (value) => {
  const v = String(value ?? '').trim();
  if (!v) return DEFAULT_GROUP_NAME;
  return v.length > 50 ? v.slice(0, 50) : v;
};

const normalizeTheme = (value) => {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'white' || v === 'light') return 'white';
  return DEFAULT_THEME; // dark
};

const normalizePriceRefreshInterval = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PRICE_REFRESH_INTERVAL;
  return Math.min(Math.round(n), 3600);
};

const mapRow = (row) => {
  const names = {};
  for (let n = 1; n <= GROUP_NAME_COUNT; n += 1) {
    names[groupNameKey(n)] = row[groupNameCol(n)] || DEFAULT_GROUP_NAME;
  }
  return {
    userId: row.user_id,
    theme: row.theme || DEFAULT_THEME,
    ...names,
    priceRefreshInterval:
      row.price_refresh_interval != null
        ? Number(row.price_refresh_interval)
        : DEFAULT_PRICE_REFRESH_INTERVAL,
    holdingsRotateSec: isValidHoldingsRotateSec(row.holdings_rotate_sec)
      ? Number(row.holdings_rotate_sec)
      : DEFAULT_HOLDINGS_ROTATE_SEC,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
  };
};

const getOrCreateUserSettings = async (userId) => {
  await ensureUserSettingsTable();
  const id = String(userId);

  const existing = await pool.query(
    'SELECT * FROM user_settings WHERE user_id = $1',
    [id]
  );
  if (existing.rows.length > 0) {
    return mapRow(existing.rows[0]);
  }

  const inserted = await pool.query(
    `INSERT INTO user_settings (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [id]
  );
  return mapRow(inserted.rows[0]);
};

const updateUserSettings = async (userId, patch = {}) => {
  await ensureUserSettingsTable();
  const id = String(userId);
  await getOrCreateUserSettings(id);

  const current = await pool.query(
    'SELECT * FROM user_settings WHERE user_id = $1',
    [id]
  );
  const row = current.rows[0];

  const theme =
    patch.theme !== undefined ? normalizeTheme(patch.theme) : row.theme;

  const groupNames = [];
  for (let n = 1; n <= GROUP_NAME_COUNT; n += 1) {
    const key = groupNameKey(n);
    const col = groupNameCol(n);
    groupNames.push(
      patch[key] !== undefined ? normalizeGroupName(patch[key]) : row[col]
    );
  }

  const priceRefreshInterval =
    patch.priceRefreshInterval !== undefined
      ? normalizePriceRefreshInterval(patch.priceRefreshInterval)
      : row.price_refresh_interval;

  const holdingsRotateSec =
    patch.holdingsRotateSec !== undefined && isValidHoldingsRotateSec(patch.holdingsRotateSec)
      ? Number(patch.holdingsRotateSec)
      : row.holdings_rotate_sec;

  const setClauses = [
    'theme = $2',
    ...Array.from({ length: GROUP_NAME_COUNT }, (_, i) => `${groupNameCol(i + 1)} = $${i + 3}`),
    `price_refresh_interval = $${GROUP_NAME_COUNT + 3}`,
    `holdings_rotate_sec = $${GROUP_NAME_COUNT + 4}`,
    'updated_at = CURRENT_TIMESTAMP',
  ];

  const result = await pool.query(
    `UPDATE user_settings SET
       ${setClauses.join(',\n       ')}
     WHERE user_id = $1
     RETURNING *`,
    [id, theme, ...groupNames, priceRefreshInterval, holdingsRotateSec]
  );

  return mapRow(result.rows[0]);
};

module.exports = {
  ensureUserSettingsTable,
  getOrCreateUserSettings,
  updateUserSettings,
  DEFAULT_GROUP_NAME,
  DEFAULT_THEME,
  DEFAULT_PRICE_REFRESH_INTERVAL,
  GROUP_NAME_COUNT,
  HOLDINGS_ROTATE_SEC_MIN,
  HOLDINGS_ROTATE_SEC_MAX,
  isValidHoldingsRotateSec,
};

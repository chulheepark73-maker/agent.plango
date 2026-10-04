const pool = require('./db');

const DEFAULT_GROUP_NAME = '제목없음';
const DEFAULT_THEME = 'dark';
const DEFAULT_PRICE_REFRESH_INTERVAL = 5;
const GROUP_NAME_COUNT = 8;

let tableEnsured = false;

const groupNameCol = (n) => `group_name${n}`;
const groupNameKey = (n) => `groupName${n}`;

const ensureUserSettingsTable = async () => {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id VARCHAR(50) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme VARCHAR(20) NOT NULL DEFAULT 'dark',
      group_name1 VARCHAR(50) NOT NULL DEFAULT '제목없음',
      group_name2 VARCHAR(50) NOT NULL DEFAULT '제목없음',
      group_name3 VARCHAR(50) NOT NULL DEFAULT '제목없음',
      group_name4 VARCHAR(50) NOT NULL DEFAULT '제목없음',
      group_name5 VARCHAR(50) NOT NULL DEFAULT '제목없음',
      group_name6 VARCHAR(50) NOT NULL DEFAULT '제목없음',
      group_name7 VARCHAR(50) NOT NULL DEFAULT '제목없음',
      group_name8 VARCHAR(50) NOT NULL DEFAULT '제목없음',
      price_refresh_interval INTEGER NOT NULL DEFAULT 5,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // 기존 DB(1~5만 있던 경우)에 6~8 컬럼 추가
  for (let n = 6; n <= GROUP_NAME_COUNT; n += 1) {
    await pool.query(
      `ALTER TABLE user_settings
       ADD COLUMN IF NOT EXISTS ${groupNameCol(n)} VARCHAR(50) NOT NULL DEFAULT '제목없음'`
    );
  }
  // 임시로 추가됐던 9·10 컬럼 제거
  await pool.query(
    `ALTER TABLE user_settings DROP COLUMN IF EXISTS group_name9`
  );
  await pool.query(
    `ALTER TABLE user_settings DROP COLUMN IF EXISTS group_name10`
  );
  tableEnsured = true;
};

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

  const setClauses = [
    'theme = $2',
    ...Array.from({ length: GROUP_NAME_COUNT }, (_, i) => `${groupNameCol(i + 1)} = $${i + 3}`),
    `price_refresh_interval = $${GROUP_NAME_COUNT + 3}`,
    'updated_at = CURRENT_TIMESTAMP',
  ];

  const result = await pool.query(
    `UPDATE user_settings SET
       ${setClauses.join(',\n       ')}
     WHERE user_id = $1
     RETURNING *`,
    [id, theme, ...groupNames, priceRefreshInterval]
  );

  return mapRow(result.rows[0]);
};

ensureUserSettingsTable().catch((error) => {
  console.error('[userSettingsStore] 테이블 보장 실패:', error.message);
});

const USERS_WATCH_LIST_COLS = [
  'watch_list_1',
  'watch_list_2',
  'watch_list_3',
  'watch_list_4',
  'watch_list_5',
  'us_watch_list_1',
  'us_watch_list_2',
  'us_watch_list_3',
  'us_watch_list_4',
  'us_watch_list_5',
];

let migrateWatchListPromise = null;

const usersHasWatchListColumns = async () => {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'users'
       AND column_name = 'watch_list_1'
     LIMIT 1`
  );
  return result.rows.length > 0;
};

/**
 * users.watch_list_* / us_watch_list_* → user_settings.group_name*
 * (KR watch_list_n 우선, group_name 이 기본값일 때만 덮어씀)
 * 이후 users 컬럼 DROP
 */
const migrateAndDropUsersWatchListColumns = async () => {
  if (migrateWatchListPromise) return migrateWatchListPromise;
  migrateWatchListPromise = (async () => {
    await ensureUserSettingsTable();
    if (!(await usersHasWatchListColumns())) {
      return { migrated: 0, dropped: false };
    }

    const users = await pool.query(
      `SELECT id,
              watch_list_1, watch_list_2, watch_list_3, watch_list_4, watch_list_5,
              us_watch_list_1, us_watch_list_2, us_watch_list_3, us_watch_list_4, us_watch_list_5
       FROM users`
    );

    let migrated = 0;
    for (const u of users.rows) {
      const uid = String(u.id);
      await getOrCreateUserSettings(uid);
      const current = await pool.query(
        'SELECT * FROM user_settings WHERE user_id = $1',
        [uid]
      );
      const row = current.rows[0];
      const patch = {};
      for (let n = 1; n <= 5; n += 1) {
        const key = groupNameKey(n);
        const existing = String(row[groupNameCol(n)] || '').trim();
        const fromKr = String(u[`watch_list_${n}`] || '').trim();
        const fromUs = String(u[`us_watch_list_${n}`] || '').trim();
        const candidate =
          fromKr && fromKr !== DEFAULT_GROUP_NAME
            ? fromKr
            : fromUs && fromUs !== DEFAULT_GROUP_NAME
              ? fromUs
              : '';
        if (
          candidate &&
          (!existing || existing === DEFAULT_GROUP_NAME)
        ) {
          patch[key] = candidate;
        }
      }
      if (Object.keys(patch).length > 0) {
        await updateUserSettings(uid, patch);
      }
      migrated += 1;
    }

    for (const col of USERS_WATCH_LIST_COLS) {
      await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS ${col}`);
    }
    console.log(
      `[userSettings] users.watch_list_* → group_name* 이관 ${migrated}명, users 컬럼 삭제 완료`
    );
    return { migrated, dropped: true };
  })().catch((err) => {
    migrateWatchListPromise = null;
    throw err;
  });
  return migrateWatchListPromise;
};

module.exports = {
  ensureUserSettingsTable,
  getOrCreateUserSettings,
  updateUserSettings,
  migrateAndDropUsersWatchListColumns,
  DEFAULT_GROUP_NAME,
  DEFAULT_THEME,
  DEFAULT_PRICE_REFRESH_INTERVAL,
  GROUP_NAME_COUNT,
};

const pool = require('./db');

/**
 * plan_status 스키마 보장
 * - kr_week / kr_month / kr_year
 * - us_week / us_month / us_year
 * 레거시 week/month/year → kr_* 로 이전 후 제거
 */
const ensurePlanStatusTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plan_status (
      user_id VARCHAR(50) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      kr_week BIGINT NOT NULL DEFAULT 0,
      kr_month BIGINT NOT NULL DEFAULT 0,
      kr_year BIGINT NOT NULL DEFAULT 0,
      us_week BIGINT NOT NULL DEFAULT 0,
      us_month BIGINT NOT NULL DEFAULT 0,
      us_year BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const cols = [
    'kr_week',
    'kr_month',
    'kr_year',
    'us_week',
    'us_month',
    'us_year',
  ];
  for (const col of cols) {
    await pool.query(`
      ALTER TABLE plan_status
      ADD COLUMN IF NOT EXISTS ${col} BIGINT NOT NULL DEFAULT 0
    `);
  }

  const { rows } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_status'
  `);
  const names = new Set(rows.map((r) => String(r.column_name)));

  if (names.has('week')) {
    await pool.query(`
      UPDATE plan_status
      SET kr_week = COALESCE(week, 0)
      WHERE COALESCE(kr_week, 0) = 0 AND COALESCE(week, 0) <> 0
    `);
    await pool.query(`ALTER TABLE plan_status DROP COLUMN IF EXISTS week`);
  }
  if (names.has('month')) {
    await pool.query(`
      UPDATE plan_status
      SET kr_month = COALESCE(month, 0)
      WHERE COALESCE(kr_month, 0) = 0 AND COALESCE(month, 0) <> 0
    `);
    await pool.query(`ALTER TABLE plan_status DROP COLUMN IF EXISTS month`);
  }
  if (names.has('year')) {
    await pool.query(`
      UPDATE plan_status
      SET kr_year = COALESCE(year, 0)
      WHERE COALESCE(kr_year, 0) = 0 AND COALESCE(year, 0) <> 0
    `);
    await pool.query(`ALTER TABLE plan_status DROP COLUMN IF EXISTS year`);
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_plan_status_updated_at
    ON plan_status(updated_at)
  `);
};

const getPlanStatusByUserId = async (userId) => {
  await ensurePlanStatusTable();
  const result = await pool.query(
    `
    SELECT kr_week, kr_month, kr_year, us_week, us_month, us_year, updated_at
    FROM plan_status
    WHERE user_id = $1
    `,
    [userId]
  );
  const row = result.rows[0] || {};
  return {
    krWeek: Number(row.kr_week || 0),
    krMonth: Number(row.kr_month || 0),
    krYear: Number(row.kr_year || 0),
    usWeek: Number(row.us_week || 0),
    usMonth: Number(row.us_month || 0),
    usYear: Number(row.us_year || 0),
    updatedAt: row.updated_at || null,
  };
};

module.exports = {
  ensurePlanStatusTable,
  getPlanStatusByUserId,
};

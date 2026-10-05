const pool = require('./tradingDb');

/** 스키마는 db/trading_schema.sql 에서 생성된다 */
const ensurePlanStatusTable = async () => {};

const getPlanStatusByUserId = async (userId) => {
  const result = await pool.query(
    `
    SELECT kr_week, kr_month, kr_year, us_week, us_month, us_year, updated_at
    FROM plan_status
    WHERE user_id = $1
    `,
    [String(userId)]
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

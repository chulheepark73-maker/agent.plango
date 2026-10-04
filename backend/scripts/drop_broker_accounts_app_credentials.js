const pool = require('../utils/db');

async function main() {
  await pool.query(`ALTER TABLE broker_accounts DROP COLUMN IF EXISTS app_key`);
  await pool.query(`ALTER TABLE broker_accounts DROP COLUMN IF EXISTS app_secret`);
  console.log('OK: dropped broker_accounts.app_key / app_secret');
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});

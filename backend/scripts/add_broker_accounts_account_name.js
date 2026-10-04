const pool = require('../utils/db');

async function main() {
  await pool.query(`
    ALTER TABLE broker_accounts
    ADD COLUMN IF NOT EXISTS account_name VARCHAR(100)
  `);
  console.log('OK: broker_accounts.account_name');
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});

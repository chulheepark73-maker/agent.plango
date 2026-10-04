/**
 * users.kiwoom_* → broker_accounts / broker_account_credentials 이관 후 users 컬럼 삭제
 *
 *   node scripts/migrate_users_kiwoom_to_broker.js
 */
const { migrateAndDropUsersKiwoomColumns } = require('../utils/brokerCredentialsStore');
const pool = require('../utils/db');

async function main() {
  const result = await migrateAndDropUsersKiwoomColumns();
  console.log('OK:', result);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

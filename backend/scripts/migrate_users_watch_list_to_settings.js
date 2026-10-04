/**
 * users.watch_list_* / us_watch_list_* → user_settings.group_name* 이관 후 DROP
 *   node scripts/migrate_users_watch_list_to_settings.js
 */
const {
  migrateAndDropUsersWatchListColumns,
} = require('../utils/userSettingsStore');
const pool = require('../utils/db');

async function main() {
  const result = await migrateAndDropUsersWatchListColumns();
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

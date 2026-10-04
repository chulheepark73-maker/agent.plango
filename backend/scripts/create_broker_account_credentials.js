const fs = require('fs');
const path = require('path');
const pool = require('../utils/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, 'create_broker_account_credentials.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('OK: broker_account_credentials');
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});

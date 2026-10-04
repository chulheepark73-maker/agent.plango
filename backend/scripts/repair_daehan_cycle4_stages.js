/**
 * 대한제당우(001795) plan=5 / cycle 4
 * — 47@2105 체결(order 8)이 5차로 붙은 것을 1차로 바로잡고
 * — fill 없는 1차 filled·5차 filled 허위 status 정리
 *
 * 사용: node scripts/repair_daehan_cycle4_stages.js
 * (서버 DB에서 실행)
 */
const pool = require('../utils/db');

const CYCLE_ID = 4;
const ORDER_ID = 8; // filled 2105×47, 잘못 stage 5에 연결됨
const STAGE1_BUY_ID = 281;
const STAGE5_BUY_ID = 289;

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ord = await client.query(
      `SELECT id, stage_id, stage_no, status, requested_price, requested_qty
       FROM trading_orders WHERE id = $1 AND cycle_id = $2 FOR UPDATE`,
      [ORDER_ID, CYCLE_ID]
    );
    if (!ord.rows[0]) {
      throw new Error(`order ${ORDER_ID} / cycle ${CYCLE_ID} 없음 — 서버 DB인지 확인`);
    }
    console.log('before order', ord.rows[0]);

    const fill = await client.query(
      `SELECT id, fill_price, fill_qty FROM trading_fills WHERE order_id = $1`,
      [ORDER_ID]
    );
    console.log('fills', fill.rows);

    await client.query(
      `UPDATE trading_orders
       SET stage_id = $1, stage_no = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [STAGE1_BUY_ID, ORDER_ID]
    );

    // BUY: 1차 filled, 2~5차 pending
    await client.query(
      `UPDATE trading_stages SET status = 'filled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [STAGE1_BUY_ID]
    );
    await client.query(
      `UPDATE trading_stages
       SET status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE cycle_id = $1 AND side = 'BUY' AND stage BETWEEN 2 AND 5`,
      [CYCLE_ID]
    );

    // SELL 전부 pending (매도 미체결)
    await client.query(
      `UPDATE trading_stages
       SET status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE cycle_id = $1 AND side = 'SELL'`,
      [CYCLE_ID]
    );

    const after = await client.query(
      `SELECT id, side, stage, status FROM trading_stages
       WHERE cycle_id = $1 ORDER BY side, stage`,
      [CYCLE_ID]
    );
    const afterOrd = await client.query(
      `SELECT id, stage_id, stage_no, status FROM trading_orders WHERE id = $1`,
      [ORDER_ID]
    );
    console.log('after order', afterOrd.rows[0]);
    console.log('after stages', after.rows);

    await client.query('COMMIT');
    console.log('OK — cycle 4 1차 체결로 정정 완료 (5차 pending)');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('FAIL', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();

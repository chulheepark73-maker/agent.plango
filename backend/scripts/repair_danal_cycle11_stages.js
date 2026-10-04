/**
 * 다날(064260) cycle 11 — 22@4380 체결을 2차→1차로 바로잡고 stage status 동기화
 *
 * 사용: node scripts/repair_danal_cycle11_stages.js
 * (서버 DB · DATABASE_URL 등 환경 확인 후 실행)
 */
const pool = require('../utils/db');

const CYCLE_ID = 11;
const ORDER_ID = 17; // filled 4380×22, 잘못 stage 2에 연결됨
const STAGE1_BUY_ID = 291;
const STAGE2_BUY_ID = 293;

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

    // 1차 매수 filled, 2차 매수 pending (체결 없음)
    await client.query(
      `UPDATE trading_stages SET status = 'filled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [STAGE1_BUY_ID]
    );
    await client.query(
      `UPDATE trading_stages SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [STAGE2_BUY_ID]
    );

    // 동일 차수 SELL: 1차는 매도 감시 가능(pending), 2차는 pending 유지
    await client.query(
      `UPDATE trading_stages
       SET status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE cycle_id = $1 AND side = 'SELL' AND stage IN (1, 2)`,
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
    console.log('OK — cycle 11 1차 체결로 정정 완료');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('FAIL', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();

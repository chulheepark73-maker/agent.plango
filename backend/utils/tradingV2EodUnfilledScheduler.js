/**
 * Trading V2 — 미체결 주문 취소 + stage pending 복구
 * - 국내 정규장 종료: 평일 15:30 KST (취소·원복 후 감시 계속, NXT/시간외종가에서도 조건 충족 시 재주문)
 * - 국내 애프터 종료: 평일 20:05 KST
 * - 국내 장전: 평일 07:58 KST (전날 취소 실패로 남은 주문 정리 — 당일 주문은 만료됐으므로 DB만 정리)
 * - 미국 애프터 종료: 평일 NY 20:10 (당일 주문 만료 → 체결 반영 후 DB 정리)
 *
 * 취소 요청이 실패하면 DB 를 그대로 둔다 (키움에 살아 있는 주문을 cancelled 로 두면 체결이 누락되고 차수가 다시 열려 이중 주문).
 */

const cron = require('node-cron');
const pool = require('./tradingDb');
const { getAllUsers } = require('./userStore');
const { getKiwoomInfo } = require('./kiwoomUtils');
const {
  ensureTradingV2Tables,
  sumFilledQtyForOrder,
  markTradingStageFilled,
} = require('./tradingV2Store');
const { normalizeAutoCode } = require('./autoTradingMarket');
const { aggregateRestExecutions } = require('./orderExecutionPrice');
const { applyTradingV2RestFill, closeInfiniteCycleIfDone } = require('./tradingV2Fill');
const { getKoreaDateString } = require('./stockUtils');

const LOG = '[TradingV2-EOD미체결]';

/**
 * @param {string|number} userId
 * @param {'KR'|'US'} [region]
 */
const listOpenOrders = async (userId, region = 'KR') => {
  await ensureTradingV2Tables();
  const marketCond =
    region === 'US'
      ? `UPPER(COALESCE(i.market, 'KR')) = 'US'`
      : `UPPER(COALESCE(i.market, 'KR')) <> 'US'`;
  const result = await pool.query(
    `SELECT o.id, o.trading_id, o.stage_id, o.side, o.broker_order_no,
            o.requested_qty, o.requested_price, o.status, o.ordered_at, o.created_at,
            i.symbol, i.market, i.name,
            v.exchange,
            p.strategy_type
     FROM trading_orders o
     JOIN trading_plans p ON p.id = o.trading_id
     JOIN instruments i ON i.id = o.instrument_id
     LEFT JOIN instrument_venues v ON v.id = o.venue_id
     WHERE p.user_id = $1
       AND o.status IN ('pending', 'submitted', 'partial')
       AND o.broker_order_no IS NOT NULL
       AND ${marketCond}`,
    [String(userId)]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    planId: Number(row.trading_id),
    stageId: row.stage_id != null ? Number(row.stage_id) : null,
    side: row.side,
    brokerOrderNo: row.broker_order_no,
    qty: Number(row.requested_qty) || 0,
    price: Number(row.requested_price) || 0,
    status: row.status,
    symbol: row.symbol,
    market: row.market,
    name: row.name,
    exchange: row.exchange,
    strategyType: row.strategy_type,
    orderedAt: row.ordered_at || row.created_at || null,
  }));
};

const listKrOpenOrders = (userId) => listOpenOrders(userId, 'KR');

/** 오늘(KST) 이전에 낸 국내 주문 — 키움 당일 주문은 이미 만료됨 */
const isPreviousDayKrOrder = (order) => {
  if (!order.orderedAt) return false;
  const d = order.orderedAt instanceof Date ? order.orderedAt : new Date(order.orderedAt);
  if (Number.isNaN(d.getTime())) return false;
  return getKoreaDateString(d) < getKoreaDateString();
};

/** DB 를 정리한 무한매매 플랜 — 익절 후 남은 주문 때문에 보류한 새 cycle 을 연다 */
const closeInfiniteCyclesForPlans = async (userId, planIds, logs) => {
  for (const planId of planIds) {
    const opened = await closeInfiniteCycleIfDone(userId, planId);
    if (opened) logs.push(`[cycle] plan=${planId} 남은 주문 정리 후 새 cycle 시작`);
  }
};

/**
 * @param {object} order
 * @param {number} [filledQty] 취소 시점까지 체결된 수량
 * - BUY 일부체결: 체결분을 보유로 보고 차수 filled (매도 감시는 체결수량 기준)
 * - SELL 일부체결: 남은 보유분을 다시 팔아야 하므로 pending 원복
 */
const markOrderCancelledAndReopenStage = async (order, filledQty = 0) => {
  const ordRes = await pool.query(
    `UPDATE trading_orders
     SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status IN ('pending', 'submitted', 'partial')
     RETURNING id, stage_id`,
    [order.id]
  );

  const stageId =
    ordRes.rows[0]?.stage_id != null
      ? Number(ordRes.rows[0].stage_id)
      : order.stageId != null
        ? Number(order.stageId)
        : null;

  if (stageId && filledQty > 0 && String(order.side).toUpperCase() === 'BUY') {
    await markTradingStageFilled(stageId);
    return {
      orderCancelled: (ordRes.rowCount || 0) > 0,
      stageReopened: false,
      stageFilled: true,
      stageId,
    };
  }

  if (stageId) {
    const stRes = await pool.query(
      `UPDATE trading_stages
       SET status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status IN ('ordered', 'pending')
       RETURNING id, stage, side`,
      [stageId]
    );
    return {
      orderCancelled: (ordRes.rowCount || 0) > 0,
      stageReopened: (stRes.rowCount || 0) > 0,
      stageId,
    };
  }
  return {
    orderCancelled: (ordRes.rowCount || 0) > 0,
    stageReopened: false,
    stageId: null,
  };
};

/**
 * 미체결 주문이 없는데 status='ordered' 로 남은 분할 차수 → pending 원복
 * (EOD 취소 누락·API 실패 후에도 다음날 앞 차수가 막히지 않게)
 */
const reopenOrphanOrderedStages = async (userId) => {
  const uid = String(userId);
  const res = await pool.query(
    `SELECT s.id, s.side, s.stage, c.trading_id AS plan_id
     FROM trading_stages s
     JOIN trading_cycles c ON c.id = s.cycle_id
     JOIN trading_plans p ON p.id = c.trading_id
     WHERE p.user_id = $1
       AND UPPER(COALESCE(p.strategy_type, '')) = 'SPLIT_TRADE'
       AND s.status = 'ordered'
       AND NOT EXISTS (
         SELECT 1 FROM trading_orders o
         WHERE o.stage_id = s.id
           AND o.status IN ('pending', 'submitted', 'partial')
       )`,
    [uid]
  );
  if (!res.rows.length) return [];
  await pool.query(
    `UPDATE trading_stages
     SET status = 'pending', updated_at = CURRENT_TIMESTAMP
     WHERE id = ANY($1) AND status = 'ordered'`,
    [res.rows.map((row) => Number(row.id))]
  );
  return res.rows.map((row) => ({
    stageId: Number(row.id),
    side: row.side,
    stage: Number(row.stage),
    planId: Number(row.plan_id),
  }));
};

const resolveVenue = (order) => {
  const ex = String(order.exchange || '').toUpperCase();
  if (ex === 'NXT') return 'NXT';
  return 'KRX';
};

/**
 * 단일 사용자 — 국내 V2 미체결 취소
 * @param {string|number} userId
 * @param {{ skipRefresh?: boolean }} [opts]
 */
const runEodUnfilledTradingV2ForUser = async (userId, opts = {}) => {
  const uid = String(userId);
  let kiwoomInfo;
  try {
    kiwoomInfo = await getKiwoomInfo(uid);
  } catch {
    return { skipped: true, reason: 'no_kiwoom' };
  }
  if (!kiwoomInfo?.accessToken) return { skipped: true, reason: 'no_token' };

  const orders = await listKrOpenOrders(uid);
  const logs = [];
  let cancelled = 0;
  let dbOnly = 0;
  let failed = 0;
  const infinitePlanIds = new Set();

  const kiwoomAPI = require('../services/kiwoomApi');

  /** kt00009 체결내역을 DB에 반영하고 현재 체결수량 반환 (WS 누락분 보정) */
  const syncFilledQty = async (order, code, venue) => {
    try {
      const res = await kiwoomAPI.checkOrderExecution(
        kiwoomInfo.accessToken,
        kiwoomInfo.appKey,
        kiwoomInfo.appSecret,
        kiwoomInfo.accountNo,
        order.brokerOrderNo,
        venue
      );
      const fill = res?.isExecuted
        ? aggregateRestExecutions(res.acnt_ord_cntr_prst_array, order.price)
        : null;
      if (fill?.execQty > 0) {
        await applyTradingV2RestFill({
          userId: uid,
          orderNo: order.brokerOrderNo,
          restExecQty: fill.execQty,
          restExecPrice: fill.execPrice,
        });
      }
    } catch (err) {
      logs.push(`[${code}] 체결조회 실패 ord=${order.brokerOrderNo}: ${err.message}`);
    }
    return Number(await sumFilledQtyForOrder(order.id)) || 0;
  };

  const requestCancel = async (order, code, venue, qty) => {
    try {
      const result = await kiwoomAPI.cancelOrder(
        { symbol: code, orderNo: order.brokerOrderNo, quantity: qty },
        kiwoomInfo.accessToken,
        kiwoomInfo.appKey,
        kiwoomInfo.appSecret,
        kiwoomInfo.accountNo,
        venue
      );
      const rc = result?.return_code;
      return { ok: rc === undefined || rc === 0 || rc === '0', rc, errCode: null, msg: '' };
    } catch (err) {
      const msg = String(err?.message || err?.data?.return_msg || '');
      const errCode = (msg.match(/RC(\d{4})/) || [])[1] || null;
      return { ok: false, rc: null, errCode, msg };
    }
  };

  for (const order of orders) {
    const code = normalizeAutoCode(order.symbol, 'KRX');
    const venue = resolveVenue(order);
    const requested = Number(order.qty) || 0;
    let cancelOk = false;
    let filled = 0;

    if (order.brokerOrderNo) {
      filled = await syncFilledQty(order, code, venue);
      if (requested > 0 && filled >= requested) {
        logs.push(
          `[${code}] ${order.side} 전량 체결 확인(${filled}/${requested}) → 취소 생략 ord=${order.brokerOrderNo}`
        );
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }

      let out = await requestCancel(order, code, venue, Math.max(0, requested - filled));
      let alreadyClosed = false;
      // 4033: 취소할 수량 없음(이미 체결/취소) / 4043: 잔량보다 많이 취소 → 체결분 다시 확인
      if (!out.ok && (out.errCode === '4033' || out.errCode === '4043')) {
        filled = await syncFilledQty(order, code, venue);
        if (requested > 0 && filled >= requested) {
          logs.push(
            `[${code}] ${order.side} RC${out.errCode} → 전량 체결 확인(${filled}/${requested}) ord=${order.brokerOrderNo}`
          );
          await new Promise((r) => setTimeout(r, 120));
          continue;
        }
        if (out.errCode === '4043') {
          out = await requestCancel(order, code, venue, Math.max(0, requested - filled));
        }
        // 4033 = 키움에 남은 수량 없음 (이미 취소·만료) → 체결 반영은 끝났으므로 DB 정리 대상
        if (!out.ok && out.errCode === '4033') alreadyClosed = true;
      }
      cancelOk = out.ok || alreadyClosed;
      logs.push(
        `[${code}] ${order.side} 취소 ${out.ok ? '완료' : `실패 ${out.msg}`} ord=${order.brokerOrderNo} ` +
          `체결=${filled}/${requested} plan=${order.planId} stage=${order.stageId ?? '-'} ${order.strategyType || ''}`
      );
    } else {
      logs.push(
        `[${code}] ${order.side} broker_order_no 없음 → DB만 정리 order=${order.id} plan=${order.planId}`
      );
    }

    // 취소 실패 — 오늘 주문이면 키움에 살아 있을 수 있으므로 DB 를 그대로 두고 다음 정리 때 다시 시도.
    // 전날 이전 주문은 키움에서 이미 만료됐으므로 DB 만 정리한다.
    if (order.brokerOrderNo && !cancelOk) {
      if (!isPreviousDayKrOrder(order)) {
        failed += 1;
        logs.push(
          `[${code}] ${order.side} 취소 실패 → DB 미체결 유지(다음 정리 때 재시도) ord=${order.brokerOrderNo} plan=${order.planId}`
        );
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      logs.push(`[${code}] ${order.side} 전날 주문(만료) → DB만 정리 ord=${order.brokerOrderNo}`);
    }

    try {
      const dbOut = await markOrderCancelledAndReopenStage(order, filled);
      if (String(order.strategyType).toUpperCase() === 'INFINITE_TRADE') infinitePlanIds.add(order.planId);
      try {
        require('./tradingV2FillRestBackup').stopTradingV2FillWatch(uid, order.brokerOrderNo);
      } catch {
        /* ignore */
      }
      if (dbOut.stageFilled) {
        logs.push(
          `[${code}] 일부 체결(${filled}/${requested}) → stage filled 유지 stageId=${dbOut.stageId} order=${order.id}`
        );
      }
      if (dbOut.stageReopened) {
        logs.push(
          `[${code}] stage pending 원복 stageId=${dbOut.stageId} order=${order.id}`
        );
      }
      if (cancelOk) cancelled += 1;
      else dbOnly += 1;
    } catch (err) {
      logs.push(`[${code}] DB cancelled 실패 order=${order.id}: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 120));
  }

  try {
    await closeInfiniteCyclesForPlans(uid, infinitePlanIds, logs);
  } catch (err) {
    logs.push(`[cycle] 새 cycle 확인 실패: ${err.message}`);
  }

  // 미체결이 없는데 ordered 로 남은 분할 차수 원복 (EOD 누락 보험)
  let orphanReopened = [];
  try {
    orphanReopened = await reopenOrphanOrderedStages(uid);
    for (const row of orphanReopened) {
      logs.push(
        `[orphan] plan=${row.planId} ${row.side} ${row.stage}차 ordered→pending stageId=${row.stageId}`
      );
    }
  } catch (err) {
    logs.push(`[orphan] ordered 원복 실패: ${err.message}`);
  }

  if (!opts.skipRefresh) {
    try {
      require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
    } catch {
      /* ignore */
    }
  }

  return {
    skipped: false,
    cancelled,
    dbOnly,
    failed,
    total: orders.length,
    orphanReopened: orphanReopened.length,
    logs,
  };
};

/**
 * 단일 사용자 — 미국 V2 미체결 정리 (NY 애프터 종료 후)
 * 키움 미국 주문은 당일 주문이라 세션이 끝나면 만료된다. 마지막으로 체결을 반영하고 남은 수량은 취소로 정리.
 * @param {string|number} userId
 */
const runUsEodUnfilledTradingV2ForUser = async (userId) => {
  const uid = String(userId);
  let kiwoomInfo;
  try {
    kiwoomInfo = await getKiwoomInfo(uid);
  } catch {
    return { skipped: true, reason: 'no_kiwoom' };
  }
  if (!kiwoomInfo?.accessToken) return { skipped: true, reason: 'no_token' };

  const orders = await listOpenOrders(uid, 'US');
  const logs = [];
  let closed = 0;
  const infinitePlanIds = new Set();
  if (!orders.length) return { skipped: false, total: 0, closed, logs };

  const kiwoomAPI = require('../services/kiwoomApi');
  const { aggregateUsExecutions, stopTradingV2FillWatch } = require('./tradingV2FillRestBackup');

  let rows = null;
  try {
    const res = await kiwoomAPI.getUsOrderExecutions(kiwoomInfo.accessToken, {
      slbyTp: '0',
      stexTp: '',
      stkCd: '',
    });
    rows = res?.rows || [];
  } catch (err) {
    logs.push(`US 체결조회 실패 — 체결 반영 없이 정리: ${err.message}`);
  }

  for (const order of orders) {
    const code = String(order.symbol || '').toUpperCase();
    const requested = Number(order.qty) || 0;
    try {
      if (rows) {
        const { fill } = aggregateUsExecutions(rows, order.brokerOrderNo);
        if (fill?.execQty > 0) {
          await applyTradingV2RestFill({
            userId: uid,
            orderNo: order.brokerOrderNo,
            restExecQty: fill.execQty,
            restExecPrice: fill.execPrice,
          });
        }
      }
      const filled = Number(await sumFilledQtyForOrder(order.id)) || 0;
      if (requested > 0 && filled >= requested) {
        logs.push(`[${code}] ${order.side} 전량 체결 확인(${filled}/${requested}) ord=${order.brokerOrderNo}`);
        continue;
      }
      const dbOut = await markOrderCancelledAndReopenStage(order, filled);
      stopTradingV2FillWatch(uid, order.brokerOrderNo);
      if (String(order.strategyType).toUpperCase() === 'INFINITE_TRADE') infinitePlanIds.add(order.planId);
      closed += 1;
      logs.push(
        `[${code}] ${order.side} 세션 종료 → 만료 정리 체결=${filled}/${requested} ord=${order.brokerOrderNo} ` +
          `plan=${order.planId}${dbOut.stageReopened ? ' stage pending 원복' : ''}${dbOut.stageFilled ? ' stage filled 유지' : ''}`
      );
    } catch (err) {
      logs.push(`[${code}] 정리 실패 order=${order.id}: ${err.message}`);
    }
  }

  try {
    await closeInfiniteCyclesForPlans(uid, infinitePlanIds, logs);
  } catch (err) {
    logs.push(`[cycle] 새 cycle 확인 실패: ${err.message}`);
  }

  return { skipped: false, total: orders.length, closed, logs };
};

const runUsEodUnfilledTradingV2ForAllUsers = async () => {
  console.log(`${LOG} 미국 미체결정리 시작`);
  const users = await getAllUsers();
  const { filterUsersWithKiwoom } = require('./kiwoomUtils');
  const capable = await filterUsersWithKiwoom(users);
  for (const user of capable) {
    const uid = String(user.id);
    try {
      const out = await runUsEodUnfilledTradingV2ForUser(uid);
      if (out.skipped) continue;
      if (out.total > 0) {
        console.log(`${LOG}[${uid}] 미국 대상=${out.total} 정리=${out.closed}`);
        (out.logs || []).forEach((line) => console.log(`${LOG}[${uid}] ${line}`));
      }
    } catch (err) {
      console.error(`${LOG}[${uid}] 미국 정리 오류:`, err.message);
    }
  }
  try {
    require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
  } catch {
    /* ignore */
  }
};

const restoreMonitoringAfterCancel = () => {
  // 미체결 취소로 남은 trailing 정리 후, pending 원복 상태로 즉시 감시 재개
  try {
    const { stopV2KrBuyTrailings } = require('./autoTradingBuyTrailingStop');
    const { stopV2KrSellTrailings } = require('./autoTradingTrailingStop');
    stopV2KrBuyTrailings();
    stopV2KrSellTrailings();
  } catch (err) {
    console.error(`${LOG} trailing 정리 실패:`, err.message);
  }
  try {
    require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
  } catch (err) {
    console.error(`${LOG} 감시 재개 갱신 실패:`, err.message);
  }
};

const runEodUnfilledTradingV2ForAllUsers = async (label = '', { restoreMonitoring = false } = {}) => {
  const tag = label ? ` ${label}` : '';
  console.log(`${LOG}${tag} 국내 미체결정리 시작`);
  const users = await getAllUsers();
  const { filterUsersWithKiwoom } = require('./kiwoomUtils');
  const capable = await filterUsersWithKiwoom(users);
  let usersRun = 0;
  let totalOrders = 0;
  let totalOrphans = 0;

  for (const user of capable) {
    const uid = String(user.id);
    try {
      const out = await runEodUnfilledTradingV2ForUser(uid, {
        skipRefresh: restoreMonitoring,
      });
      if (out.skipped) {
        console.log(`${LOG}[${uid}] skip reason=${out.reason || 'unknown'}`);
        continue;
      }
      usersRun += 1;
      totalOrders += out.total || 0;
      totalOrphans += out.orphanReopened || 0;
      if (out.total > 0 || out.orphanReopened > 0) {
        console.log(
          `${LOG}[${uid}] 대상=${out.total} 취소OK=${out.cancelled} DB정리=${out.dbOnly} 취소실패=${out.failed || 0}` +
            ` orphan원복=${out.orphanReopened || 0}`
        );
        (out.logs || []).forEach((line) => console.log(`${LOG}[${uid}] ${line}`));
      }
    } catch (err) {
      console.error(`${LOG}[${uid}] 오류:`, err.message);
    }
  }

  if (restoreMonitoring) {
    restoreMonitoringAfterCancel();
  }

  console.log(
    `${LOG}${tag} 완료 users=${usersRun} orders=${totalOrders} orphan원복=${totalOrphans}`
  );
  return { usersRun, totalOrders, totalOrphans };
};

function startTradingV2EodUnfilledScheduler() {
  // 정규장 15:30 — 미체결 취소 + stage pending 원복 + 감시 계속
  cron.schedule(
    '30 15 * * 1-5',
    async () => {
      try {
        await runEodUnfilledTradingV2ForAllUsers('정규장15:30', {
          restoreMonitoring: true,
        });
      } catch (error) {
        console.error(`${LOG} 15:30 오류:`, error);
      }
    },
    { timezone: 'Asia/Seoul' }
  );

  // 애프터 16:00 — KRX 세션 전환 시점 구독 한 번 갱신
  cron.schedule(
    '0 16 * * 1-5',
    async () => {
      try {
        console.log(`${LOG} 16:00 애프터 세션 갱신`);
        require('../services/autoTradingWsMonitor_v2').requestSubscribeRefreshSoon();
      } catch (error) {
        console.error(`${LOG} 16:00 오류:`, error);
      }
    },
    { timezone: 'Asia/Seoul' }
  );

  // 애프터 20:00 종료 직후 — 평일 20:05 KST
  cron.schedule(
    '5 20 * * 1-5',
    async () => {
      try {
        await runEodUnfilledTradingV2ForAllUsers('애프터20:05', {
          restoreMonitoring: true,
        });
      } catch (error) {
        console.error(`${LOG} 20:05 오류:`, error);
      }
    },
    { timezone: 'Asia/Seoul' }
  );

  // 장전 07:58 — 전날 취소 실패로 미체결로 남은 주문 정리 (당일 주문은 만료됨, 08:00 NXT 전)
  cron.schedule(
    '58 7 * * 1-5',
    async () => {
      try {
        await runEodUnfilledTradingV2ForAllUsers('장전07:58');
      } catch (error) {
        console.error(`${LOG} 07:58 오류:`, error);
      }
    },
    { timezone: 'Asia/Seoul' }
  );

  // 미국 애프터 20:00(NY) 종료 직후 — 평일 NY 20:10
  cron.schedule(
    '10 20 * * 1-5',
    async () => {
      try {
        await runUsEodUnfilledTradingV2ForAllUsers();
      } catch (error) {
        console.error(`${LOG} 미국 20:10(NY) 오류:`, error);
      }
    },
    { timezone: 'America/New_York' }
  );

  console.log(
    `${LOG} 스케줄러 시작 (15:30 취소·감시원복 / 16:00 세션갱신 / 20:05 취소 / 07:58 전날분 정리 / 미국 NY 20:10 정리)`
  );
}

module.exports = {
  startTradingV2EodUnfilledScheduler,
  runEodUnfilledTradingV2ForAllUsers,
  runEodUnfilledTradingV2ForUser,
  runUsEodUnfilledTradingV2ForAllUsers,
  runUsEodUnfilledTradingV2ForUser,
  reopenOrphanOrderedStages,
  markOrderCancelledAndReopenStage,
};

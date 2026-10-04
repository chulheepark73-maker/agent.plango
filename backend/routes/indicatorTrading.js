/**
 * 지표기반매매 — 설정·조건식·실시간 트래킹
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  getIndicatorTrading,
  saveIndicatorTradingSettings,
  setAutoTradingEnabled,
  setApiConnected,
  getTrackingStocks,
  saveTrackingStocks,
} = require('../utils/indicatorTradingStore');
const {
  ensurePositionTables,
  migrateBuysFromTrackingJson,
  mergeTrackingWithPositions,
  getActivePositions,
  getRecentOrders,
  stripOrderFieldsFromTracking,
  getClosedTradeHistory,
} = require('../utils/indicatorPositionStore');
const { getKiwoomInfo } = require('../utils/kiwoomUtils');
const { fetchConditionList } = require('../utils/kiwoomConditionList');
const { refreshTrackingFromCondition } = require('../utils/indicatorTradingTracker');
const {
  stopConditionRealtime,
  resubscribeConditionRealtime,
} = require('../utils/indicatorConditionRealtime');
const { evaluateIndicatorSellsForUser } = require('../services/indicatorSellMonitor');
const { cancelActivePositionsForUser } = require('../utils/indicatorPositionStore');

const toPublicResponse = async (row, userId) => {
  await ensurePositionTables();
  const rawTracking = row.trackingStocks || [];
  await migrateBuysFromTrackingJson(userId, rawTracking);
  const trackingStocks = await mergeTrackingWithPositions(userId, rawTracking);
  const needsStrip = rawTracking.some(
    (r) => r && (r.buyOrderNo || r.buyPrice != null || r.buyOrderStatus)
  );
  if (needsStrip) {
    await saveTrackingStocks(userId, rawTracking.map(stripOrderFieldsFromTracking));
  }
  return {
    settings: row.settings,
    trackingStocks,
    autoTradingEnabled: row.autoTradingEnabled,
    apiConnected: row.apiConnected,
    stockInfoLoadedCount: row.stockInfoLoadedCount,
    updatedAt: row.updatedAt,
  };
};

router.get('/status', authenticateToken, async (req, res) => {
  try {
    const row = await getIndicatorTrading(req.user.userId);
    res.json(await toPublicResponse(row, req.user.userId));
  } catch (error) {
    console.error('[지표기반매매] 상태 조회 실패:', error);
    res.status(500).json({ error: '상태 조회 중 오류가 발생했습니다.' });
  }
});

/** 영웅문 조건검색식 목록 (WS CNSRLST) */
router.get('/conditions', authenticateToken, async (req, res) => {
  try {
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    if (!kiwoomInfo?.accessToken) {
      return res.status(400).json({
        error: '키움 액세스 토큰이 없습니다. 나의 환경설정에서 토큰을 발급하세요.',
      });
    }
    const conditions = await fetchConditionList(kiwoomInfo.accessToken, {
      userId: req.user.userId,
    });
    res.json({ conditions });
  } catch (error) {
    console.error('[지표기반매매] 조건식 목록 조회 실패:', error?.message || error);
    res.status(500).json({
      error: error.message || '조건식 목록 조회 중 오류가 발생했습니다.',
    });
  }
});

/** 저장된 트래킹 종목 (+ 활성 포지션 병합) */
router.get('/tracking', authenticateToken, async (req, res) => {
  try {
    await ensurePositionTables();
    let stocks = await getTrackingStocks(req.user.userId);
    await migrateBuysFromTrackingJson(req.user.userId, stocks);
    const row = await getIndicatorTrading(req.user.userId);
    if (row.autoTradingEnabled) {
      const { recoverPendingIndicatorBuys } = require('../utils/indicatorBuyFill');
      await recoverPendingIndicatorBuys(req.user.userId, { minPollIntervalMs: 30000 }).catch(
        () => {}
      );
      const { recoverPendingIndicatorSells } = require('../services/indicatorSellMonitor');
      await recoverPendingIndicatorSells(req.user.userId, { minPollIntervalMs: 30000 }).catch(
        () => {}
      );
    }
    const needsStrip = stocks.some(
      (r) => r && (r.buyOrderNo || r.buyPrice != null || r.buyOrderStatus)
    );
    if (needsStrip) {
      stocks = stocks.map(stripOrderFieldsFromTracking);
      await saveTrackingStocks(req.user.userId, stocks);
    }
    const merged = await mergeTrackingWithPositions(req.user.userId, stocks);
    res.json({
      stocks: merged,
      conditionSeq: row.settings?.buyCondition ?? '',
      autoTradingEnabled: !!row.autoTradingEnabled,
    });
  } catch (error) {
    console.error('[지표기반매매] 트래킹 조회 실패:', error);
    res.status(500).json({ error: '트래킹 조회 중 오류가 발생했습니다.' });
  }
});

/** 종목명 검색 (수동 추가용, 복수 후보) */
router.post('/tracking/search', authenticateToken, async (req, res) => {
  try {
    const { searchStockByName } = require('../utils/stockListStore');
    const trimmed = String(req.body?.stockName || '').trim();
    if (!trimmed) {
      return res.status(400).json({ error: '종목명은 필수입니다.' });
    }
    if (trimmed.length < 2) {
      return res.json({ matches: [] });
    }
    const matches = await searchStockByName(trimmed, true);
    const list = Array.isArray(matches) ? matches.slice(0, 20) : [];
    res.json({ matches: list });
  } catch (error) {
    console.error('[지표기반매매] 종목 검색 실패:', error);
    res.status(500).json({ error: error.message || '종목 검색에 실패했습니다.' });
  }
});

/** 종목명/코드로 트래킹 수동 추가 */
router.post('/tracking/manual', authenticateToken, async (req, res) => {
  try {
    const { searchStockByName, isNXTStock } = require('../utils/stockListStore');
    const { addManualTrackingStock } = require('../utils/indicatorTradingTracker');

    let stockCode = String(req.body?.stockCode || '').trim().substring(0, 6);
    let stockName = String(req.body?.stockName || '').trim();

    if (!stockCode) {
      if (!stockName) {
        return res.status(400).json({ error: '종목명을 입력하세요.' });
      }
      const found = await searchStockByName(stockName);
      if (!found) {
        const allMatches = await searchStockByName(stockName, true);
        const suggestion =
          allMatches?.length > 0
            ? `유사한 종목: ${allMatches
                .slice(0, 5)
                .map((s) => s.stockName)
                .join(', ')}`
            : '관심종목 화면에서 종목 목록을 업데이트해 주세요.';
        return res.status(404).json({
          error: `종목명 "${stockName}"을(를) 찾을 수 없습니다.`,
          suggestion,
        });
      }
      stockCode = found.stockCode;
      stockName = found.stockName;
    } else if (!stockName) {
      const { resolveIndicatorStockName } = require('../utils/indicatorPositionStore');
      stockName = await resolveIndicatorStockName(req.user.userId, stockCode, '');
    }

    const result = await addManualTrackingStock(req.user.userId, {
      stockCode,
      stockName,
    });
    const isNxt = await isNXTStock(stockCode);
    res.json({
      ...result,
      stockMarket: isNxt ? 'NXT' : 'KRX',
      message: result.already
        ? `이미 트래킹 중입니다: ${stockName || stockCode}`
        : `추가됨: ${stockName || stockCode} (${stockCode})`,
    });
  } catch (error) {
    console.error('[지표기반매매] 수동 추가 실패:', error);
    res.status(400).json({ error: error.message || '종목 추가에 실패했습니다.' });
  }
});

/** 수동 트래킹 삭제 (보유·매도중 불가, 미체결 매수는 취소) */
router.delete('/tracking/manual/:stockCode', authenticateToken, async (req, res) => {
  try {
    const { removeManualTrackingStock } = require('../utils/indicatorTradingTracker');
    const stockCode = String(req.params.stockCode || '').trim().substring(0, 6);
    const result = await removeManualTrackingStock(req.user.userId, stockCode);
    const cancelPart =
      result.cancelResult?.total > 0
        ? ` · 미체결 매수 취소 ${result.cancelResult.cancelled}/${result.cancelResult.total}`
        : '';
    res.json({
      ...result,
      message: `삭제됨: ${result.stockName || result.stockCode}${cancelPart}`,
    });
  } catch (error) {
    const status = error.code === 'HOLDING_BLOCKED' ? 409 : 400;
    console.error('[지표기반매매] 수동 삭제 실패:', error.message || error);
    res.status(status).json({ error: error.message || '종목 삭제에 실패했습니다.' });
  }
});

/** 활성 포지션 */
router.get('/positions', authenticateToken, async (req, res) => {
  try {
    const positions = await getActivePositions(req.user.userId);
    res.json({ positions });
  } catch (error) {
    console.error('[지표기반매매] 포지션 조회 실패:', error);
    res.status(500).json({ error: '포지션 조회 중 오류가 발생했습니다.' });
  }
});

/** 주문 이력 */
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const orders = await getRecentOrders(req.user.userId, limit);
    res.json({ orders });
  } catch (error) {
    console.error('[지표기반매매] 주문 이력 조회 실패:', error);
    res.status(500).json({ error: '주문 이력 조회 중 오류가 발생했습니다.' });
  }
});

/** 청산 완료 거래 내역 (매도일 기준 기간) */
router.get('/trades', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const result = await getClosedTradeHistory(req.user.userId, { startDate, endDate });
    res.json(result);
  } catch (error) {
    console.error('[지표기반매매] 거래 내역 조회 실패:', error?.message || error);
    res.status(400).json({
      error: error.message || '거래 내역 조회 중 오류가 발생했습니다.',
    });
  }
});

/**
 * 매수조건 조건식으로 종목 불러오기
 * placeOrders=true 이고 자동매매 ON 이면 설정값으로 매수 주문 시도
 */
router.post('/tracking/refresh', authenticateToken, async (req, res) => {
  try {
    const placeOrders = !!req.body?.placeOrders;
    const result = await refreshTrackingFromCondition(req.user.userId, {
      placeOrders,
      syncRealtime: true,
    });
    res.json({
      message: `조건식 종목 ${result.stocks.length}개 불러옴`,
      ...result,
    });
  } catch (error) {
    console.error('[지표기반매매] 트래킹 갱신 실패:', error?.message || error);
    res.status(400).json({
      error: error.message || '조건식 종목 불러오기에 실패했습니다.',
    });
  }
});

router.post('/settings', authenticateToken, async (req, res) => {
  try {
    const prev = await getIndicatorTrading(req.user.userId);
    const prevSeq = String(prev.settings?.buyCondition ?? '').trim();
    const row = await saveIndicatorTradingSettings(req.user.userId, req.body || {});
    const nextSeq = String(row.settings?.buyCondition ?? '').trim();
    if (row.autoTradingEnabled && nextSeq && nextSeq !== prevSeq) {
      try {
        await resubscribeConditionRealtime(req.user.userId);
      } catch (subErr) {
        console.warn('[지표기반매매] 조건식 변경 재구독:', subErr.message);
      }
    }
    res.json({
      message: '설정이 저장되었습니다.',
      ...(await toPublicResponse(row, req.user.userId)),
    });
  } catch (error) {
    console.error('[지표기반매매] 설정 저장 실패:', error);
    res.status(500).json({ error: '설정 저장 중 오류가 발생했습니다.' });
  }
});

router.post('/connect', authenticateToken, async (req, res) => {
  try {
    const row = await setApiConnected(req.user.userId, true, 0);
    res.json({
      message: 'API 연결 상태 갱신',
      ...(await toPublicResponse(row, req.user.userId)),
    });
  } catch (error) {
    console.error('[지표기반매매] API 연결 실패:', error);
    res.status(500).json({ error: 'API 연결 중 오류가 발생했습니다.' });
  }
});

router.post('/start', authenticateToken, async (req, res) => {
  try {
    const { getActiveSubscription } = require('../utils/subscriptionStore');
    const activeSub = await getActiveSubscription(req.user.userId);
    if (!activeSub) {
      return res.status(403).json({
        error: '일반회원은 지표기반 자동매매를 사용할 수 없습니다. 프리미엄 구독 시 이용 가능합니다.',
        code: 'PLAN_LIMIT_INDICATOR_AUTO',
      });
    }

    // 이전 버전 낙관적(미체결) open 포지션 정리 — 체결된 포지션만 이후에 다시 생김
    try {
      const cleaned = await cancelActivePositionsForUser(
        req.user.userId,
        'cleanup_unfilled_optimistic'
      );
      if (cleaned.length) {
        console.log(
          `[지표기반매매] 유령/미검증 포지션 ${cleaned.length}건 취소:`,
          cleaned.map((r) => r.stock_code).join(',')
        );
      }
    } catch (cleanErr) {
      console.warn('[지표기반매매] 포지션 정리 실패:', cleanErr.message);
    }

    const next = await setAutoTradingEnabled(req.user.userId, true);
    let tracking = null;
    let sellLogs = [];
    try {
      tracking = await refreshTrackingFromCondition(req.user.userId, { placeOrders: true });
    } catch (trackErr) {
      console.error('[지표기반매매] 자동매매 ON 후 트래킹 갱신:', trackErr.message);
    }
    try {
      sellLogs = await evaluateIndicatorSellsForUser(req.user.userId);
    } catch (sellErr) {
      console.error('[지표기반매매] 자동매매 ON 후 매도 평가:', sellErr.message);
    }
    try {
      const { requestSubscribeRefreshSoon } = require('../services/indicatorWsMonitor');
      requestSubscribeRefreshSoon();
    } catch (_) {
      /* ignore */
    }
    res.json({
      message: tracking
        ? `자동매매 ON — 조건식 실시간 구독 시작 (${tracking.stocks.length}종목)`
        : '자동매매 ON — 조건식 종목 불러오기는 실시간 트래킹에서 다시 시도하세요',
      ...(await toPublicResponse(next, req.user.userId)),
      tracking,
      sellLogs,
    });
  } catch (error) {
    console.error('[지표기반매매] 시작 실패:', error);
    res.status(500).json({ error: '자동매매 시작 중 오류가 발생했습니다.' });
  }
});

const { cancelPendingIndicatorBuysOnStop } = require('../utils/indicatorBuyFill');
const { cancelPendingIndicatorSellsOnStop } = require('../services/indicatorSellMonitor');

router.post('/stop', authenticateToken, async (req, res) => {
  try {
    let buyCancel = { cancelled: 0, failed: 0, total: 0, logs: [] };
    let sellCancel = { cancelled: 0, failed: 0, total: 0, logs: [] };
    try {
      buyCancel = await cancelPendingIndicatorBuysOnStop(req.user.userId);
    } catch (cancelErr) {
      console.error('[지표기반매매] OFF 미체결 매수 취소 오류:', cancelErr.message);
    }
    try {
      sellCancel = await cancelPendingIndicatorSellsOnStop(req.user.userId);
    } catch (cancelErr) {
      console.error('[지표기반매매] OFF 미체결 매도 취소 오류:', cancelErr.message);
    }
    if (buyCancel.total > 0 || sellCancel.total > 0) {
      console.log(
        `[지표기반매매] OFF — 매수취소 ${buyCancel.cancelled}/${buyCancel.total}, ` +
          `매도취소 ${sellCancel.cancelled}/${sellCancel.total}`
      );
    }

    const next = await setAutoTradingEnabled(req.user.userId, false);
    try {
      await stopConditionRealtime(req.user.userId);
    } catch (clrErr) {
      console.warn('[지표기반매매] 조건검색 해제:', clrErr.message);
    }
    try {
      const { requestSubscribeRefreshSoon } = require('../services/indicatorWsMonitor');
      requestSubscribeRefreshSoon();
    } catch (_) {
      /* ignore */
    }

    const parts = [];
    if (buyCancel.total > 0) {
      parts.push(`미체결 매수 취소 ${buyCancel.cancelled}/${buyCancel.total}`);
    }
    if (sellCancel.total > 0) {
      parts.push(`미체결 매도 취소 ${sellCancel.cancelled}/${sellCancel.total}`);
    }
    const cancelMsg = parts.length ? ` (${parts.join(', ')})` : '';
    res.json({
      message: `자동매매 OFF${cancelMsg}`,
      cancelResult: { buy: buyCancel, sell: sellCancel },
      ...(await toPublicResponse(next, req.user.userId)),
    });
  } catch (error) {
    console.error('[지표기반매매] 중지 실패:', error);
    res.status(500).json({ error: '자동매매 중지 중 오류가 발생했습니다.' });
  }
});

module.exports = router;

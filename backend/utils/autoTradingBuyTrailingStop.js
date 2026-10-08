const { sendTelegramToUserById } = require('../services/telegramService');
const { isSessionOpenForMarket, autoCodesMatch, formatTelegramPrice } = require('./autoTradingMarket');

const TRAILING_TELEGRAM_PROGRESS_MS = 60 * 1000;
const PROGRESS_LOG_THROTTLE_MS = 2000;
const SESSION_CHECK_MS = 30000;

const buyLog = (userId) => `[Buy Trailing Stop][${userId}]`;

// `${userId}_${stockCode}_${buyStage}` -> state
const buyTrailingStopIntervals = new Map();

const notifySubscribeRefresh = () => {
  try {
    const { requestSymbolRefreshSoon: requestV2 } = require('../services/autoTradingWsMonitor_v2');
    requestV2();
  } catch {
    /* v2 monitor not loaded yet */
  }
};

const isSessionOpen = (stockMarket) => isSessionOpenForMarket(stockMarket);

const endBuyTrailing = async (checkKey, state, reason, endPrice, telegramMsg) => {
  if (!buyTrailingStopIntervals.has(checkKey)) return;
  if (state.sessionCheckId) clearInterval(state.sessionCheckId);
  buyTrailingStopIntervals.delete(checkKey);
  notifySubscribeRefresh();

  if (telegramMsg) {
    void sendTelegramToUserById(state.userId, telegramMsg);
  }
};

/**
 * WebSocket 시세 틱 처리
 */
const onBuyTrailingPriceTick = async (userId, stockCode, currentPrice) => {
  const code = String(stockCode || '').trim();
  const price = parseFloat(currentPrice);
  if (!code || !Number.isFinite(price) || price <= 0) return;

  const tasks = [];
  for (const [checkKey, state] of buyTrailingStopIntervals.entries()) {
    if (String(state.userId) !== String(userId)) continue;
    if (!autoCodesMatch(state.stockCode, code, state.stockMarket)) continue;
    tasks.push(processBuyTrailingTick(checkKey, state, price));
  }
  await Promise.all(tasks);
};

async function processBuyTrailingTick(checkKey, state, currentPrice) {
  if (state.processing) return;
  if (!buyTrailingStopIntervals.has(checkKey)) return;

  try {
    if (!isSessionOpen(state.stockMarket)) {
      if (state.processing) return;
      state.processing = true;
      console.log(`${buyLog(state.userId)} 거래시간 종료로 모니터링 중지: ${state.stockCode}, 차수=${state.buyStage}차`);
      await endBuyTrailing(
        checkKey,
        state,
        '거래시간 종료',
        state.curPrice,
        `⏹ Buy Trailing 종료 (장마감)\n${state.stockName || state.stockCode} (${state.stockCode}) ${state.buyStage}차\n` +
          `현재가 ${formatTelegramPrice(state.curPrice, state.stockMarket)}`
      );
      return;
    }

    state.curPrice = currentPrice;
    if (currentPrice < state.lowPrice) {
      state.lowPrice = currentPrice;
      console.log(`${buyLog(state.userId)} low_price 갱신: ${state.stockCode}, 차수=${state.buyStage}차, ${state.lowPrice}`);
    }

    if (currentPrice >= state.buyXPrice) {
      if (state.processing) return;
      state.processing = true;
      console.log(
        `${buyLog(state.userId)} 목표가 이상 상승으로 모니터링 중지: ${state.stockCode}, 차수=${state.buyStage}차, 현재가=${currentPrice}, 목표가=${state.buyXPrice}`
      );
      await endBuyTrailing(
        checkKey,
        state,
        '목표가 이상 상승',
        currentPrice,
        `⏹ Buy Trailing 종료 (목표가 이상)\n${state.stockName || state.stockCode} (${state.stockCode}) ${state.buyStage}차\n` +
          `현재 ${formatTelegramPrice(currentPrice, state.stockMarket)} ≥ 목표 ${formatTelegramPrice(state.buyXPrice, state.stockMarket)}`
      );
      return;
    }

    const risePercent = ((state.curPrice - state.lowPrice) / state.lowPrice) * 100;

    if (risePercent >= state.trailingPercent) {
      // V1·V2 틱이 동시에 들어오면 여기까지 두 번 올 수 있음 → 주문 전에 동기 점유
      if (state.processing) return;
      state.processing = true;
      console.log(
        `${buyLog(state.userId)} 매수 조건 만족: ${state.stockCode}, 차수=${state.buyStage}차, low_price=${state.lowPrice}, cur_price=${state.curPrice}, 상승률=${risePercent.toFixed(2)}%, 기준=${state.trailingPercent}%`
      );

      const lowPrice = state.lowPrice;
      const { kiwoomInfo, userId, stockCode, buyQty, stockMarket, buyStage, stockName, trailingPercent } = state;

      await endBuyTrailing(checkKey, state, 'buy trailing stop 조건 만족', lowPrice, null);

      let orderResult;
      if (typeof state.executeOrder === 'function') {
        orderResult = await state.executeOrder({
          kiwoomInfo,
          userId,
          stockCode,
          price: lowPrice,
          qty: buyQty,
          stockMarket,
          buyStage,
          ...(state.v2Meta || {}),
        });
      } else {
        orderResult = { success: false, error: '주문 실행 함수(executeOrder)가 없습니다.' };
      }

      if (orderResult.success) {
        console.log(
          `${buyLog(userId)} 매수 주문 실행 완료: ${stockCode}, 차수=${buyStage}차, 주문가격=${lowPrice} (low_price), 수량=${buyQty}주`
        );
        void sendTelegramToUserById(
          userId,
          `✅ Buy Trailing → 매수 주문\n${stockName || stockCode} (${stockCode}) ${buyStage}차\n` +
            `지정가 ${formatTelegramPrice(lowPrice, stockMarket)} · ${buyQty}주\n` +
            `상승률 ${risePercent.toFixed(2)}% (기준 ${trailingPercent}%)`
        );
      } else {
        console.error(`${buyLog(userId)} 매수 주문 실행 실패: ${stockCode}, 차수=${buyStage}차`, orderResult.error);
        void sendTelegramToUserById(
          userId,
          `⚠️ Buy Trailing 조건 충족 후 매수 실패\n${stockName || stockCode} (${stockCode}) ${buyStage}차\n` +
            `${orderResult.error || '오류'}`
        );
      }
      return;
    }

    const now = Date.now();
    if (!state.lastProgressLogAt || now - state.lastProgressLogAt >= PROGRESS_LOG_THROTTLE_MS) {
      state.lastProgressLogAt = now;
      console.log(
        `${buyLog(state.userId)} 모니터링 중: ${state.stockCode}, 차수=${state.buyStage}차, low_price=${state.lowPrice}, cur_price=${state.curPrice}, 상승률=${risePercent.toFixed(2)}%, 기준=${state.trailingPercent}%`
      );
    }
    if (now - (state.lastProgressTelegramAt || 0) >= TRAILING_TELEGRAM_PROGRESS_MS) {
      state.lastProgressTelegramAt = now;
      void sendTelegramToUserById(
        state.userId,
        `📊 Buy Trailing 진행\n${state.stockName || state.stockCode} (${state.stockCode}) ${state.buyStage}차\n` +
          `저가 ${formatTelegramPrice(state.lowPrice, state.stockMarket)} · 현재 ${formatTelegramPrice(state.curPrice, state.stockMarket)}\n` +
          `상승률 ${risePercent.toFixed(2)}% / 기준 ${state.trailingPercent}%`
      );
    }
  } catch (error) {
    console.error(`${buyLog(state.userId)} 틱 처리 오류: ${state.stockCode}, 차수=${state.buyStage}차`, error.message);
  }
}

const startBuyTrailingStop = async (
  kiwoomInfo,
  userId,
  stockCode,
  stockName,
  buyStage,
  buyQty,
  stockMarket,
  initialPrice,
  trailingPercent,
  buyXPrice,
  options = {}
) => {
  const checkKey = options.checkKey || `${userId}_${stockCode}_${buyStage}`;

  if (buyTrailingStopIntervals.has(checkKey)) {
    console.log(`${buyLog(userId)} 이미 모니터링 중: ${stockCode}, 차수=${buyStage}차`);
    return;
  }

  const state = {
    userId,
    stockCode,
    buyStage,
    startTime: Date.now(),
    curPrice: initialPrice,
    lowPrice: initialPrice,
    trailingPercent,
    kiwoomInfo,
    buyQty,
    stockMarket,
    buyXPrice,
    stockName: stockName || stockCode,
    lastProgressTelegramAt: 0,
    processing: false,
    sessionCheckId: null,
    executeOrder: typeof options.executeOrder === 'function' ? options.executeOrder : null,
    v2Meta: options.v2Meta || null,
  };
  buyTrailingStopIntervals.set(checkKey, state);

  console.log(
    `${buyLog(userId)} 모니터링 시작(WS): ${stockCode} (${stockName}), 차수=${buyStage}차, 초기가격=${initialPrice}, 목표가=${buyXPrice}, trailingPercent=${trailingPercent}%`
  );

  void sendTelegramToUserById(
    userId,
    `📈 Buy Trailing 시작\n${stockName || stockCode} (${stockCode}) ${buyStage}차\n` +
      `시작가 ${formatTelegramPrice(initialPrice, stockMarket)} · 목표 ${formatTelegramPrice(buyXPrice, stockMarket)}\n` +
      `기준 ${trailingPercent}%`
  );

  state.sessionCheckId = setInterval(() => {
    if (!buyTrailingStopIntervals.has(checkKey)) return;
    if (!isSessionOpen(stockMarket)) {
      processBuyTrailingTick(checkKey, state, state.curPrice).catch(() => {});
    }
  }, SESSION_CHECK_MS);

  notifySubscribeRefresh();
};

const clearBuyTrailingEntry = (checkKey, trailingInfo, reason = '설정 변경·삭제 등으로 중단됨') => {
  if (!trailingInfo) return;
  if (trailingInfo.sessionCheckId) clearInterval(trailingInfo.sessionCheckId);
  buyTrailingStopIntervals.delete(checkKey);
  console.log(
    `${buyLog(trailingInfo.userId)} 모니터링 중지: ${trailingInfo.stockCode}, 차수=${trailingInfo.buyStage}차` +
      (String(checkKey).includes('_v2p') ? ` key=${checkKey}` : '')
  );
  void sendTelegramToUserById(
    trailingInfo.userId,
    `⏹ Buy Trailing 중지\n${trailingInfo.stockName || trailingInfo.stockCode} (${trailingInfo.stockCode}) ${trailingInfo.buyStage}차\n(${reason})`
  );
};

/** 레거시 키 + V2 `_v2p{planId}` 키 모두 중지 */
const stopBuyTrailingStop = (userId, stockCode, buyStage) => {
  const uid = String(userId);
  const code = String(stockCode || '').trim();
  const stage = Number(buyStage);
  const prefix = `${uid}_${code}_${stage}`;
  let stopped = 0;
  for (const [checkKey, info] of [...buyTrailingStopIntervals.entries()]) {
    const matchExact = checkKey === prefix;
    const matchV2 = checkKey.startsWith(`${prefix}_v2p`);
    const matchState =
      String(info.userId) === uid &&
      Number(info.buyStage) === stage &&
      autoCodesMatch(info.stockCode, code, info.stockMarket);
    if (!matchExact && !matchV2 && !matchState) continue;
    clearBuyTrailingEntry(checkKey, info);
    stopped += 1;
  }
  if (stopped > 0) notifySubscribeRefresh();
};

/** V2 planId 기준 buy trailing 중지 */
const stopV2BuyTrailingsByPlanId = (planId, { silent = false, reason = '플랜 중지·삭제' } = {}) => {
  const pid = Number(planId);
  if (!Number.isFinite(pid) || pid <= 0) return 0;
  let n = 0;
  let sampleUid = null;
  for (const [checkKey, state] of [...buyTrailingStopIntervals.entries()]) {
    const metaPid = state.v2Meta?.planId != null ? Number(state.v2Meta.planId) : null;
    const keyMatch = /_v2p(\d+)$/.exec(String(checkKey));
    const keyPid = keyMatch ? Number(keyMatch[1]) : null;
    if (metaPid !== pid && keyPid !== pid) continue;
    if (state.sessionCheckId) clearInterval(state.sessionCheckId);
    buyTrailingStopIntervals.delete(checkKey);
    n += 1;
    if (sampleUid == null) sampleUid = state.userId;
    if (!silent) {
      void sendTelegramToUserById(
        state.userId,
        `⏹ Buy Trailing 중지\n${state.stockName || state.stockCode} (${state.stockCode}) ${state.buyStage}차\n(${reason})`
      );
    }
  }
  if (n > 0) {
    notifySubscribeRefresh();
    console.log(`${buyLog(sampleUid)} V2 plan=${pid} buy trailing ${n}건 중지`);
  }
  return n;
};

/** 사용자 전체 V2 buy trailing 중지 */
const stopV2BuyTrailingsForUser = (userId) => {
  const uid = String(userId);
  let n = 0;
  for (const [checkKey, state] of [...buyTrailingStopIntervals.entries()]) {
    if (String(state.userId) !== uid) continue;
    if (!String(checkKey).includes('_v2p') && !state.v2Meta?.planId) continue;
    if (state.sessionCheckId) clearInterval(state.sessionCheckId);
    buyTrailingStopIntervals.delete(checkKey);
    n += 1;
  }
  if (n > 0) {
    notifySubscribeRefresh();
    console.log(`${buyLog(uid)} V2 buy trailing ${n}건 중지`);
  }
  return n;
};

const stopAllBuyTrailingStops = () => {
  for (const [, trailingInfo] of buyTrailingStopIntervals.entries()) {
    if (trailingInfo.sessionCheckId) clearInterval(trailingInfo.sessionCheckId);
  }
  buyTrailingStopIntervals.clear();
  notifySubscribeRefresh();
  console.log('[Buy Trailing Stop] 모든 모니터링 중지');
};

/** 구독용: userId -> [{ stockCode, stockName, stockMarket }] */
const getActiveBuyTrailingSymbols = () => {
  const byUser = new Map();
  for (const state of buyTrailingStopIntervals.values()) {
    const uid = String(state.userId);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push({
      stockCode: state.stockCode,
      stockName: state.stockName,
      stockMarket: state.stockMarket || 'KRX',
    });
  }
  return byUser;
};

module.exports = {
  startBuyTrailingStop,
  stopBuyTrailingStop,
  stopAllBuyTrailingStops,
  buyTrailingStopIntervals,
  onBuyTrailingPriceTick,
  getActiveBuyTrailingSymbols,
  stopV2BuyTrailingsByPlanId,
  stopV2BuyTrailingsForUser,
  /** V2 국내 trailing 일괄 중지 (정규장 종료 등) */
  stopV2KrBuyTrailings() {
    let n = 0;
    for (const [checkKey, state] of [...buyTrailingStopIntervals.entries()]) {
      if (!String(checkKey).includes('_v2p')) continue;
      if (state.stockMarket === 'US') continue;
      if (state.sessionCheckId) clearInterval(state.sessionCheckId);
      buyTrailingStopIntervals.delete(checkKey);
      n += 1;
    }
    if (n > 0) {
      notifySubscribeRefresh();
      console.log(`[Buy Trailing Stop] V2 국내 trailing ${n}건 중지`);
    }
    return n;
  },
};

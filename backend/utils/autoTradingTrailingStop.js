const fs = require('fs').promises;
const path = require('path');
const { sendTelegramToUserById } = require('../services/telegramService');
const { isSessionOpenForMarket, autoCodesMatch, formatTelegramPrice } = require('./autoTradingMarket');

const TRAILING_TELEGRAM_PROGRESS_MS = 60 * 1000;
const SAVE_THROTTLE_MS = 2000;
const SESSION_CHECK_MS = 30000;

const sellLog = (userId) => `[Trailing Stop][${userId}]`;

// `${userId}_${stockCode}_${sellStage}` -> state
const trailingStopIntervals = new Map();

const TRAILING_STOP_DATA_DIR = path.join(__dirname, '..', 'data', 'sell_trailing_stop');

const ensureTrailingStopDataDir = async () => {
  try {
    await fs.mkdir(TRAILING_STOP_DATA_DIR, { recursive: true });
  } catch (error) {
    console.error('[Trailing Stop] 디렉토리 생성 실패:', error);
  }
};

const getDateTimeString = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}-${minutes}-${seconds}`;
};

const savePriceToFile = async (filePath, dateTimeStr, price, status = null) => {
  try {
    let data = {};
    try {
      const fileContent = await fs.readFile(filePath, 'utf8');
      data = JSON.parse(fileContent);
    } catch {
      data = {};
    }
    data[dateTimeStr] = price;
    if (status) {
      data.status = status.status;
      data.reason = status.reason;
      data.endTime = status.endTime;
      data.endPrice = status.endPrice;
    }
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error(`[Trailing Stop] 가격 저장 실패: ${filePath}`, error);
  }
};

const notifySubscribeRefresh = () => {
  try {
    const { requestSymbolRefreshSoon: requestV2 } = require('../services/autoTradingWsMonitor_v2');
    requestV2();
  } catch {
    /* v2 monitor not loaded yet */
  }
};

const isSessionOpen = (stockMarket) => isSessionOpenForMarket(stockMarket);

const endSellTrailing = async (checkKey, state, reason, endPrice, telegramMsg) => {
  if (!trailingStopIntervals.has(checkKey)) return;
  if (state.sessionCheckId) clearInterval(state.sessionCheckId);
  trailingStopIntervals.delete(checkKey);
  notifySubscribeRefresh();

  const endDateTimeStr = getDateTimeString();
  await savePriceToFile(state.filePath, endDateTimeStr, endPrice, {
    status: reason === 'trailing stop 조건 만족' ? '성공' : '실패',
    reason,
    endTime: endDateTimeStr,
    endPrice,
  });
  if (telegramMsg) {
    void sendTelegramToUserById(state.userId, telegramMsg);
  }
};

/**
 * WebSocket 시세 틱 처리
 */
const onSellTrailingPriceTick = async (userId, stockCode, currentPrice) => {
  const code = String(stockCode || '').trim();
  const price = parseFloat(currentPrice);
  if (!code || !Number.isFinite(price) || price <= 0) return;

  const tasks = [];
  for (const [checkKey, state] of trailingStopIntervals.entries()) {
    if (String(state.userId) !== String(userId)) continue;
    if (!autoCodesMatch(state.stockCode, code, state.stockMarket)) continue;
    tasks.push(processSellTrailingTick(checkKey, state, price));
  }
  await Promise.all(tasks);
};

async function processSellTrailingTick(checkKey, state, currentPrice) {
  if (state.processing) return;
  if (!trailingStopIntervals.has(checkKey)) return;

  try {
    if (!isSessionOpen(state.stockMarket)) {
      if (state.processing) return;
      state.processing = true;
      console.log(`${sellLog(state.userId)} 거래시간 종료로 모니터링 중지: ${state.stockCode}, 차수=${state.sellStage}차`);
      await endSellTrailing(
        checkKey,
        state,
        '거래시간 종료',
        state.curPrice,
        `⏹ Sell Trailing 종료 (장마감)\n${state.stockName || state.stockCode} (${state.stockCode}) ${state.sellStage}차\n` +
          `현재가 ${formatTelegramPrice(state.curPrice, state.stockMarket)}`
      );
      return;
    }

    state.curPrice = currentPrice;
    if (currentPrice > state.highPrice) {
      state.highPrice = currentPrice;
      console.log(`${sellLog(state.userId)} high_price 갱신: ${state.stockCode}, 차수=${state.sellStage}차, ${state.highPrice}`);
    }

    if (currentPrice <= state.sellXPrice) {
      if (state.processing) return;
      state.processing = true;
      console.log(
        `${sellLog(state.userId)} 목표가 이하 하락으로 모니터링 중지: ${state.stockCode}, 차수=${state.sellStage}차, 현재가=${currentPrice}, 목표가=${state.sellXPrice}`
      );
      await endSellTrailing(
        checkKey,
        state,
        '목표가 이하 하락',
        currentPrice,
        `⏹ Sell Trailing 종료 (목표가 이하)\n${state.stockName || state.stockCode} (${state.stockCode}) ${state.sellStage}차\n` +
          `현재 ${formatTelegramPrice(currentPrice, state.stockMarket)} ≤ 목표 ${formatTelegramPrice(state.sellXPrice, state.stockMarket)}`
      );
      return;
    }

    const dropPercent = ((state.highPrice - state.curPrice) / state.highPrice) * 100;

    if (dropPercent >= state.trailingPercent) {
      if (state.processing) return;
      state.processing = true;
      console.log(
        `${sellLog(state.userId)} 매도 조건 만족: ${state.stockCode}, 차수=${state.sellStage}차, high_price=${state.highPrice}, cur_price=${state.curPrice}, 하락률=${dropPercent.toFixed(2)}%, 기준=${state.trailingPercent}%`
      );

      const highPrice = state.highPrice;
      const { kiwoomInfo, userId, stockCode, sellQty, stockMarket, sellStage, stockName, trailingPercent } = state;

      await endSellTrailing(checkKey, state, 'trailing stop 조건 만족', highPrice, null);

      let orderResult;
      if (typeof state.executeOrder === 'function') {
        orderResult = await state.executeOrder({
          kiwoomInfo,
          userId,
          stockCode,
          price: highPrice,
          qty: sellQty,
          stockMarket,
          sellStage,
          ...(state.v2Meta || {}),
        });
      } else {
        orderResult = { success: false, error: '주문 실행 함수(executeOrder)가 없습니다.' };
      }

      if (orderResult.success) {
        console.log(
          `${sellLog(userId)} 매도 주문 실행 완료: ${stockCode}, 차수=${sellStage}차, 주문가격=${highPrice}, 수량=${sellQty}주`
        );
        void sendTelegramToUserById(
          userId,
          `✅ Sell Trailing → 매도 주문\n${stockName || stockCode} (${stockCode}) ${sellStage}차\n` +
            `가격 ${formatTelegramPrice(highPrice, stockMarket)} · ${sellQty}주\n` +
            `하락률 ${dropPercent.toFixed(2)}% (기준 ${trailingPercent}%)`
        );
      } else {
        console.error(`${sellLog(userId)} 매도 주문 실행 실패: ${stockCode}, 차수=${sellStage}차`, orderResult.error);
        void sendTelegramToUserById(
          userId,
          `⚠️ Sell Trailing 조건 충족 후 매도 실패\n${stockName || stockCode} (${stockCode}) ${sellStage}차\n` +
            `${orderResult.error || '오류'}`
        );
      }
      return;
    }

    const now = Date.now();
    if (!state.lastSaveAt || now - state.lastSaveAt >= SAVE_THROTTLE_MS) {
      state.lastSaveAt = now;
      void savePriceToFile(state.filePath, getDateTimeString(), currentPrice);
    }

    if (!state.lastProgressLogAt || now - state.lastProgressLogAt >= SAVE_THROTTLE_MS) {
      state.lastProgressLogAt = now;
      console.log(
        `${sellLog(state.userId)} 모니터링 중: ${state.stockCode}, 차수=${state.sellStage}차, high_price=${state.highPrice}, cur_price=${state.curPrice}, 하락률=${dropPercent.toFixed(2)}%, 기준=${state.trailingPercent}%`
      );
    }
    if (now - (state.lastProgressTelegramAt || 0) >= TRAILING_TELEGRAM_PROGRESS_MS) {
      state.lastProgressTelegramAt = now;
      void sendTelegramToUserById(
        state.userId,
        `📊 Sell Trailing 진행\n${state.stockName || state.stockCode} (${state.stockCode}) ${state.sellStage}차\n` +
          `고가 ${formatTelegramPrice(state.highPrice, state.stockMarket)} · 현재 ${formatTelegramPrice(state.curPrice, state.stockMarket)}\n` +
          `하락률 ${dropPercent.toFixed(2)}% / 기준 ${state.trailingPercent}%`
      );
    }
  } catch (error) {
    console.error(`${sellLog(state.userId)} 틱 처리 오류: ${state.stockCode}, 차수=${state.sellStage}차`, error.message);
  }
}

const startTrailingStop = async (
  kiwoomInfo,
  userId,
  stockCode,
  stockName,
  sellStage,
  sellQty,
  stockMarket,
  initialPrice,
  trailingPercent,
  sellXPrice,
  options = {}
) => {
  const checkKey = options.checkKey || `${userId}_${stockCode}_${sellStage}`;

  if (trailingStopIntervals.has(checkKey)) {
    console.log(`${sellLog(userId)} 이미 모니터링 중: ${stockCode}, 차수=${sellStage}차`);
    return;
  }

  const state = {
    userId,
    stockCode,
    sellStage,
    startTime: Date.now(),
    curPrice: initialPrice,
    highPrice: initialPrice,
    trailingPercent,
    filePath: null,
    kiwoomInfo,
    sellQty,
    stockMarket,
    sellXPrice,
    stockName: stockName || stockCode,
    lastSaveAt: Date.now(),
    lastProgressTelegramAt: 0,
    processing: false,
    sessionCheckId: null,
    executeOrder: typeof options.executeOrder === 'function' ? options.executeOrder : null,
    v2Meta: options.v2Meta || null,
  };
  trailingStopIntervals.set(checkKey, state);

  await ensureTrailingStopDataDir();

  const dateTimeStr = getDateTimeString();
  const fileName = `${dateTimeStr}_${stockName || stockCode}.json`;
  const filePath = path.join(TRAILING_STOP_DATA_DIR, fileName);
  state.filePath = filePath;
  await savePriceToFile(filePath, dateTimeStr, initialPrice);

  console.log(
    `${sellLog(userId)} 모니터링 시작(WS): ${stockCode} (${stockName}), 차수=${sellStage}차, 초기가격=${initialPrice}, 목표가=${sellXPrice}, trailingPercent=${trailingPercent}%`
  );

  void sendTelegramToUserById(
    userId,
    `📉 Sell Trailing 시작\n${stockName || stockCode} (${stockCode}) ${sellStage}차\n` +
      `시작가 ${formatTelegramPrice(initialPrice, stockMarket)} · 목표 ${formatTelegramPrice(sellXPrice, stockMarket)}\n` +
      `기준 ${trailingPercent}%`
  );

  state.sessionCheckId = setInterval(() => {
    if (!trailingStopIntervals.has(checkKey)) return;
    if (!isSessionOpen(stockMarket)) {
      processSellTrailingTick(checkKey, state, state.curPrice).catch(() => {});
    }
  }, SESSION_CHECK_MS);

  notifySubscribeRefresh();
};

const clearSellTrailingEntry = (checkKey, trailingInfo, reason = '설정 변경·삭제 등으로 중단됨') => {
  if (!trailingInfo) return;
  if (trailingInfo.sessionCheckId) clearInterval(trailingInfo.sessionCheckId);
  trailingStopIntervals.delete(checkKey);
  console.log(
    `${sellLog(trailingInfo.userId)} 모니터링 중지: ${trailingInfo.stockCode}, 차수=${trailingInfo.sellStage}차` +
      (String(checkKey).includes('_v2p') ? ` key=${checkKey}` : '')
  );
  void sendTelegramToUserById(
    trailingInfo.userId,
    `⏹ Sell Trailing 중지\n${trailingInfo.stockName || trailingInfo.stockCode} (${trailingInfo.stockCode}) ${trailingInfo.sellStage}차\n(${reason})`
  );
};

/** 레거시 키 + V2 `_v2p{planId}` 키 모두 중지 */
const stopTrailingStop = (userId, stockCode, sellStage) => {
  const uid = String(userId);
  const code = String(stockCode || '').trim();
  const stage = Number(sellStage);
  const prefix = `${uid}_${code}_${stage}`;
  let stopped = 0;
  for (const [checkKey, info] of [...trailingStopIntervals.entries()]) {
    const matchExact = checkKey === prefix;
    const matchV2 = checkKey.startsWith(`${prefix}_v2p`);
    const matchState =
      String(info.userId) === uid &&
      Number(info.sellStage) === stage &&
      autoCodesMatch(info.stockCode, code, info.stockMarket);
    if (!matchExact && !matchV2 && !matchState) continue;
    clearSellTrailingEntry(checkKey, info);
    stopped += 1;
  }
  if (stopped > 0) notifySubscribeRefresh();
};

/** V2 planId 기준 sell trailing 중지 */
const stopV2SellTrailingsByPlanId = (planId, { silent = false, reason = '플랜 중지·삭제' } = {}) => {
  const pid = Number(planId);
  if (!Number.isFinite(pid) || pid <= 0) return 0;
  let n = 0;
  let sampleUid = null;
  for (const [checkKey, state] of [...trailingStopIntervals.entries()]) {
    const metaPid = state.v2Meta?.planId != null ? Number(state.v2Meta.planId) : null;
    const keyMatch = /_v2p(\d+)$/.exec(String(checkKey));
    const keyPid = keyMatch ? Number(keyMatch[1]) : null;
    if (metaPid !== pid && keyPid !== pid) continue;
    if (state.sessionCheckId) clearInterval(state.sessionCheckId);
    trailingStopIntervals.delete(checkKey);
    n += 1;
    if (sampleUid == null) sampleUid = state.userId;
    if (!silent) {
      void sendTelegramToUserById(
        state.userId,
        `⏹ Sell Trailing 중지\n${state.stockName || state.stockCode} (${state.stockCode}) ${state.sellStage}차\n(${reason})`
      );
    }
  }
  if (n > 0) {
    notifySubscribeRefresh();
    console.log(`${sellLog(sampleUid)} V2 plan=${pid} sell trailing ${n}건 중지`);
  }
  return n;
};

/** 사용자 전체 V2 sell trailing 중지 */
const stopV2SellTrailingsForUser = (userId) => {
  const uid = String(userId);
  let n = 0;
  for (const [checkKey, state] of [...trailingStopIntervals.entries()]) {
    if (String(state.userId) !== uid) continue;
    if (!String(checkKey).includes('_v2p') && !state.v2Meta?.planId) continue;
    if (state.sessionCheckId) clearInterval(state.sessionCheckId);
    trailingStopIntervals.delete(checkKey);
    n += 1;
  }
  if (n > 0) {
    notifySubscribeRefresh();
    console.log(`${sellLog(uid)} V2 sell trailing ${n}건 중지`);
  }
  return n;
};

const stopAllTrailingStops = () => {
  for (const [, trailingInfo] of trailingStopIntervals.entries()) {
    if (trailingInfo.sessionCheckId) clearInterval(trailingInfo.sessionCheckId);
  }
  trailingStopIntervals.clear();
  notifySubscribeRefresh();
  console.log('[Trailing Stop] 모든 모니터링 중지');
};

/** 구독용: userId -> [{ stockCode, stockName, stockMarket }] */
const getActiveSellTrailingSymbols = () => {
  const byUser = new Map();
  for (const state of trailingStopIntervals.values()) {
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
  startTrailingStop,
  stopTrailingStop,
  stopAllTrailingStops,
  trailingStopIntervals,
  onSellTrailingPriceTick,
  getActiveSellTrailingSymbols,
  stopV2SellTrailingsByPlanId,
  stopV2SellTrailingsForUser,
  /** V2 국내 sell trailing 일괄 중지 (정규장 종료 등) */
  stopV2KrSellTrailings() {
    let n = 0;
    for (const [checkKey, state] of [...trailingStopIntervals.entries()]) {
      if (!String(checkKey).includes('_v2p')) continue;
      if (state.stockMarket === 'US') continue;
      if (state.sessionCheckId) clearInterval(state.sessionCheckId);
      trailingStopIntervals.delete(checkKey);
      n += 1;
    }
    if (n > 0) {
      notifySubscribeRefresh();
      console.log(`[Trailing Stop] V2 국내 sell trailing ${n}건 중지`);
    }
    return n;
  },
};

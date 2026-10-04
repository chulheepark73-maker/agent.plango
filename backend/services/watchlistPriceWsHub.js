/**
 * 시세 WebSocket 중계 (관심종목 / 보유 / 대시보드 공용)
 * 경로: /ws/watchlist-prices?token=<JWT>
 *
 * 유저당 키움 WS 1개. 브라우저 소켓마다 구독 목록을 두고 합집합으로 REG.
 */

const { WebSocketServer, WebSocket } = require('ws');
const { verifyAgentToken } = require('../middleware/auth');
const wsRegistry = require('./kiwoomUserWsRegistry');
const { encodeUsRegCode } = require('./kiwoomRealtimeClient');
const kiwoomAPI = require('./kiwoomApi');
const { getKiwoomInfo, normalizeStockCode, createStockCodeMap } = require('../utils/kiwoomUtils');
const { extractPriceData, isNXTTradingHours } = require('../utils/stockUtils');
const {
  addDashboardClient,
  removeDashboardClient,
} = require('./dashboardStatusHub');
const { getUsStockByTicker } = require('../utils/usStockListStore');
const { looksLikeUsTicker } = require('../utils/autoTradingMarket');
const { isNXTStock } = require('../utils/stockListStore');

/** NXT 세션(08:00~08:50) 진입·종료 시 구독 코드(_NX ↔ 6자리) 전환 확인 주기 */
const SESSION_SWITCH_CHECK_MS = 30000;

/** @type {Map<string, UserPriceSession>} */
const sessionsByUser = new Map();

/** 세션이 끊겨도 유지되는 유저별 마지막 시세 (프로세스 생존 동안) */
/** @type {Map<string, Map<string, {stockCode:string, stockName:string, stockMarket:string, price:number, change:number, changeRate:number}>>} */
const lastPricesByUser = new Map();

function getUserLastPrices(userId) {
  let map = lastPricesByUser.get(userId);
  if (!map) {
    map = new Map();
    lastPricesByUser.set(userId, map);
  }
  return map;
}

/** V2 / 지표 WS 모니터 캐시 (있으면 시딩) */
function getAutoTradingCachedPrice(userId, code6) {
  for (const mod of ['./autoTradingWsMonitor_v2', './indicatorWsMonitor']) {
    try {
      const { getLastPrices } = require(mod);
      const row = getLastPrices(userId)?.get(code6);
      if (row && Number(row.price) > 0) return row;
    } catch {
      /* ignore */
    }
  }
  return null;
}

class UserPriceSession {
  constructor(userId) {
    this.userId = userId;
    /** @type {Set<import('ws')>} */
    this.clients = new Set();
    /** @type {Map<import('ws'), Map<string, {stockName:string, stockMarket:string}>>} */
    this.clientSubs = new Map();
    /** @type {Set<import('ws')>} */
    this.dashboardSubs = new Set();
    /** 병합된 메타 (키움 REG용) */
    this.metaByCode = new Map();
    /** 유저 단위 공유 캐시 (세션 destroy와 무관) */
    this.lastPrices = getUserLastPrices(userId);
    /** 캐시 미스 REST 보정 중복 방지 */
    this._restFillInFlight = false;
    this._subSeq = 0;
    this._lastNxtTime = isNXTTradingHours();
    this._sessionTimer = setInterval(() => this._checkSessionSwitch(), SESSION_SWITCH_CHECK_MS);
    if (this._sessionTimer.unref) this._sessionTimer.unref();
    this.kiwoom = wsRegistry.acquire(userId, 'hub', {
      onTick: (tick) => this.broadcastTick(tick),
      onStatus: (info) => this.broadcastJson({ type: 'status', ...info }),
    });
  }

  addClient(ws) {
    this.clients.add(ws);
    this.clientSubs.set(ws, new Map());
  }

  removeClient(ws) {
    if (this.dashboardSubs.has(ws)) {
      this.dashboardSubs.delete(ws);
      removeDashboardClient(this.userId, ws);
    }
    this.clients.delete(ws);
    this.clientSubs.delete(ws);
    if (this.clients.size === 0) {
      clearInterval(this._sessionTimer);
      this._subSeq += 1;
      // 자동매매(auto) 구독자가 있으면 연결은 유지되고 화면용 종목만 해제된다
      wsRegistry.release(this.userId, 'hub');
      sessionsByUser.delete(this.userId);
      return;
    }
    this._rebuildMerged();
  }

  setDashboardSubscribe(ws, enabled) {
    if (enabled) {
      this.dashboardSubs.add(ws);
      addDashboardClient(this.userId, ws);
    } else {
      this.dashboardSubs.delete(ws);
      removeDashboardClient(this.userId, ws);
    }
  }

  /**
   * 해당 브라우저 소켓의 구독 목록 교체 후, 유저 전체 합집합으로 키움 REG
   * @param {import('ws')} ws
   * @param {Array<{stockCode?:string, code?:string, stockName?:string, stockMarket?:string}>} items
   */
  setClientSymbols(ws, items) {
    const list = Array.isArray(items) ? items : [];
    const map = new Map();
    for (const item of list) {
      const market = String(item.stockMarket || item.market || 'KRX').toUpperCase();
      const isUs = market === 'US';
      const rawCode = String(item.stockCode || item.code || '').trim();
      const code = isUs
        ? rawCode.toUpperCase()
        : rawCode.substring(0, 6).trim();
      if (!code) continue;
      map.set(code, {
        stockName: item.stockName || '',
        stockMarket: isUs ? 'US' : item.stockMarket || 'KRX',
        stexTp: item.stexTp || item.exchange || null,
      });
    }
    this.clientSubs.set(ws, map);
    this._rebuildMerged();
    // 구독 직후 캐시된 마지막 시세를 해당 소켓에만 즉시 전송 (틱 대기 없이 UI 채움)
    this.pushCachedPricesToClient(ws, map);
    // 캐시 미스 종목만 REST 1회 보정 (첫 진입·서버 재시작 등)
    this.fillMissingPricesFromRest(ws, map).catch((err) => {
      if (err?.isRateLimit || err?.status === 429) return;
      console.error(`[PricesWS][${this.userId}] REST 시세 보정 실패:`, err.message || err);
    });
  }

  /**
   * hub 캐시 → 자동매매 모니터 캐시 순으로 조회
   * @param {string} code6
   */
  lookupCachedPrice(code6) {
    const key = String(code6 || '');
    const local = this.lastPrices.get(key) || this.lastPrices.get(key.toUpperCase());
    if (local && Number(local.price) > 0) return local;
    // 국내 6자리 캐시 (자동매매 모니터)
    const codeKr = key.substring(0, 6);
    const fromAt = getAutoTradingCachedPrice(this.userId, codeKr);
    if (fromAt && !looksLikeUsTicker(key)) {
      this.lastPrices.set(codeKr, {
        stockCode: codeKr,
        stockName: fromAt.stockName || '',
        stockMarket: fromAt.stockMarket || 'KRX',
        price: fromAt.price,
        change: fromAt.change,
        changeRate: fromAt.changeRate,
      });
      return this.lastPrices.get(codeKr);
    }
    return null;
  }

  /**
   * @param {import('ws')} ws
   * @param {Map<string, {stockName:string, stockMarket:string}>} codeMap
   */
  pushCachedPricesToClient(ws, codeMap) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !codeMap?.size) return;
    for (const [code, meta] of codeMap) {
      const cached = this.lookupCachedPrice(code);
      if (!cached || !(Number(cached.price) > 0)) continue;
      const payload = {
        type: 'price',
        data: {
          stockCode: code,
          stockName: meta.stockName || cached.stockName || '',
          stockMarket: meta.stockMarket || cached.stockMarket || 'KRX',
          price: cached.price,
          change: cached.change,
          changeRate: cached.changeRate,
        },
      };
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 캐시에 없는 종목만 ka10095 배치 1회로 채운 뒤 해당 소켓에 push
   * @param {import('ws')} ws
   * @param {Map<string, {stockName:string, stockMarket:string}>} codeMap
   */
  async fillMissingPricesFromRest(ws, codeMap) {
    if (!ws || !codeMap?.size) return;

    if (this._restFillInFlight) {
      this._restFillPending = { ws, codeMap };
      return;
    }

    const missing = [];
    for (const [code, meta] of codeMap) {
      if (this.lookupCachedPrice(code)) continue;
      missing.push({ code, ...meta });
    }
    if (missing.length === 0) return;

    this._restFillInFlight = true;
    try {
      const kiwoomInfo = await getKiwoomInfo(this.userId);
      if (!kiwoomInfo?.accessToken) return;

      const isNXTTime = isNXTTradingHours();
      const krxCodes = [];
      const nxtCodes = [];
      const usCodes = [];
      for (const item of missing) {
        if (item.stockMarket === 'US') {
          usCodes.push(item);
        } else if (
          isNXTTime &&
          (item.stockMarket === 'NXT' || (await isNXTStock(String(item.code))))
        ) {
          nxtCodes.push(item);
        } else {
          krxCodes.push(item);
        }
      }

      if (usCodes.length > 0) {
        try {
          const quotes = await kiwoomAPI.getUsStockQuotes(
            kiwoomInfo.accessToken,
            usCodes.map((i) => i.code),
            null
          );
          const quoteByCode = new Map(
            (quotes || []).map((q) => [String(q.stockCode).toUpperCase(), q])
          );
          for (const item of usCodes) {
            const code = String(item.code || '').toUpperCase();
            const quote = quoteByCode.get(code);
            if (!quote || !(Number(quote.price) > 0)) continue;
            const data = {
              stockCode: item.code,
              stockName: item.stockName || quote.stockName || '',
              stockMarket: 'US',
              price: quote.price,
              change: quote.change,
              changeRate: quote.changeRate,
            };
            this.lastPrices.set(item.code, data);
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({ type: 'price', data }));
              } catch {
                /* ignore */
              }
            }
          }
        } catch (err) {
          console.warn(
            `[PricesWS][${this.userId}] US REST 시세 배치 실패:`,
            err.message || err
          );
        }
      }

      const applyBatch = async (items, exchange, codeTransform) => {
        if (!items.length) return;
        const stockCodeStr = items.map((i) => codeTransform(i.code)).join('|');
        const stockInfo = await kiwoomAPI.getStockInfo(
          kiwoomInfo.accessToken,
          kiwoomInfo.appKey,
          kiwoomInfo.appSecret,
          stockCodeStr,
          'N',
          '',
          exchange
        );
        if (stockInfo?.return_code !== 0 || !stockInfo?.atn_stk_infr?.length) return;
        const infoMap = createStockCodeMap(stockInfo.atn_stk_infr);
        for (const item of items) {
          const searchCode = normalizeStockCode(item.code);
          const info = infoMap.get(searchCode) || infoMap.get(searchCode.substring(0, 6));
          if (!info) continue;
          const { price, change, changeRate } = extractPriceData({ atn_stk_infr: [info] });
          if (!(Number(price) > 0)) continue;
          const data = {
            stockCode: item.code,
            stockName: item.stockName || '',
            stockMarket: item.stockMarket || exchange || 'KRX',
            price,
            change,
            changeRate,
          };
          this.lastPrices.set(item.code, data);
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: 'price', data }));
            } catch {
              /* ignore */
            }
          }
        }
      };

      await applyBatch(krxCodes, 'KRX', (c) => c);
      await applyBatch(nxtCodes, 'NXT', (c) => `${String(c).substring(0, 6)}_NX`);
    } finally {
      this._restFillInFlight = false;
      if (this._restFillPending) {
        const pending = this._restFillPending;
        this._restFillPending = null;
        this.fillMissingPricesFromRest(pending.ws, pending.codeMap).catch(() => {});
      }
    }
  }

  /** @deprecated 단일 클라이언트용 — setClientSymbols 사용 */
  setWatchlist(items) {
    const ws = this.clients.values().next().value;
    if (ws) this.setClientSymbols(ws, items);
  }

  _rebuildMerged() {
    this.metaByCode.clear();
    for (const sub of this.clientSubs.values()) {
      for (const [code, meta] of sub) {
        const prev = this.metaByCode.get(code);
        if (!prev) {
          this.metaByCode.set(code, { ...meta });
        } else {
          const market =
            prev.stockMarket === 'US' || meta.stockMarket === 'US'
              ? 'US'
              : prev.stockMarket === 'NXT' || meta.stockMarket === 'NXT'
                ? 'NXT'
                : prev.stockMarket || meta.stockMarket || 'KRX';
          this.metaByCode.set(code, {
            stockName: prev.stockName || meta.stockName || '',
            stockMarket: market,
            stexTp: prev.stexTp || meta.stexTp || null,
          });
        }
      }
    }

    this._applySubscriptions().catch((err) => {
      console.error(`[PricesWS][${this.userId}] REG 구독 실패:`, err.message || err);
    });
  }

  /**
   * 키움 REG 코드 구성: 08:00~08:50 NXT 가능 종목(stock_list_nxt) → 코드_NX, 그 외 국내 → 6자리,
   * 미국 → US|TICKER|STEX
   */
  async _applySubscriptions() {
    const seq = ++this._subSeq;
    const isNXTTime = isNXTTradingHours();
    this._lastNxtTime = isNXTTime;
    const entries = [...this.metaByCode.entries()];
    const codes = [];
    for (const [code, meta] of entries) {
      if (meta.stockMarket === 'US') {
        let stex = meta.stexTp;
        if (!stex) {
          try {
            const master = await getUsStockByTicker(code);
            stex = master?.exchange || 'ND';
          } catch {
            stex = 'ND';
          }
        }
        const encoded = encodeUsRegCode(code, stex);
        if (encoded) codes.push(encoded);
        continue;
      }
      const code6 = String(code).substring(0, 6);
      const useNx =
        isNXTTime && (meta.stockMarket === 'NXT' || (await isNXTStock(code6)));
      codes.push(useNx ? `${code6}_NX` : code6);
    }
    if (seq !== this._subSeq || this.clients.size === 0) return;
    wsRegistry.setSymbols(this.userId, 'hub', codes, wsRegistry.PRIORITY.DISPLAY);
    if (codes.length === 0) {
      this.broadcastJson({ type: 'status', status: 'idle', message: '구독 종목 없음' });
    }
  }

  _checkSessionSwitch() {
    if (this.clients.size === 0 || this.metaByCode.size === 0) return;
    if (isNXTTradingHours() === this._lastNxtTime) return;
    this._applySubscriptions().catch((err) => {
      console.error(`[PricesWS][${this.userId}] 세션 전환 재구독 실패:`, err.message || err);
    });
  }

  broadcastTick(tick) {
    const rawCode = String(tick.stockCode || '').trim();
    const isUsTicker = looksLikeUsTicker(rawCode);
    const codeKey = isUsTicker ? rawCode.toUpperCase() : rawCode.substring(0, 6);
    const meta = this.metaByCode.get(codeKey) || this.metaByCode.get(tick.stockCode) || {};
    let stockName = meta.stockName || '';
    let stockMarket = meta.stockMarket || (isUsTicker ? 'US' : 'KRX');
    if (!stockName) {
      for (const [code, m] of this.metaByCode) {
        if (
          code === codeKey ||
          code === tick.stockCode ||
          (!isUsTicker && (code.startsWith(codeKey) || codeKey.startsWith(code)))
        ) {
          stockName = m.stockName;
          stockMarket = m.stockMarket;
          break;
        }
      }
    }

    const data = {
      stockCode: codeKey || tick.stockCode,
      stockName,
      stockMarket,
      price: tick.price,
      change: tick.change,
      changeRate: tick.changeRate,
    };

    if (codeKey && Number(data.price) > 0) {
      this.lastPrices.set(codeKey, data);
    }

    this.broadcastJson({
      type: 'price',
      data,
    });
  }

  broadcastJson(obj) {
    const raw = JSON.stringify(obj);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(raw);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function getOrCreateSession(userId) {
  let session = sessionsByUser.get(userId);
  if (!session) {
    session = new UserPriceSession(userId);
    sessionsByUser.set(userId, session);
  }
  return session;
}

async function authenticateWsToken(token) {
  return verifyAgentToken(token);
}

/**
 * @param {import('http').Server} server
 */
function attachWatchlistPriceWebSocket(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws/watchlist-prices',
  });

  wss.on('connection', async (ws, req) => {
    let userId = null;
    let session = null;

    try {
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const token = parsed.searchParams.get('token');
      const user = await authenticateWsToken(token);
      userId = user.userId;
      session = getOrCreateSession(userId);
      session.addClient(ws);
      ws.send(JSON.stringify({ type: 'status', status: 'connected' }));
    } catch (err) {
      try {
        ws.send(JSON.stringify({ type: 'status', status: 'error', message: err.message, code: err.code }));
      } catch {
        /* ignore */
      }
      ws.close(4401, err.message);
      return;
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (
        msg.type === 'set_watchlist' ||
        msg.type === 'set_holdings' ||
        msg.type === 'set_symbols' ||
        msg.type === 'subscribe'
      ) {
        session.setClientSymbols(ws, msg.items || msg.watchlist || msg.holdings || []);
      } else if (msg.type === 'subscribe_dashboard' || msg.type === 'unsubscribe_dashboard') {
        session.setDashboardSubscribe(ws, msg.type === 'subscribe_dashboard');
      } else if (msg.type === 'ping') {
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          /* ignore */
        }
      }
    });

    ws.on('close', () => {
      if (session) session.removeClient(ws);
    });

    ws.on('error', (err) => {
      console.error(`[PricesWS][${userId}] 클라이언트 오류:`, err.message);
    });
  });

  console.log('[PricesWS] /ws/watchlist-prices 대기 중 (watchlist/holdings/dashboard + status push)');
  return wss;
}

module.exports = {
  attachWatchlistPriceWebSocket,
  /** 조건검색 등 — 로그인된 관심종목 시세 키움 WS 재사용 */
  getConnectedRealtimeClient(userId) {
    const session =
      sessionsByUser.get(userId) ||
      sessionsByUser.get(String(userId)) ||
      sessionsByUser.get(Number(userId));
    if (session?.kiwoom?.isConnected?.()) return session.kiwoom;
    return null;
  },
  /**
   * hub lastPrices → 자동매매 lastPrices 순으로 조회
   * @returns {{stockCode, stockName, stockMarket, price, change, changeRate}|null}
   */
  lookupLastPrice(userId, stockCode) {
    const raw = String(stockCode || '').trim();
    if (!raw) return null;
    const isUs = looksLikeUsTicker(raw);
    const codeKey = isUs ? raw.toUpperCase() : raw.substring(0, 6);
    if (!codeKey) return null;
    const uid = String(userId);
    const local = getUserLastPrices(uid).get(codeKey);
    if (local && Number(local.price) > 0) {
      return { ...local, stockCode: codeKey };
    }
    const fromAt = getAutoTradingCachedPrice(uid, codeKey);
    if (fromAt && Number(fromAt.price) > 0) {
      return {
        stockCode: codeKey,
        stockName: fromAt.stockName || '',
        stockMarket: fromAt.stockMarket || (isUs ? 'US' : 'KRX'),
        price: fromAt.price,
        change: fromAt.change,
        changeRate: fromAt.changeRate,
      };
    }
    return null;
  },
  /** REST/시드 결과를 Map에 넣어 이후 장외 조회에 재사용 */
  setLastPrice(userId, row) {
    const raw = String(row?.stockCode || '').trim();
    if (!raw || !(Number(row.price) > 0)) return;
    const isUs = row.stockMarket === 'US' || looksLikeUsTicker(raw);
    const codeKey = isUs ? raw.toUpperCase() : raw.substring(0, 6);
    if (!codeKey) return;
    const uid = String(userId);
    getUserLastPrices(uid).set(codeKey, {
      stockCode: codeKey,
      stockName: row.stockName || '',
      stockMarket: isUs ? 'US' : row.stockMarket || 'KRX',
      price: Number(row.price),
      change: Number(row.change) || 0,
      changeRate: Number(row.changeRate) || 0,
    });
  },
  /**
   * 장외 등 — REST 없이 Map 캐시만으로 시세 행 구성
   * @param {string|number} userId
   * @param {string[]} stockCodes
   * @param {{ stockNameMap?: Map<string,string>, marketByCode?: Map<string,string> }} [opts]
   */
  buildPriceRowsFromLastPrices(userId, stockCodes, opts = {}) {
    const nameMap = opts.stockNameMap || new Map();
    const marketByCode = opts.marketByCode || new Map();
    const unique = [];
    const seen = new Set();
    for (const c of stockCodes || []) {
      const raw = String(c || '').trim();
      if (!raw) continue;
      const hinted = marketByCode.get(raw) || marketByCode.get(raw.toUpperCase());
      const isUs = hinted === 'US' || looksLikeUsTicker(raw);
      const codeKey = isUs ? raw.toUpperCase() : raw.substring(0, 6);
      if (!codeKey || seen.has(codeKey)) continue;
      seen.add(codeKey);
      unique.push(codeKey);
    }
    return unique.map((codeKey) => {
      const cached = module.exports.lookupLastPrice(userId, codeKey);
      const stockMarket =
        marketByCode.get(codeKey) || cached?.stockMarket || (looksLikeUsTicker(codeKey) ? 'US' : 'KRX');
      const stockName =
        nameMap.get(codeKey) ||
        nameMap.get(cached?.stockCode) ||
        cached?.stockName ||
        codeKey;
      if (cached && Number(cached.price) > 0) {
        return {
          stockCode: codeKey,
          stockName,
          stockMarket,
          price: cached.price,
          change: cached.change ?? 0,
          changeRate: cached.changeRate ?? 0,
          source: 'lastPrices',
        };
      }
      return {
        stockCode: codeKey,
        stockName,
        stockMarket,
        price: 0,
        change: 0,
        changeRate: 0,
        source: 'lastPrices',
      };
    });
  },
};

/**
 * 키움 REST API 실시간 WebSocket 클라이언트 (유저별 1연결)
 * LOGIN → REG(0B 시세 / 00 주문체결) → REAL 수신, PING echo, 재연결
 */

const WebSocket = require('ws');
const { getKiwoomWsUrl } = require('../utils/kiwoomMode');

/** LOGIN·REG 직후 CNSRREQ 전송 전 최소 대기 (ms) */
const CNSRREQ_AFTER_LOGIN_MS = 1500;
const CNSRREQ_AFTER_REG_MS = 1500;
/** CNSRREQ 타임아웃이 이 횟수 연속이면 WS soft-reconnect */
const CNSRREQ_MAX_CONSECUTIVE_TIMEOUTS = 3;
/** REG ACK 대기 상한 (ms) */
const REG_ACK_TIMEOUT_MS = 5000;

/** 키움이 전 세션에 브로드캐스트하는 시장 공지 (오류 아님 → pending TR 거부하지 않음) */
const SYSTEM_NOTICE_PATTERN = /거래정지|지정\/제개|지정\/해제|VI\s*발동|VI\s*해제|단일가|서킷브레이커|사이드카/;

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

const resolveKiwoomWsUrl = getKiwoomWsUrl;

function parseKiwoomNumber(raw) {
  if (raw == null || raw === '') return 0;
  const n = parseFloat(String(raw).replace(/,/g, '').replace(/^\+/, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseAbsPrice(raw) {
  return Math.abs(parseKiwoomNumber(raw));
}

/**
 * REG 구독용 종목코드 정규화
 * - KRX: 6자리
 * - NXT: 6자리_NX (접미사 유지)
 * - US: US|TICKER|STEX (예: US|NVDA|ND)
 */
function encodeUsRegCode(ticker, stexTp = 'ND') {
  const jm = String(ticker || '')
    .trim()
    .toUpperCase()
    .replace(/^US\|/, '')
    .split('|')[0];
  if (!jm) return '';
  const stex = normalizeUsStexTp(stexTp);
  return `US|${jm}|${stex}`;
}

function isUsRegCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .startsWith('US|');
}

function decodeUsRegCode(raw) {
  const parts = String(raw || '')
    .trim()
    .split('|');
  if (parts.length < 2 || parts[0].toUpperCase() !== 'US') return null;
  return {
    jmcode: String(parts[1] || '')
      .trim()
      .toUpperCase(),
    stex_tp: normalizeUsStexTp(parts[2] || 'ND'),
  };
}

/** stex_tp: NA AMEX, ND NASDAQ, NY NYSE */
function normalizeUsStexTp(raw) {
  const s = String(raw || '')
    .trim()
    .toUpperCase();
  if (!s || s === '%') return 'ND';
  if (s === 'ND' || s === 'NASDAQ' || s === 'NAS' || s === 'NSDQ') return 'ND';
  if (s === 'NY' || s === 'NYSE' || s === 'NYS') return 'NY';
  if (s === 'NA' || s === 'AMEX' || s === 'AMS' || s === 'AMEX') return 'NA';
  if (s.length <= 3) return s;
  return 'ND';
}

function normalizeRegCode(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (isUsRegCode(s)) {
    const decoded = decodeUsRegCode(s);
    return decoded ? encodeUsRegCode(decoded.jmcode, decoded.stex_tp) : '';
  }
  // 이미 US| 없이 미국 티커만 온 경우는 setSymbols에서 encodeUsRegCode 사용
  s = s.replace(/^[*A]/i, '');
  const upper = s.toUpperCase();
  if (upper.includes('_NX')) {
    const code6 = upper.replace(/_NX.*$/, '').replace(/[^0-9A-Z]/g, '').substring(0, 6);
    return code6 ? `${code6}_NX` : '';
  }
  return s.substring(0, 6);
}

/**
 * 틱/주문 종목코드 → 화면용 코드
 * - 국내: 6자리
 * - 미국: 티커 전체 (대문자)
 */
function toBaseStockCode(raw) {
  let s = String(raw || '')
    .replace(/^A/i, '')
    .trim();
  if (!s) return '';
  if (isUsRegCode(s)) {
    return decodeUsRegCode(s)?.jmcode || '';
  }
  // 미국 티커 (첫 글자 영문, _NX 아님). 0011T0 등 국내 영문포함 코드 제외
  if (/[A-Za-z]/.test(s.charAt(0)) && !/_NX/i.test(s)) {
    return s.split('|')[0].replace(/[^A-Za-z0-9.]/g, '').toUpperCase();
  }
  return s
    .replace(/_[A-Z0-9]+$/i, '')
    .trim()
    .substring(0, 6);
}

function normalizeOrderNo(raw) {
  if (raw == null || raw === '') return '';
  return String(raw).replace(/^0+/, '') || '0';
}

/**
 * REAL 0B / FE values → { stockCode, price, change, changeRate }
 */
function parseTradeTick(item, values) {
  if (!values || typeof values !== 'object') return null;
  const stockCode = toBaseStockCode(
    item || values['9001'] || values['종목코드'] || values.stk_cd || values.jmcode || values.symb || ''
  );
  if (!stockCode) return null;

  const price = parseAbsPrice(
    values['10'] ?? values.cur_prc ?? values.last ?? values.price
  );
  if (!price) return null;

  const change = parseKiwoomNumber(values['11'] ?? values.pred_pre ?? values.change);
  const changeRate = parseKiwoomNumber(values['12'] ?? values.flu_rt ?? values.changeRate);

  return { stockCode, price, change, changeRate };
}

/**
 * 주문체결(00) 체결단가 — 현재가(FID 10 / cur_prc)는 절대 쓰지 않음
 * (과거 버그: 10을 우선해 filled_price에 현재가가 들어감)
 */
function pickOrderFillPrice(v) {
  const candidates = [
    ['910', v['910']], // 체결가
    ['914', v['914']], // 단위체결가
    ['cntr_uv', v.cntr_uv],
    ['exec_uv', v.exec_uv],
    ['exec_prc', v.exec_prc],
    ['체결가', v['체결가']],
    ['단위체결가', v['단위체결가']],
    ['ord_uv', v.ord_uv],
    ['주문가격', v['주문가격']],
    ['901', v['901']], // 주문가격
  ];
  for (const [source, raw] of candidates) {
    const price = parseAbsPrice(raw);
    if (price > 0) return { price, source };
  }
  return { price: 0, source: null };
}

/**
 * 조건검색 실시간 REAL — 편입/이탈 (FID 843, 9001)
 */
function parseConditionRealtimeEvent(row, values) {
  const v = values && typeof values === 'object' ? values : {};
  const insertDelete = v['843'] ?? v.insert_delete ?? v['삽입삭제'];
  if (insertDelete == null || insertDelete === '') return null;

  const stockCode = toBaseStockCode(
    v['9001'] ?? v.stk_cd ?? v.jmcode ?? row?.item ?? row?.name ?? ''
  );
  if (!stockCode) return null;

  const flag = String(insertDelete).trim().toUpperCase();
  let action = null;
  if (flag === 'I' || flag === '1' || flag === '2' || flag.includes('편입') || flag.includes('INSERT')) {
    action = 'enter';
  } else if (
    flag === 'D' ||
    flag === '0' ||
    flag === '3' ||
    flag.includes('이탈') ||
    flag.includes('DELETE')
  ) {
    action = 'exit';
  }
  if (!action) return null;

  const priceRaw = parseKiwoomNumber(v['10'] ?? v.cur_prc ?? v.price);
  return {
    stockCode,
    stockName: String(v['302'] ?? v.stk_nm ?? v.stockName ?? '').trim(),
    action,
    price: priceRaw != null ? Math.abs(priceRaw) : null,
    signalType: v['841'] ?? null,
  };
}

/**
 * REAL 00 주문체결 → 정규화 이벤트
 * FID/필드명은 환경에 따라 달라 넓게 매핑
 */
function parseOrderFillEvent(row, values) {
  const v = values && typeof values === 'object' ? values : {};
  const item = row?.item || row?.jmcode || row?.stk_cd || '';

  const stockCode = toBaseStockCode(
    item || v['9001'] || v['종목코드'] || v.stk_cd || v.stockCode || ''
  );

  const orderNoRaw =
    v['9203'] ??
    v['9201'] ??
    v.ord_no ??
    v.order_no ??
    v.orderNo ??
    v['주문번호'] ??
    '';
  const orderNo = String(orderNoRaw || '').trim();
  if (!orderNo) return null;

  // FID(주문체결): 910=체결가, 911=체결량, 914=단위체결가, 915=단위체결량, 901=주문가격
  // FID 10 / cur_prc = 현재가 — 체결단가(filled_price)에 절대 사용 금지
  const execQty = Math.abs(
    parseKiwoomNumber(
      v.cntr_qty ??
        v.exec_qty ??
        v.filled_qty ??
        v['체결수량'] ??
        v['911'] ??
        v['915'] ??
        0
    )
  );
  const orderQty = Math.abs(
    parseKiwoomNumber(v['900'] ?? v.ord_qty ?? v.order_qty ?? v['주문수량'] ?? 0)
  );
  const unexecQty = Math.abs(
    parseKiwoomNumber(
      v['902'] ?? v['917'] ?? v.oso_qty ?? v.unexec_qty ?? v['미체결수량'] ?? NaN
    )
  );
  const { price: execPrice, source: execPriceSource } = pickOrderFillPrice(v);

  const sideRaw = String(v['905'] ?? v['907'] ?? v.io_tp_nm ?? v.side ?? v['주문구분'] ?? '').toLowerCase();
  let side = null;
  if (sideRaw.includes('매도') || sideRaw.includes('sell') || sideRaw === '1') side = 'sell';
  if (sideRaw.includes('매수') || sideRaw.includes('buy') || sideRaw === '2') side = 'buy';

  const fullyFilled =
    (Number.isFinite(unexecQty) && unexecQty === 0 && execQty > 0) ||
    (orderQty > 0 && execQty >= orderQty) ||
    (execQty > 0 && !Number.isFinite(unexecQty) && orderQty === 0);

  return {
    stockCode: stockCode || null,
    orderNo,
    orderNoNorm: normalizeOrderNo(orderNo),
    execQty,
    orderQty,
    unexecQty: Number.isFinite(unexecQty) ? unexecQty : null,
    execPrice,
    execPriceSource,
    side,
    fullyFilled,
    raw: v,
  };
}

class KiwoomRealtimeClient {
  /**
   * @param {object} opts
   * @param {string} opts.userId
   * @param {() => Promise<string|null>} opts.getAccessToken
   * @param {(tick: {stockCode,price,change,changeRate}) => void} [opts.onTick]
   * @param {(evt: ReturnType<typeof parseOrderFillEvent>) => void} [opts.onOrder]
   * @param {(evt: ReturnType<typeof parseConditionRealtimeEvent>) => void} [opts.onCondition]
   * @param {(info: {status:string, message?:string}) => void} [opts.onStatus]
   */
  constructor({ userId, getAccessToken, onTick, onOrder, onCondition, onStatus }) {
    this.userId = userId;
    this.getAccessToken = getAccessToken;
    this.onTick = onTick || (() => {});
    this.onOrder = onOrder || (() => {});
    this.onCondition = onCondition || (() => {});
    this.onStatus = onStatus || (() => {});

    this.ws = null;
    this.desiredCodes = new Set();
    this.registeredCodes = new Set();
    this.orderFillsEnabled = false;
    /** @type {{ seq: string, stexTp: string, active: boolean, desired: boolean }} */
    this.conditionRealtime = { seq: '', stexTp: 'K', active: false, desired: false };
    this._conditionSubscribePromise = null;
    /** CNSRREQ 응답 타임아웃 등으로 서버 등록 여부를 알 수 없는 상태 */
    this._conditionRegistrationUncertain = false;
    this._lastLoginAt = 0;
    this._lastRegAt = 0;
    this._regQuietAfter = 0;
    this._registeredOrderFills = false;
    this._cnsrreqConsecutiveTimeouts = 0;
    this._conditionRetryAfter = 0;
    /** REG/CNSRREQ/CNSRLST/CNSRCLR 송신 직렬화 */
    this._outboundChain = Promise.resolve();
    this._pendingRegAck = null;
    this._regAckTimer = null;
    this.loggedIn = false;
    this.destroyed = false;
    this.reconnectDelayMs = 1000;
    this.reconnectTimer = null;
    this.silenceTimer = null;
    this.SILENCE_MS = 90000;
    /** @type {Array<{ matchTrnm: string, resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this._pendingTrs = [];
    /** 조건검색 one-shot 동안 재연결 억제 */
    this.reconnectPausedUntil = 0;
  }

  isConnected() {
    return !!(this.loggedIn && this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  /** 지정 시간 동안 자동 재연결하지 않음 */
  pauseReconnect(ms = 30000) {
    this.reconnectPausedUntil = Date.now() + Math.max(0, ms);
  }

  /** 소켓만 닫고 재연결은 pauseReconnect에 따름 */
  softDisconnect() {
    this.loggedIn = false;
    this.registeredCodes.clear();
    this._registeredOrderFills = false;
    this._resolveRegAck();
    this._outboundChain = Promise.resolve();
    this._markConditionDisconnected();
    this._clearSilence();
    this._rejectPendingTrs(new Error('키움 WebSocket이 일시 중단되었습니다.'));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  /** CNSRREQ 연속 타임아웃 시 반죽 WS 복구 — close 핸들러가 재연결을 스케줄한다 */
  _recoverFromCnsrreqFailures() {
    console.warn(
      `[키움WS][${this.userId}] CNSRREQ 연속 ${CNSRREQ_MAX_CONSECUTIVE_TIMEOUTS}회 타임아웃 — WS 재연결 시도`
    );
    this._conditionRegistrationUncertain = true;
    this._cnsrreqConsecutiveTimeouts = 0;
    this.softDisconnect();
  }

  getConditionRetryAfter() {
    return this._conditionRetryAfter || 0;
  }

  _runOutbound(fn) {
    const task = this._outboundChain.then(() => fn());
    this._outboundChain = task.catch(() => {});
    return task;
  }

  _resolveRegAck() {
    if (this._regAckTimer) {
      clearTimeout(this._regAckTimer);
      this._regAckTimer = null;
    }
    if (!this._pendingRegAck) return;
    const done = this._pendingRegAck;
    this._pendingRegAck = null;
    done();
  }

  _waitRegAck(timeoutMs = REG_ACK_TIMEOUT_MS) {
    return new Promise((resolve) => {
      this._resolveRegAck();
      this._pendingRegAck = resolve;
      this._regAckTimer = setTimeout(() => {
        this._regAckTimer = null;
        this._pendingRegAck = null;
        resolve();
      }, timeoutMs);
    });
  }

  _markRegQuiet() {
    this._regQuietAfter = Date.now();
  }

  /** LOGIN·REG 직후 CNSRREQ가 겹치지 않도록 대기 */
  async _waitBeforeConditionRegister() {
    const now = Date.now();
    const sinceLogin = now - (this._lastLoginAt || 0);
    if (sinceLogin < CNSRREQ_AFTER_LOGIN_MS) {
      await new Promise((r) => setTimeout(r, CNSRREQ_AFTER_LOGIN_MS - sinceLogin));
    }
    const sinceReg = Date.now() - (this._regQuietAfter || 0);
    if (sinceReg < CNSRREQ_AFTER_REG_MS) {
      await new Promise((r) => setTimeout(r, CNSRREQ_AFTER_REG_MS - sinceReg));
    }
  }

  /**
   * 기존 로그인된 WS로 TR 1회 요청 후 응답 대기 (조건검색 등)
   * @param {object} payload
   * @param {{ matchTrnm?: string, timeoutMs?: number }} [opts]
   */
  requestTr(payload, opts = {}) {
    return this._runOutbound(() => this._requestTrInner(payload, opts));
  }

  _requestTrInner(payload, opts = {}) {
    const matchTrnm = String(opts.matchTrnm || payload?.trnm || '').trim();
    const timeoutMs = opts.timeoutMs || 20000;
    const accept =
      typeof opts.accept === 'function'
        ? opts.accept
        : (msg) => {
            // CNSRREQ/CNSRLST는 return_code가 있는 최종 응답만 인정 (중간/빈 프레임 무시)
            if (matchTrnm === 'CNSRREQ' || matchTrnm === 'CNSRLST') {
              return msg.return_code != null && msg.return_code !== '';
            }
            return true;
          };

    const run = async () => {
      if (matchTrnm === 'CNSRREQ' || matchTrnm === 'CNSRLST') {
        await this._waitBeforeConditionRegister();
      }

      return new Promise((resolve, reject) => {
        if (!this.isConnected()) {
          reject(new Error('키움 WS가 연결되어 있지 않습니다.'));
          return;
        }
        if (!matchTrnm) {
          reject(new Error('요청 trnm이 없습니다.'));
          return;
        }

        const pending = {
          matchTrnm,
          accept,
          resolve: null,
          reject: null,
          timer: null,
        };

        pending.timer = setTimeout(() => {
          this._pendingTrs = this._pendingTrs.filter((p) => p !== pending);
          reject(new Error(`키움 WebSocket 요청 시간이 초과되었습니다. (${matchTrnm})`));
        }, timeoutMs);

        pending.resolve = (msg) => {
          clearTimeout(pending.timer);
          this._pendingTrs = this._pendingTrs.filter((p) => p !== pending);
          resolve(msg);
        };
        pending.reject = (err) => {
          clearTimeout(pending.timer);
          this._pendingTrs = this._pendingTrs.filter((p) => p !== pending);
          reject(err instanceof Error ? err : new Error(String(err)));
        };

        this._pendingTrs.push(pending);
        try {
          this.ws.send(JSON.stringify(payload));
        } catch (e) {
          pending.reject(e);
        }
      });
    };

    return run();
  }

  _rejectPendingTrs(err) {
    const list = this._pendingTrs.splice(0, this._pendingTrs.length);
    for (const p of list) {
      try {
        p.reject(err);
      } catch {
        /* ignore */
      }
    }
  }

  setSymbols(codes) {
    const next = new Set(
      (codes || [])
        .map((c) => normalizeRegCode(c))
        .filter(Boolean)
    );
    this.desiredCodes = next;
    if (this.loggedIn && this.ws?.readyState === WebSocket.OPEN) {
      this._syncRegistration();
    } else if (this._shouldStayConnected()) {
      this.connect();
    }
  }

  setOrderFillsEnabled(enabled) {
    this.orderFillsEnabled = !!enabled;
    if (this.loggedIn && this.ws?.readyState === WebSocket.OPEN) {
      this._syncRegistration();
    } else if (this._shouldStayConnected()) {
      this.connect();
    }
  }

  _shouldStayConnected() {
    return (
      this.desiredCodes.size > 0 ||
      this.orderFillsEnabled ||
      this.conditionRealtime?.desired
    );
  }

  _markConditionDisconnected() {
    const cr = this.conditionRealtime || {};
    this.conditionRealtime = {
      seq: cr.seq || '',
      stexTp: cr.stexTp || 'K',
      active: false,
      desired: !!cr.desired,
    };
    this._conditionSubscribePromise = null;
    // 연결이 끊기면 서버 측 조건검색 등록도 함께 해제된다
    this._conditionRegistrationUncertain = false;
  }

  isConditionRealtimeSubscribing() {
    return !!this._conditionSubscribePromise;
  }

  isConditionRealtimeActive() {
    return !!(
      this.isConnected() &&
      this.conditionRealtime?.active &&
      this.conditionRealtime.seq
    );
  }

  wantsConditionRealtime() {
    return !!(this.conditionRealtime?.desired && this.conditionRealtime.seq);
  }

  getConditionRealtimeSeq() {
    if (!this.isConditionRealtimeActive()) return '';
    return String(this.conditionRealtime.seq || '');
  }

  getConditionRealtimeDesiredSeq() {
    if (!this.conditionRealtime?.desired) return '';
    return String(this.conditionRealtime.seq || '');
  }

  /**
   * 조건검색 실시간 구독 (CNSRREQ search_type=1)
   * @param {string} seq
   * @param {string} [stexTp]
   * @param {{ force?: boolean }} [opts] force=true: 기존 등록 CLR 후 재구독(당일 스냅샷 강제)
   * @returns {Promise<object>} 초기 스냅샷 응답
   */
  async subscribeConditionRealtime(seq, stexTp = 'K', opts = {}) {
    const apiSeq = String(seq ?? '').trim();
    if (!apiSeq) throw new Error('조건검색식 일련번호가 없습니다.');
    if (!this.isConnected()) throw new Error('키움 WS가 연결되어 있지 않습니다.');
    const force = !!opts.force;

    if (this._conditionSubscribePromise) {
      return this._conditionSubscribePromise;
    }

    this.conditionRealtime = {
      seq: apiSeq,
      stexTp: stexTp || 'K',
      active: false,
      desired: true,
    };

    this._conditionSubscribePromise = this._doSubscribeConditionRealtime(apiSeq, stexTp, { force }).finally(
      () => {
        this._conditionSubscribePromise = null;
      }
    );
    return this._conditionSubscribePromise;
  }

  /** CNSRREQ 응답이 "이미 등록된 일련번호" 거절인지 */
  _isDuplicateConditionMsg(msg) {
    return /이미\s*등록된/.test(String(msg?.return_msg || ''));
  }

  /**
   * CNSRREQ 전송. 타임아웃은 등록 성공 여부를 알 수 없으므로
   * uncertain으로 표시해 다음 시도에서 CNSRCLR을 먼저 보내게 한다.
   */
  async _sendConditionRegister(apiSeq, stexTp) {
    const payload = {
      trnm: 'CNSRREQ',
      seq: apiSeq,
      search_type: '1',
      stex_tp: stexTp || 'K',
      cont_yn: 'N',
      next_key: '',
    };
    console.log(`[키움WS][${this.userId}] CNSRREQ 실시간 구독 seq=${apiSeq}`);
    try {
      const msg = await this.requestTr(payload, { matchTrnm: 'CNSRREQ', timeoutMs: 25000 });
      this._cnsrreqConsecutiveTimeouts = 0;
      this._conditionRetryAfter = 0;
      return msg;
    } catch (err) {
      if (/시간이 초과/.test(err.message)) {
        this._conditionRegistrationUncertain = true;
        this._cnsrreqConsecutiveTimeouts += 1;
        const backoffMs = Math.min(60000, 10000 * this._cnsrreqConsecutiveTimeouts);
        this._conditionRetryAfter = Date.now() + backoffMs;
        console.warn(
          `[키움WS][${this.userId}] CNSRREQ 응답 없음 (${this._cnsrreqConsecutiveTimeouts}/${CNSRREQ_MAX_CONSECUTIVE_TIMEOUTS}) — ${Math.round(backoffMs / 1000)}초 후 재시도`
        );
        if (this._cnsrreqConsecutiveTimeouts >= CNSRREQ_MAX_CONSECUTIVE_TIMEOUTS) {
          this._recoverFromCnsrreqFailures();
        }
      }
      throw err;
    }
  }

  /** CNSRCLR 전송 (송신 큐 경유) */
  async _sendConditionClear(apiSeq) {
    return this._runOutbound(async () => {
      if (!this.isConnected()) return;
      try {
        this.ws.send(JSON.stringify({ trnm: 'CNSRCLR', seq: apiSeq }));
        console.log(`[키움WS][${this.userId}] CNSRCLR seq=${apiSeq}`);
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        console.warn(`[키움WS][${this.userId}] CNSRCLR 실패:`, err.message);
      }
    });
  }

  async _doSubscribeConditionRealtime(apiSeq, stexTp, { force = false } = {}) {
    if (!this.isConnected()) throw new Error('키움 WS가 연결되어 있지 않습니다.');

    // 당일 스냅샷 강제 시에는 이미 active여도 CLR 후 재등록
    if (!force && this.isConditionRealtimeActive() && this.conditionRealtime.seq === apiSeq) {
      return { return_code: 0, data: [], alreadyActive: true };
    }

    if (this.conditionRealtime.seq && this.conditionRealtime.seq !== apiSeq) {
      await this.unsubscribeConditionRealtime(this.conditionRealtime.seq);
    }

    // 직전 시도 결과가 불명확하면 서버에 남았을 등록을 먼저 정리
    if (force || this._conditionRegistrationUncertain) {
      await this._sendConditionClear(apiSeq);
      this._conditionRegistrationUncertain = false;
      this.conditionRealtime = {
        seq: apiSeq,
        stexTp: stexTp || 'K',
        active: false,
        desired: true,
      };
      await new Promise((r) => setTimeout(r, force ? 500 : 300));
    }

    let msg = await this._sendConditionRegister(apiSeq, stexTp);

    // 서버에만 등록이 남아 어긋난 상태 — 해제 후 1회 재시도
    if (this._isDuplicateConditionMsg(msg)) {
      console.warn(
        `[키움WS][${this.userId}] seq=${apiSeq} 서버에 등록 잔존 — CNSRCLR 후 재구독`
      );
      await this._sendConditionClear(apiSeq);
      await new Promise((r) => setTimeout(r, 500));
      msg = await this._sendConditionRegister(apiSeq, stexTp);

      if (this._isDuplicateConditionMsg(msg)) {
        // 해제가 듣지 않는 경우 — 서버 등록은 살아 있으므로 수신 상태로 인정.
        // 초기 스냅샷은 못 받지만 편입·이탈 REAL은 이 연결로 들어온다.
        console.warn(
          `[키움WS][${this.userId}] seq=${apiSeq} 재구독도 중복 — 기존 등록 재사용 (스냅샷 없음)`
        );
        this.conditionRealtime = {
          seq: apiSeq,
          stexTp: stexTp || 'K',
          active: true,
          desired: true,
        };
        this._cnsrreqConsecutiveTimeouts = 0;
        return { return_code: 0, data: [], reusedExisting: true };
      }
    }

    if (Number(msg.return_code) !== 0 && msg.return_code != null && msg.return_code !== '') {
      throw new Error(msg.return_msg || '조건검색 실시간 등록 실패');
    }

    this.conditionRealtime = {
      seq: apiSeq,
      stexTp: stexTp || 'K',
      active: true,
      desired: true,
    };
    this._cnsrreqConsecutiveTimeouts = 0;
    this._conditionRetryAfter = 0;
    return msg;
  }

  /** 조건검색 실시간 해제 (CNSRCLR) */
  async unsubscribeConditionRealtime(seq) {
    const apiSeq = String(seq ?? this.conditionRealtime?.seq ?? '').trim();
    if (!apiSeq) {
      this.conditionRealtime = { seq: '', stexTp: 'K', active: false, desired: false };
      return;
    }
    await this._sendConditionClear(apiSeq);
    this._conditionRegistrationUncertain = false;
    this.conditionRealtime = {
      seq: '',
      stexTp: 'K',
      active: false,
      desired: false,
    };
  }

  connect() {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this._clearReconnect();
    this._doConnect().catch((err) => {
      console.error(`[키움WS][${this.userId}] 연결 실패:`, err.message);
      this.onStatus({ status: 'error', message: err.message });
      this._scheduleReconnect();
    });
  }

  async _doConnect() {
    const token = await this.getAccessToken();
    if (!token) {
      throw new Error('키움 접근 토큰이 없습니다.');
    }

    // 이미 연결/연결중이면 중복 소켓 생성 금지
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = resolveKiwoomWsUrl();
    console.log(`[키움WS][${this.userId}] 연결: ${url}`);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      this.loggedIn = false;
      this.registeredCodes.clear();

      const onFail = (err) => {
        cleanup();
        if (this.ws === ws) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          resolve();
        }
      };

      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('error', onFail);
      };

      const onOpen = () => {
        cleanup();
        try {
          ws.send(JSON.stringify({ trnm: 'LOGIN', token }));
          this.onStatus({ status: 'kiwoom_connecting' });
          resolve();
        } catch (e) {
          reject(e);
        }
      };

      ws.once('open', onOpen);
      ws.once('error', onFail);

      ws.on('message', (data) => {
        if (this.ws !== ws) return;
        this._onMessage(data);
      });
      ws.on('close', () => {
        // 재연결 레이스로 옛 소켓 close가 새 연결의 loggedIn을 지우지 않도록
        if (this.ws !== ws) return;
        this.loggedIn = false;
        this.registeredCodes.clear();
        this._markConditionDisconnected();
        this._clearSilence();
        this._rejectPendingTrs(new Error('키움 WebSocket 연결이 종료되었습니다.'));
        this.onStatus({ status: 'kiwoom_disconnected' });
        if (!this.destroyed) this._scheduleReconnect();
      });
      ws.on('error', (err) => {
        if (this.ws !== ws) return;
        console.error(`[키움WS][${this.userId}] 소켓 오류:`, err.message);
      });
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    this._bumpSilence();

    const trnm = msg.trnm || msg.TRNM;

    if (trnm && this._pendingTrs.length > 0) {
      const idx = this._pendingTrs.findIndex((p) => {
        if (p.matchTrnm !== trnm) return false;
        if (typeof p.accept === 'function' && !p.accept(msg)) return false;
        return true;
      });
      if (idx >= 0) {
        const [pending] = this._pendingTrs.splice(idx, 1);
        clearTimeout(pending.timer);
        pending.resolve(msg);
        return;
      }
      if (trnm !== 'PING' && trnm !== 'REAL' && trnm !== 'REG' && trnm !== 'CNSRCLR') {
        console.log(
          `[키움WS][${this.userId}] pending 대기중 unmatched trnm=${trnm} code=${msg.return_code ?? ''} ${msg.return_msg || ''}`
        );
      }
    }

    if (trnm === 'SYSTEM') {
      const sysMsg = msg.return_msg || msg.message || '키움 SYSTEM 메시지';
      if (SYSTEM_NOTICE_PATTERN.test(String(sysMsg))) {
        console.log(`[키움WS][${this.userId}] 시장공지: ${String(sysMsg).trim()}`);
        return;
      }
      console.error(
        `[키움WS][${this.userId}] SYSTEM: ${sysMsg}` +
          (msg.return_code != null ? ` code=${msg.return_code}` : '')
      );
      if (this._pendingTrs.length > 0) {
        this._rejectPendingTrs(new Error(sysMsg));
      }
      return;
    }

    if (trnm === 'PING') {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(typeof raw === 'string' ? raw : raw.toString());
      }
      return;
    }

    if (trnm === 'LOGIN') {
      if (Number(msg.return_code) === 0) {
        this.loggedIn = true;
        this._lastLoginAt = Date.now();
        // soft-reconnect 후에도 CNSRREQ backoff는 유지 (아침 연타 방지)
        this.reconnectDelayMs = 1000;
        this.onStatus({ status: 'kiwoom_connected' });
        this._syncRegistration();
      } else {
        const message = msg.return_msg || '키움 WS LOGIN 실패';
        console.error(`[키움WS][${this.userId}] LOGIN 실패:`, message);
        this.onStatus({ status: 'error', message });
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (trnm === 'REG') {
      this._markRegQuiet();
      this._resolveRegAck();
      if (Number(msg.return_code) !== 0) {
        console.error(`[키움WS][${this.userId}] REG 실패:`, msg.return_msg || msg);
      }
      return;
    }

    // 주문체결: trnm이 "00" 인 경우
    if (trnm === '00' || msg.type === '00') {
      this._emitOrderRows(msg);
      return;
    }

    // pending TR 있을 때는 data 배열을 REAL로 오인하지 않음
    if (trnm === 'REAL' || (Array.isArray(msg.data) && this._pendingTrs.length === 0)) {
      const rows = Array.isArray(msg.data) ? msg.data : [msg];
      for (const row of rows) {
        const type = String(row.type || row.type_cd || msg.type || '');
        const values = row.values || row.value || row || {};

        if (type === '00') {
          const evt = parseOrderFillEvent(row, values);
          if (evt) {
            try {
              this.onOrder(evt);
            } catch (err) {
              console.error(`[키움WS][${this.userId}] onOrder 오류:`, err.message);
            }
          }
          continue;
        }

        const condEvt = parseConditionRealtimeEvent(row, values);
        if (condEvt) {
          try {
            this.onCondition(condEvt);
          } catch (err) {
            console.error(`[키움WS][${this.userId}] onCondition 오류:`, err.message);
          }
          continue;
        }

        if (type && type !== '0B' && type !== '0A' && type !== '0H' && type !== 'FE' && type !== 'F5') {
          continue;
        }
        const tick = parseTradeTick(row.item || row.jmcode || row.stk_cd || row.name, values);
        if (tick) this.onTick(tick);
      }
    }
  }

  _emitOrderRows(msg) {
    const rows = Array.isArray(msg.data) ? msg.data : [msg];
    for (const row of rows) {
      const values = row.values || row.value || row;
      const evt = parseOrderFillEvent(row, values);
      if (!evt) continue;
      try {
        this.onOrder(evt);
      } catch (err) {
        console.error(`[키움WS][${this.userId}] onOrder 오류:`, err.message);
      }
    }
  }

  _syncRegistration() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.loggedIn) return;

    const codes = new Set(Array.from(this.desiredCodes).slice(0, 100));
    const wantOrderFills = !!this.orderFillsEnabled;

    if (codes.size === 0 && !wantOrderFills) {
      if (this.registeredCodes.size > 0 || this._registeredOrderFills) {
        this.registeredCodes.clear();
        this._registeredOrderFills = false;
      }
      return;
    }

    if (setsEqual(codes, this.registeredCodes) && wantOrderFills === this._registeredOrderFills) {
      return;
    }

    const codeList = Array.from(codes);
    const krItems = [];
    const usItems = [];
    for (const code of codeList) {
      if (isUsRegCode(code)) {
        const decoded = decodeUsRegCode(code);
        if (decoded?.jmcode) {
          usItems.push({ jmcode: decoded.jmcode, stex_tp: decoded.stex_tp });
        }
      } else {
        krItems.push(code);
      }
    }

    const data = [];
    if (krItems.length > 0 || usItems.length > 0) {
      const items = [...krItems, ...usItems];
      const types = [];
      if (krItems.length > 0) types.push('0B');
      if (usItems.length > 0) types.push('FE');
      data.push({ item: items, type: types });
    }
    if (wantOrderFills) {
      data.push({ item: [], type: ['00'] });
    }

    const payload = {
      trnm: 'REG',
      grp_no: '1',
      refresh: '0',
      data,
    };

    const parts = [];
    if (krItems.length) parts.push(`0B:${krItems.length}`);
    if (usItems.length) parts.push(`FE:${usItems.length}`);
    if (wantOrderFills) parts.push('00');

    this._runOutbound(async () => {
      if (!this.isConnected()) return;
      try {
        this._lastRegAt = Date.now();
        this.ws.send(JSON.stringify(payload));
        this.registeredCodes = new Set(codes);
        this._registeredOrderFills = wantOrderFills;
        console.log(`[키움WS][${this.userId}] REG ${parts.join(' + ')}`);
        this.onStatus({ status: 'subscribed', message: parts.join('+') });
        await this._waitRegAck(REG_ACK_TIMEOUT_MS);
        this._markRegQuiet();
      } catch (err) {
        console.error(`[키움WS][${this.userId}] REG 전송 실패:`, err.message);
        this._markRegQuiet();
      }
    }).catch(() => {});
  }

  _bumpSilence() {
    this._clearSilence();
    this.silenceTimer = setTimeout(() => {
      console.warn(`[키움WS][${this.userId}] 침묵 타임아웃 → 재연결`);
      try {
        this.ws?.terminate();
      } catch {
        /* ignore */
      }
    }, this.SILENCE_MS);
  }

  _clearSilence() {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    if (!this._shouldStayConnected()) return;

    const pauseLeft = this.reconnectPausedUntil - Date.now();
    const delay = Math.max(this.reconnectDelayMs, pauseLeft > 0 ? pauseLeft : 0);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  destroy() {
    this.destroyed = true;
    this.desiredCodes.clear();
    this.orderFillsEnabled = false;
    this.conditionRealtime = { seq: '', stexTp: 'K', active: false, desired: false };
    this._conditionSubscribePromise = null;
    this._clearReconnect();
    this._clearSilence();
    this._rejectPendingTrs(new Error('키움 WebSocket 클라이언트가 종료되었습니다.'));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

module.exports = {
  KiwoomRealtimeClient,
  parseTradeTick,
  parseOrderFillEvent,
  parseConditionRealtimeEvent,
  normalizeOrderNo,
  normalizeRegCode,
  toBaseStockCode,
  resolveKiwoomWsUrl,
  encodeUsRegCode,
  decodeUsRegCode,
  isUsRegCode,
  normalizeUsStexTp,
};

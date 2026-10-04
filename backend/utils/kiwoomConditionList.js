/**
 * 키움 영웅문 조건검색 (목록 ka10171 / 종목조회 ka10172)
 *
 * 키움은 계정당 WebSocket 세션을 사실상 1개로 제한합니다.
 * 자동매매/관심종목 WS가 이미 있으면 그 연결로 CNSRLST/CNSRREQ를 보냅니다.
 */

const WebSocket = require('ws');

const LIVE_WS_URL = 'wss://api.kiwoom.com:10000/api/dostk/websocket';
const MOCK_WS_URL = 'wss://mockapi.kiwoom.com:10000/api/dostk/websocket';

const resolveKiwoomWsUrl = () => {
  const base = process.env.KIWOOM_BASE_URL || process.env.KIWOOM_TOKEN_URL || '';
  if (String(base).includes('mock')) return MOCK_WS_URL;
  return process.env.KIWOOM_WS_URL || LIVE_WS_URL;
};

/** 토큰별 WS 요청 직렬화 (조건검색 중복 호출 방지) */
const oneshotQueues = new Map();

const withOneshotQueue = (tokenKey, fn) => {
  const prev = oneshotQueues.get(tokenKey) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (oneshotQueues.get(tokenKey) === next) oneshotQueues.delete(tokenKey);
    });
  oneshotQueues.set(tokenKey, next);
  return next;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CNSRLST가 준 seq 그대로 사용 (0 → "000" 패딩 시 키움이 '존재하지 않는 일련번호' 반환) */
const toApiSeq = (conditionSeq) => String(conditionSeq ?? '').trim();

/**
 * 재조회 전 조건검색 해제 — KiwoomRealtimeClient는 송신 큐 경유
 */
const sendClearCondition = async (clientOrWs, apiSeq) => {
  try {
    if (typeof clientOrWs?._sendConditionClear === 'function') {
      await clientOrWs._sendConditionClear(apiSeq);
      return;
    }
    const payload = JSON.stringify({ trnm: 'CNSRCLR', seq: apiSeq });
    if (clientOrWs?.ws?.readyState === 1) {
      clientOrWs.ws.send(payload);
    } else if (clientOrWs?.readyState === 1) {
      clientOrWs.send(payload);
    } else if (typeof clientOrWs?.send === 'function' && clientOrWs.isConnected?.()) {
      clientOrWs.ws.send(payload);
    }
  } catch {
    /* ignore */
  }
};

const normalizeConditionSeq = (seq) => {
  if (seq === undefined || seq === null) return '';
  return String(seq).trim();
};

const normalizeConditions = (data) => {
  if (!Array.isArray(data)) return [];
  return data
    .map((item, idx) => {
      if (Array.isArray(item)) {
        const seq = String(item[0] ?? '').trim();
        const name = String(item[1] ?? item[0] ?? '').trim();
        return { seq: seq || String(idx), name: name || seq || `조건식${idx}` };
      }
      if (item && typeof item === 'object') {
        const seq = String(
          item.seq ?? item.cond_seq ?? item.condition_seq ?? item.cd ?? item[0] ?? ''
        ).trim();
        const name = String(
          item.name ?? item.cond_nm ?? item.condition_name ?? item.nm ?? item[1] ?? seq
        ).trim();
        if (!seq && !name) return null;
        return { seq: seq || String(idx), name: name || seq };
      }
      const s = String(item ?? '').trim();
      if (!s) return null;
      return { seq: s, name: s };
    })
    .filter(Boolean);
};

const parseKiwoomNumber = (raw) => {
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw).replace(/,/g, '').replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
};

const normalizeConditionStocks = (data) => {
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => {
      // ["005930","삼성전자",...] 형태
      if (Array.isArray(row)) {
        const stockCode = String(row[0] ?? '')
          .replace(/^A/i, '')
          .replace(/_[A-Z0-9]+$/i, '')
          .trim()
          .substring(0, 6);
        if (!stockCode) return null;
        const stockName = String(row[1] ?? '').trim();
        const priceRaw = parseKiwoomNumber(row[2]);
        return {
          stockCode,
          stockName,
          price: priceRaw != null ? Math.abs(priceRaw) : null,
          changeRate: parseKiwoomNumber(row[5]),
        };
      }
      if (!row || typeof row !== 'object') {
        // "005930" 단독 문자열
        const code = String(row ?? '')
          .replace(/^A/i, '')
          .replace(/_[A-Z0-9]+$/i, '')
          .trim()
          .substring(0, 6);
        if (!/^\d{6}$/.test(code)) return null;
        return {
          stockCode: code,
          stockName: '',
          price: null,
          changeRate: null,
        };
      }
      const stockCode = String(
        row['9001'] ??
          row.stk_cd ??
          row.jmcode ??
          row.code ??
          row.stockCode ??
          row.item ??
          ''
      )
        .replace(/^A/i, '')
        .replace(/_[A-Z0-9]+$/i, '')
        .trim()
        .substring(0, 6);
      if (!stockCode) return null;
      const stockName = String(row['302'] ?? row.stk_nm ?? row.name ?? row.stockName ?? '').trim();
      const priceRaw = parseKiwoomNumber(row['10'] ?? row.cur_prc ?? row.price);
      const price = priceRaw != null ? Math.abs(priceRaw) : null;
      const changeRate = parseKiwoomNumber(row['12'] ?? row.flu_rt ?? row.changeRate);
      return {
        stockCode,
        stockName,
        price,
        changeRate,
      };
    })
    .filter(Boolean);
};

const summarizeConditionSearchMsg = (msg) => {
  const data = msg?.data;
  const sample = Array.isArray(data) && data.length > 0 ? data[0] : null;
  let sampleKeys = '';
  if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
    sampleKeys = Object.keys(sample).slice(0, 12).join(',');
  } else if (Array.isArray(sample)) {
    sampleKeys = `array[${sample.length}]`;
  } else if (sample != null) {
    sampleKeys = typeof sample;
  }
  return {
    return_code: msg?.return_code,
    return_msg: msg?.return_msg || '',
    cont_yn: msg?.cont_yn,
    rawCount: Array.isArray(data) ? data.length : data == null ? 'null' : typeof data,
    sampleKeys,
  };
};

const assertOkReturnCode = (msg, fallback) => {
  if (Number(msg.return_code) !== 0 && msg.return_code != null && msg.return_code !== '') {
    throw new Error(msg.return_msg || fallback);
  }
};

const resolveSharedClient = (userId) => {
  if (userId == null || userId === '') return null;
  try {
    const wsRegistry = require('../services/kiwoomUserWsRegistry');
    return wsRegistry.getConnectedClient(userId);
  } catch {
    return null;
  }
};

/** 재연결 직후면 잠깐 기다려 기존 WS를 우선 사용 */
const resolveSharedClientPrefer = async (userId, waitMs = 2500) => {
  const immediate = resolveSharedClient(userId);
  if (immediate) return immediate;
  if (userId == null || userId === '') return null;

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const c = resolveSharedClient(userId);
    if (c) return c;
  }
  return null;
};

const openKiwoomWsSession = (accessToken, timeoutMs, onLoggedIn) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let loggedIn = false;
    let lastTrnm = '';
    const ws = new WebSocket(resolveKiwoomWsUrl());

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          lastTrnm
            ? `키움 WebSocket 요청 시간이 초과되었습니다. (마지막 수신: ${lastTrnm})`
            : '키움 WebSocket 요청 시간이 초과되었습니다.'
        )
      );
    }, timeoutMs);

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ trnm: 'LOGIN', token: accessToken }));
      } catch (e) {
        finish(e);
      }
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const trnm = msg.trnm || msg.TRNM;
      if (trnm) lastTrnm = String(trnm);

      if (trnm === 'PING') {
        try {
          ws.send(typeof raw === 'string' ? raw : raw.toString());
        } catch {
          /* ignore */
        }
        return;
      }

      if (trnm === 'LOGIN') {
        if (Number(msg.return_code) === 0) {
          loggedIn = true;
          try {
            onLoggedIn(ws, msg, finish);
          } catch (e) {
            finish(e);
          }
        } else {
          finish(new Error(msg.return_msg || '키움 WS LOGIN 실패'));
        }
        return;
      }

      if (trnm && trnm !== 'CNSRLST' && trnm !== 'CNSRREQ') {
        console.log(
          `[조건검색WS] 기타 메시지 trnm=${trnm} return_code=${msg.return_code ?? ''} msg=${msg.return_msg || ''}`
        );
      }

      try {
        onLoggedIn(ws, msg, finish, { afterLogin: true, loggedIn });
      } catch (e) {
        finish(e);
      }
    });

    ws.on('error', (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on('close', (code, reasonBuf) => {
      if (!settled) {
        const reason = reasonBuf ? reasonBuf.toString() : '';
        const detail = [code != null ? `code=${code}` : '', reason ? `reason=${reason}` : '']
          .filter(Boolean)
          .join(' ');
        finish(
          new Error(
            loggedIn
              ? `응답 전에 연결이 종료되었습니다.${detail ? ` (${detail})` : ''}${
                  lastTrnm ? ` last=${lastTrnm}` : ''
                }`
              : `키움 WebSocket 연결이 종료되었습니다.${detail ? ` (${detail})` : ''}`
          )
        );
      }
    });
  });

const runViaSharedClient = async (client, payload, matchTrnm, timeoutMs) => {
  console.log(`[조건검색WS] 기존 연결 재사용 → ${matchTrnm}`);
  const msg = await client.requestTr(payload, { matchTrnm, timeoutMs });
  assertOkReturnCode(msg, `${matchTrnm} 조회 실패`);
  return msg;
};

/**
 * @param {string} accessToken
 * @param {{ timeoutMs?: number, userId?: string|number }} [opts]
 * @returns {Promise<Array<{ seq: string, name: string }>>}
 */
const fetchConditionList = async (accessToken, opts = {}) => {
  const token = String(accessToken || '').trim();
  if (!token) throw new Error('키움 접근 토큰이 없습니다.');
  const timeoutMs = opts.timeoutMs || 15000;
  const payload = { trnm: 'CNSRLST' };

  const shared = await resolveSharedClientPrefer(opts.userId);
  if (shared) {
    if (shared.isConditionRealtimeSubscribing?.()) {
      throw new Error('조건검색 실시간 구독 처리 중입니다. 잠시 후 다시 시도하세요.');
    }
    const msg = await runViaSharedClient(shared, payload, 'CNSRLST', timeoutMs);
    return normalizeConditions(msg.data);
  }

  return withOneshotQueue(`list:${token.slice(0, 16)}`, () =>
    openKiwoomWsSession(token, timeoutMs, (ws, msg, finish, ctx) => {
      if (!ctx?.afterLogin) {
        ws.send(JSON.stringify(payload));
        return;
      }
      if ((msg.trnm || msg.TRNM) !== 'CNSRLST') return;
      try {
        assertOkReturnCode(msg, '조건식 목록 조회 실패');
        finish(null, normalizeConditions(msg.data));
      } catch (e) {
        finish(e);
      }
    })
  );
};

/**
 * 조건검색 일반 조회 (ka10172 / CNSRREQ search_type=0)
 * - 동일 계좌 요청 직렬화
 * - 계정당 WS 1개이므로 기존 자동매매/관심종목 연결로만 조회 (one-shot 시 SYSTEM/Bye)
 * - CNSRCLR는 응답 대기 없이 전송만
 * @param {string} accessToken
 * @param {string} seq
 * @param {{ timeoutMs?: number, stexTp?: string, userId?: string|number }} [opts]
 */
const fetchConditionSearch = async (accessToken, seq, opts = {}) => {
  const token = String(accessToken || '').trim();
  const conditionSeq = normalizeConditionSeq(seq);
  if (!token) throw new Error('키움 접근 토큰이 없습니다.');
  if (conditionSeq === '') {
    throw new Error('매수 조건(조건식)이 선택되지 않았습니다.');
  }

  const timeoutMs = opts.timeoutMs || 20000;
  const apiSeq = toApiSeq(conditionSeq);
  const queueKey = `search:${opts.userId ?? token.slice(0, 16)}`;

  return withOneshotQueue(queueKey, async () => {
    const payload = {
      trnm: 'CNSRREQ',
      seq: apiSeq,
      search_type: '0',
      stex_tp: opts.stexTp || 'K',
      cont_yn: 'N',
      next_key: '',
    };

    console.log(`[조건검색WS] CNSRREQ seq=${apiSeq}`);

    const finishFromMsg = (msg) => {
      const summary = summarizeConditionSearchMsg(msg);
      const stocks = normalizeConditionStocks(msg.data);
      console.log(
        `[조건검색WS] CNSRREQ 응답 code=${summary.return_code} raw=${summary.rawCount} parsed=${stocks.length}` +
          `${summary.return_msg ? ` msg=${summary.return_msg}` : ''}` +
          `${summary.sampleKeys ? ` sample=${summary.sampleKeys}` : ''}` +
          `${summary.cont_yn ? ` cont=${summary.cont_yn}` : ''}`
      );
      if (Array.isArray(msg.data) && msg.data.length > 0 && stocks.length === 0) {
        console.warn('[조건검색WS] 원본 data는 있으나 파싱 결과 0건 — 응답 형식 확인 필요', msg.data[0]);
      }
      if (!Array.isArray(msg.data)) {
        console.warn('[조건검색WS] CNSRREQ data 없음 — keys=', Object.keys(msg || {}));
      }
      return stocks;
    };

    const shared = await resolveSharedClientPrefer(opts.userId, 3000);
    if (!shared) {
      throw new Error(
        '키움 실시간 연결이 없습니다. 거래시간이 아닙니다.'
      );
    }

    const preserveRealtime = !!opts.preserveRealtimeSubscription;
    const realtimeBusy =
      preserveRealtime &&
      (shared.isConditionRealtimeActive?.() ||
        shared.wantsConditionRealtime?.() ||
        shared.isConditionRealtimeSubscribing?.());

    // 실시간 구독(search_type=1) 중 search_type=0 스냅샷은 같은 WS에서 충돌 → SYSTEM/연결종료
    if (realtimeBusy) {
      console.log(
        `[조건검색WS] 실시간 구독 중 — search_type=0 스냅샷 생략 (seq=${apiSeq})`
      );
      const skipErr = new Error('REALTIME_SNAPSHOT_SKIP');
      skipErr.code = 'REALTIME_SNAPSHOT_SKIP';
      throw skipErr;
    }

    let realtimeWasActive = false;
    let realtimeSeq = '';
    if (preserveRealtime && shared.isConditionRealtimeActive?.()) {
      realtimeWasActive = true;
      realtimeSeq = shared.getConditionRealtimeSeq?.() || '';
    }

    // 실시간 구독 중이면 CNSRCLR 생략 (일반 스냅샷만 조회)
    if (!realtimeWasActive) {
      await sendClearCondition(shared, apiSeq);
      await sleep(300);
    }

    const msg = await runViaSharedClient(shared, payload, 'CNSRREQ', timeoutMs);
    const stocks = finishFromMsg(msg);
    if (!realtimeWasActive) {
      await sendClearCondition(shared, apiSeq);
    } else if (realtimeSeq && realtimeSeq !== apiSeq) {
      // 다른 조건식 스냅샷 조회 후 원래 실시간 seq 복구는 호출측에서 resubscribe
    }
    return stocks;
  });
};

module.exports = {
  fetchConditionList,
  fetchConditionSearch,
  normalizeConditions,
  normalizeConditionStocks,
  normalizeConditionSeq,
  resolveKiwoomWsUrl,
};

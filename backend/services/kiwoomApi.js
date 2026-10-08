const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getKiwoomRestBase, getKiwoomTokenUrl } = require('../utils/kiwoomMode');
const { DATA_DIR } = require('../utils/appPaths');

/** 모의투자 서버는 초당 1건만 허용(1700) — 모의 서버로 가는 요청만 순서대로 간격을 둔다 */
const MOCK_REST_HOST = 'mockapi.kiwoom.com';
const MOCK_REQUEST_GAP_MS = 1100;
let mockNextSlotAt = 0;
axios.interceptors.request.use(async (config) => {
  if (!String(config.url || '').includes(MOCK_REST_HOST)) return config;
  const now = Date.now();
  const wait = Math.max(0, mockNextSlotAt - now);
  mockNextSlotAt = Math.max(now, mockNextSlotAt) + MOCK_REQUEST_GAP_MS;
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  return config;
});

/**
 * kt00009(계좌별주문체결현황)는 실전도 초당 1건(1700) — 토큰(계좌)별로 한 번에 1건만,
 * 이전 요청의 응답을 받은 뒤 KT00009_GAP_MS 가 지나야 다음 요청을 보낸다
 */
const KT00009_GAP_MS = 1500;
const KT00009_RELEASE_FAILSAFE_MS = 30000;
/** @type {Map<string, Promise<void>>} auth -> 마지막 요청의 해제 Promise */
const kt00009Gate = new Map();
const headerOf = (h, name) => (typeof h?.get === 'function' ? h.get(name) : h?.[name]);

axios.interceptors.request.use(async (config) => {
  const h = config.headers || {};
  if (headerOf(h, 'api-id') !== 'kt00009') return config;
  const auth = String(headerOf(h, 'authorization') || '');
  const prev = kt00009Gate.get(auth) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => mine);
  kt00009Gate.set(auth, tail);
  tail.then(() => {
    if (kt00009Gate.get(auth) === tail) kt00009Gate.delete(auth);
  });
  await prev;
  const failsafe = setTimeout(release, KT00009_RELEASE_FAILSAFE_MS);
  config.__kt00009Release = () => {
    clearTimeout(failsafe);
    setTimeout(release, KT00009_GAP_MS);
  };
  return config;
});

const releaseKt00009 = (config) => {
  const fn = config?.__kt00009Release;
  if (fn) {
    config.__kt00009Release = null;
    fn();
  }
};
axios.interceptors.response.use(
  (response) => {
    releaseKt00009(response.config);
    return response;
  },
  (error) => {
    releaseKt00009(error?.config);
    return Promise.reject(error);
  }
);

const isKiwoomRateLimitError = (err) =>
  err?.status === 429 || /1700|허용된 요청 개수/.test(String(err?.message || ''));

/**
 * 키움 미국주식 주문/정정/STOP 단가 포맷
 * $1 미만: 소수점 4자리, $1 이상: 소수점 2자리
 */
function formatUsOrderUnitPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return '';
  const decimals = n < 1 ? 4 : 2;
  const factor = 10 ** decimals;
  return (Math.round(n * factor) / factor).toFixed(decimals);
}

class KiwoomAPI {
  /** 실전 https://api.kiwoom.com / 모의 https://mockapi.kiwoom.com — 환경설정의 투자 모드를 따른다 */
  get baseURL() {
    return getKiwoomRestBase();
  }

  // 계좌 정보 조회 (계좌평가현황요청 - kt00004)
  async getAccountInfo(accessToken, appKey, appSecret, accountNo = null) {
    try {
      // 키움증권 API 엔드포인트
      const endpoint = '/api/dostk/acnt';
      const url = `${this.baseURL}${endpoint}`;
      
      // 헤더 설정
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'authorization': `Bearer ${accessToken}`, // 소문자 authorization
        'cont-yn': 'N', // 연속조회여부
        'next-key': '', // 연속조회키
        'api-id': 'kt00018', // TR명 (계좌평가현황요청)
      };
      
      // 요청 본문 (계좌평가현황요청 파라미터)
      const data = {
        qry_tp: '0', // 상장폐지조회구분 (0: 전체, 1: 상장폐지종목제외, 필수 파라미터)
        dmst_stex_tp: 'KRX' // 국내거래소구분 (KRX: 한국거래소, NXT: 넥스트트레이드, 필수 파라미터)
      };
      if (accountNo) {
        data.acnt_no = accountNo; // 계좌번호 (있는 경우)
      }

      const response = await axios.post(url, data, { 
        headers,
        timeout: 15000,
        validateStatus: () => true
      });
      
      if (response.status !== 200) {
        throw this.handleError({ response });
      }
      
      // 키움증권 API는 HTTP 200이어도 return_code로 성공/실패를 판단
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        console.error('[키움증권 API] 계좌 정보 조회 실패:', response.data);
        throw {
          status: 400,
          message: response.data.return_msg || '계좌 정보 조회에 실패했습니다.',
          data: response.data
        };
      }
      
      return response.data;
    } catch (error) {
      console.error('[키움증권 API] 계좌 정보 조회 실패:', error.response?.data || error.message);
      throw this.handleError(error);
    }
  }

  // 잔고 조회 (일별잔고수익률 - ka01690 사용, 계좌정보와 동일한 API)
  async getBalance(accessToken, appKey, appSecret, qryDt = null) {
    try {
      // 잔고 정보는 계좌 정보 조회 API와 동일하게 사용
      // 실제 키움증권 API에서 잔고 정보도 ka01690으로 조회 가능
      return await this.getAccountInfo(accessToken, appKey, appSecret, qryDt);
    } catch (error) {
      console.error('[키움증권 API] 잔고 조회 실패:', error.response?.data || error.message);
      throw this.handleError(error);
    }
  }

  // 보유 종목 조회 (계좌평가현황요청 - kt00004 사용)
  // 참고: kt00004는 계좌 평가 현황과 함께 보유 종목 정보를 제공합니다.
  // kt00005(체결잔고요청)도 보유 종목을 제공하지만, kt00004가 보유 종목 조회에 더 적합합니다.
  async getHoldings(accessToken, appKey, appSecret, accountNo = null, contYn = 'N', nextKey = '') {
    try {
      // 키움증권 API 엔드포인트
      const endpoint = '/api/dostk/acnt';
      const url = `${this.baseURL}${endpoint}`;
      
      // 헤더 설정
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'authorization': `Bearer ${accessToken}`, // 소문자 authorization
        'cont-yn': contYn, // 연속조회여부
        'next-key': nextKey, // 연속조회키
        'api-id': 'kt00004', // TR명 (계좌평가현황요청) - 보유 종목 조회에 적합
      };
      
      // 요청 본문 (계좌평가현황요청 파라미터)
      const data = {
        qry_tp: '0', // 상장폐지조회구분 (0: 전체, 1: 상장폐지종목제외)
        dmst_stex_tp: 'KRX' // 국내거래소구분 (KRX: 한국거래소, NXT: 넥스트트레이드)
      };
      
      if (accountNo) {
        data.acnt_no = accountNo; // 계좌번호 (있는 경우)
      }

      const response = await axios.post(url, data, { 
        headers,
        timeout: 15000,
        validateStatus: () => true
      });
      
      if (response.status !== 200) {
        throw this.handleError({ response });
      }
      
      // 키움증권 API는 HTTP 200이어도 return_code로 성공/실패를 판단
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        console.error('[키움증권 API] 보유 종목 조회 실패:', response.data);
        throw {
          status: 400,
          message: response.data.return_msg || '보유 종목 조회에 실패했습니다.',
          data: response.data
        };
      }
      
      return response.data;
    } catch (error) {
      console.error('[키움증권 API] 보유 종목 조회 실패:', error.response?.data || error.message);
      throw this.handleError(error);
    }
  }

  // 시장별 종목 목록 조회 (ka10099)
  async getMarketStockList(accessToken, appKey, appSecret, mrktTp, contYn = 'N', nextKey = '') {
    try {
      const endpoint = '/api/dostk/stkinfo';
      const url = `${this.baseURL}${endpoint}`;
      
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'authorization': `Bearer ${accessToken}`,
        'cont-yn': contYn,
        'next-key': nextKey,
        'api-id': 'ka10099', // TR명 (시장별 종목 목록 조회)
      };
      
      const data = {
        mrkt_tp: String(mrktTp), // 시장 구분 (문자열로 변환: "0": 코스피, "10": 코스닥, "3": ELW, "8": ETF, "30": K-OTC, "50": 코넥스 등)
      };

      const response = await axios.post(url, data, {
        headers,
        timeout: 30000,
        validateStatus: () => true
      });
      
      if (response.status !== 200) {
        throw this.handleError({ response });
      }
      
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        if (response.data.return_code === 20) {
          // 데이터 없음
          return { stocks: [], nextKey: '', contYn: 'N' };
        }
        throw {
          status: 400,
          message: response.data.return_msg || '시장별 종목 목록 조회에 실패했습니다.',
          data: response.data
        };
      }
      
      // 응답에서 종목 정보 추출
      // ka10099 API 응답 구조: { return_code: 0, return_msg: "...", list: [{ code: "...", name: "..." }, ...] }
      let stockList = [];
      if (response.data.list) {
        stockList = Array.isArray(response.data.list) ? response.data.list : [response.data.list];
      } else if (response.data.output) {
        stockList = Array.isArray(response.data.output) ? response.data.output : [response.data.output];
      } else if (response.data.data) {
        stockList = Array.isArray(response.data.data) ? response.data.data : [response.data.data];
      } else if (Array.isArray(response.data)) {
        stockList = response.data;
      }

      const stocks = [];
      stockList.forEach((item) => {
        if (item && typeof item === 'object') {
          const stockCode = item.code || item.stk_cd || '';
          const stockName = item.name || item.stk_nm || '';
          if (stockCode && stockName) {
            stocks.push({
              stockCode,
              stockName,
              mrktTp: String(mrktTp),
            });
          }
        }
      });

      return {
        stocks,
        nextKey: response.headers['next-key'] || '',
        contYn: response.headers['cont-yn'] || 'N'
      };
    } catch (error) {
      console.error(`[키움증권 API] 시장별 종목 목록 조회 실패 (mrkt_tp: ${mrktTp}):`, error.message);
      throw this.handleError(error);
    }
  }

  // 전체 종목 목록 조회 (ka10099를 사용하여 시장별 종목 목록 조회)
  async getAllStocks(accessToken, appKey, appSecret, dmstStexTp = 'KRX') {
    try {
      console.log(`[키움증권 API] 전체 종목 목록 조회 시작 (거래소: ${dmstStexTp})`);
      
      const { KR_MRKT_TPS_TO_FETCH, isEtfLikeMrktTp } = require('../utils/krMrktTp');
      // 코스피/코스닥 후 ETF·ETN — 같은 코드면 ETF/ETN mrkt_tp 가 남음
      const marketTypes = KR_MRKT_TPS_TO_FETCH;
      
      const byCode = new Map();
      const pageGapMs = 100;
      const isRateLimited = (e) =>
        e?.status === 429 ||
        e?.data?.return_code === 5 ||
        /허용된.*요청|1700/.test(String(e?.message || ''));
      const fetchPage = async (mrktTp, contYn, nextKey) => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await this.getMarketStockList(accessToken, appKey, appSecret, mrktTp, contYn, nextKey);
          } catch (e) {
            if (!isRateLimited(e) || attempt >= 5) throw e;
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          }
        }
      };
      
      // 각 시장에 대해 종목 목록 조회
      for (const mrktTp of marketTypes) {
        console.log(`[키움증권 API] 시장 ${mrktTp} 종목 목록 조회 중...`);
        
        let contYn = 'N';
        let nextKey = '';
        let loopCount = 0;
        const maxLoops = 100;
        
        while (loopCount < maxLoops) {
          loopCount++;
          
          const result = await fetchPage(mrktTp, contYn, nextKey);
          
          result.stocks.forEach((stock) => {
            const prev = byCode.get(stock.stockCode);
            if (!prev) {
              byCode.set(stock.stockCode, stock);
              return;
            }
            if (isEtfLikeMrktTp(stock.mrktTp) && !isEtfLikeMrktTp(prev.mrktTp)) {
              byCode.set(stock.stockCode, {
                ...prev,
                ...stock,
                stockName: stock.stockName || prev.stockName,
              });
            }
          });
          
          console.log(`[키움증권 API] 시장 ${mrktTp} ${loopCount}회차: ${result.stocks.length}건 수집, 누적: ${byCode.size}건`);
          
          // 연속조회 확인
          nextKey = result.nextKey;
          contYn = result.contYn;
          
          if (contYn !== 'Y' || !nextKey) {
            break;
          }
          
          await new Promise(resolve => setTimeout(resolve, pageGapMs));
        }
        await new Promise(resolve => setTimeout(resolve, pageGapMs));
      }
      
      const allStocks = Array.from(byCode.values());
      console.log(`[키움증권 API] 전체 종목 목록 조회 완료: 총 ${allStocks.length}건`);
      
      return allStocks;
    } catch (error) {
      console.error('[키움증권 API] 전체 종목 목록 조회 실패:', error);
      throw this.handleError(error);
    }
  }

  // 종목 정보 조회 (ka10095 - 관심종목정보요청)
  // 유량 초과(429) 시 쿨다운 — 연속 재호출로 한도를 더 소모하지 않음
  async getStockInfo(accessToken, appKey, appSecret, stockCode, contYn = 'N', nextKey = '', dmstStexTp = 'KRX') {
    const KA10095_COOLDOWN_MS = 5000;
    if (this._ka10095RateLimitedUntil && Date.now() < this._ka10095RateLimitedUntil) {
      const waitMs = this._ka10095RateLimitedUntil - Date.now();
      const err = {
        status: 429,
        isRateLimit: true,
        message: `허용된 API 요청 개수를 초과하였습니다. (ka10095 쿨다운 ${Math.ceil(waitMs / 1000)}초)`,
        data: { return_code: 5 },
        _alreadyLogged: true,
      };
      throw err;
    }

    const markRateLimit = (message, data) => {
      this._ka10095RateLimitedUntil = Date.now() + KA10095_COOLDOWN_MS;
      return {
        status: 429,
        isRateLimit: true,
        message: message || '허용된 API 요청 개수를 초과하였습니다.',
        data: data || {},
      };
    };

    const isRateLimitPayload = (status, data) => {
      if (status === 429) return true;
      const msg = String(data?.return_msg || data?.message || '');
      return (
        data?.return_code === 5 ||
        msg.includes('허용된 요청') ||
        msg.includes('유량') ||
        msg.includes('EGW00201')
      );
    };

    try {
      const endpoint = '/api/dostk/stkinfo';
      const url = `${this.baseURL}${endpoint}`;
      
      // 헤더 설정
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'authorization': `Bearer ${accessToken}`,
        'cont-yn': contYn,
        'next-key': nextKey,
        'api-id': 'ka10095', // TR명 (관심종목정보요청)
      };
      
      // 요청 본문 (ka10095 파라미터)
      // Python 예제 기준: stk_cd만 필수, dmst_stex_tp는 선택사항
      const data = {
        stk_cd: stockCode, // 종목코드 (여러 개는 |로 구분, 거래소별 종목코드: KRX:039490, NXT:039490_NX, SOR:039490_AL)
      };

      // dmst_stex_tp는 선택 파라미터 (값이 있을 때만 추가)
      if (dmstStexTp && dmstStexTp !== 'KRX') {
        data.dmst_stex_tp = dmstStexTp; // 국내거래소구분 (NXT: 넥스트트레이드, SOR: 소호)
      }

      const response = await axios.post(url, data, {
        headers,
        timeout: 30000, // 타임아웃을 30초로 증가
        validateStatus: () => true
      });

      // 응답 로그는 에러 발생 시에만 출력 (성공 시 로그 제거)
      if (response.status !== 200 || (response.data?.return_code !== undefined && response.data?.return_code !== 0 && response.data?.return_code !== 20)) {
        // 에러 또는 실패 시에만 상세 로그 출력
        console.log('[키움증권 API] 종목 정보 조회 응답:', {
          status: response.status,
          statusText: response.statusText,
          requestURL: url,
          returnCode: response.data?.return_code,
          returnMsg: response.data?.return_msg,
          responseDataType: typeof response.data
        });
      }

      if (isRateLimitPayload(response.status, response.data)) {
        const err = markRateLimit(response.data?.return_msg || response.data?.message, response.data);
        console.error('[키움증권 API] 종목 정보 조회 실패:', {
          message: err.message,
          status: 429,
        });
        err._alreadyLogged = true;
        throw err;
      }

      if (response.status !== 200) {
        throw this.handleError({ response });
      }

      // HTML 에러 페이지 응답 체크 (키움증권 API 에러 페이지로 리다이렉트되는 경우)
      const responseDataStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || '');
      if (responseDataStr && (responseDataStr.includes('<html') || responseDataStr.includes('<meta') || responseDataStr.includes('error.jsp'))) {
        const error = {
          status: 500,
          message: '키움증권 API에서 에러 페이지가 반환되었습니다. API 인증 정보나 엔드포인트를 확인해주세요.',
          data: response.data,
          _alreadyLogged: true // 로그 중복 방지 플래그
        };
        console.error('[키움증권 API] 종목 정보 조회 실패:', {
          message: error.message,
          status: error.status
        });
        throw error;
      }

      // 응답 데이터 구조 확인 (디버깅용)
      if (!response.data || typeof response.data !== 'object') {
        console.error('[키움증권 API] 잘못된 응답 구조:', { 
          status: response.status,
          dataType: typeof response.data,
          data: response.data 
        });
        throw {
          status: 500,
          message: '키움증권 API 응답 구조가 올바르지 않습니다.',
          data: response.data
        };
      }

      // 키움증권 API는 HTTP 200이어도 return_code로 성공/실패를 판단
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        // return_code: 20은 데이터 없음을 의미 (에러 아님)
        if (response.data.return_code === 20) {
          console.log('[키움증권 API] 종목 정보 없음:', response.data.return_msg);
          // 빈 응답 구조로 반환 (종목명 추출 실패를 의미)
          return {
            return_code: 20,
            return_msg: response.data.return_msg,
            output: []
          };
        } else if (isRateLimitPayload(200, response.data)) {
          const err = markRateLimit(response.data.return_msg, response.data);
          console.error('[키움증권 API] 종목 정보 조회 실패:', {
            message: err.message,
            status: 429,
          });
          err._alreadyLogged = true;
          throw err;
        } else {
          console.error('[키움증권 API] 종목 정보 조회 실패:', response.data);
          throw {
            status: 400,
            message: response.data.return_msg || '종목 정보 조회에 실패했습니다.',
            data: response.data
          };
        }
      }

      return response.data;
    } catch (error) {
      // 이미 처리된 에러 객체(status 속성이 있는 경우)는 그대로 throw
      // _alreadyLogged 플래그가 있으면 로그 중복 출력 방지
      if (error.status && error.message) {
        if (!error._alreadyLogged) {
          console.error('[키움증권 API] 종목 정보 조회 실패:', {
            message: error.message,
            status: error.status
          });
        }
        // 플래그 제거 후 throw
        delete error._alreadyLogged;
        throw error;
      }

      // 더 자세한 에러 정보 로깅
      const errorDetails = {
        message: error.message,
        code: error.code,
        responseStatus: error.response?.status,
        responseData: error.response?.data,
        requestUrl: error.config?.url,
        requestMethod: error.config?.method
      };
      console.error('[키움증권 API] 종목 정보 조회 실패:', JSON.stringify(errorDetails, null, 2));
      throw this.handleError(error);
    }
  }

  // 주식기본정보요청 (ka10001) - 시가총액 등 기본 정보 조회
  async getStockBasicInfo(accessToken, appKey, appSecret, stockCode, contYn = 'N', nextKey = '') {
    try {
      const endpoint = '/api/dostk/stkinfo';
      const url = `${this.baseURL}${endpoint}`;
      
      // 헤더 설정
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'authorization': `Bearer ${accessToken}`,
        'cont-yn': contYn,
        'next-key': nextKey,
        'api-id': 'ka10001', // TR명 (주식기본정보요청)
      };
      
      // 요청 본문 (ka10001 파라미터)
      const data = {
        stk_cd: stockCode, // 종목코드
      };

      const response = await axios.post(url, data, {
        headers,
        timeout: 30000,
        validateStatus: () => true
      });

      if (response.status !== 200) {
        throw this.handleError({ response });
      }

      // 키움증권 API는 HTTP 200이어도 return_code로 성공/실패를 판단
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        if (response.data.return_code === 20) {
          // 데이터 없음
          return null;
        }
        console.error('[키움증권 API] 주식기본정보 조회 실패:', response.data);
        throw {
          status: 400,
          message: response.data.return_msg || '주식기본정보 조회에 실패했습니다.',
          data: response.data
        };
      }

      return response.data;
    } catch (error) {
      console.error('[키움증권 API] 주식기본정보 조회 실패:', error.response?.data || error.message);
      throw this.handleError(error);
    }
  }

  // 주식 주문 (매수/매도) - kt10000 (주식주문) 또는 kt10001 (매도주문)
  async placeOrder(orderData, accessToken, appKey, appSecret, accountNo = null, dmstStexTp = 'KRX') {
    try {
      const endpoint = '/api/dostk/ordr';
      const url = `${this.baseURL}${endpoint}`;
      
      // 매도 주문인 경우 kt10001 사용, 매수 주문인 경우 kt10000 사용
      const apiId = orderData.orderType === 'sell' ? 'kt10001' : 'kt10000';
      
      // 헤더 설정
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'authorization': `Bearer ${accessToken}`,
        'cont-yn': 'N',
        'next-key': '',
        'api-id': apiId, // TR명 (kt10000: 주식주문, kt10001: 매도주문)
      };
      
      // 주문 파라미터 구성
      // orderData: { symbol, orderType: 'buy'|'sell', quantity, priceType: 'market'|'limit', price }
      // trde_tp: 0(보통/지정가), 3(시장가), 5(조건부지정가), 6(최유리지정가), 7(최우선지정가) 등
      const data = {
        dmst_stex_tp: dmstStexTp, // 국내거래소구분 (KRX, NXT, SOR)
        stk_cd: orderData.symbol, // 종목코드
        ord_qty: String(orderData.quantity), // 주문수량
        // 매매구분 (0: 보통/지정가, 3: 시장가, 6: 최유리지정가 — 매도 시 매수 최우선호가로 즉시 체결)
        trde_tp: orderData.priceType === 'market' ? '3' : orderData.priceType === 'best' ? '6' : '0',
        ord_uv: '', // 주문단가 (지정가인 경우)
        cond_uv: '', // 조건단가
      };
      
      // 지정가 주문인 경우 주문단가 추가
      if (orderData.priceType === 'limit' && orderData.price) {
        data.ord_uv = String(orderData.price); // 주문단가
      }
      
      console.log(`[키움증권 API] 주문 실행 (${apiId} - ${orderData.orderType === 'sell' ? '매도주문' : '주식주문'}):`, {
        url,
        apiId: headers['api-id'],
        orderType: orderData.orderType,
        accountNo,
        dmst_stex_tp: dmstStexTp,
        data
      });

      const response = await axios.post(url, data, {
        headers,
        timeout: 15000,
        validateStatus: () => true
      });

      console.log('[키움증권 API] 주문 응답:', {
        status: response.status,
        headers: {
          'next-key': response.headers['next-key'],
          'cont-yn': response.headers['cont-yn'],
          'api-id': response.headers['api-id']
        },
        data: response.data
      });

      if (response.status !== 200) {
        throw this.handleError({ response });
      }

      // 키움증권 API는 HTTP 200이어도 return_code로 성공/실패를 판단
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        console.error('[키움증권 API] 주문 실패:', response.data);
        throw {
          status: 400,
          message: response.data.return_msg || '주문 접수에 실패했습니다.',
          data: response.data
        };
      }

      // 주문번호는 ord_no만 사용 (ord_no_remn 등은 잔여/기타 필드로 오인 가능)
      const rawOrderNo =
        response.data.ord_no ??
        response.data.output?.ord_no ??
        null;
      const orderNo =
        rawOrderNo != null && String(rawOrderNo).trim() !== ''
          ? String(rawOrderNo).trim()
          : null;

      console.log('[키움증권 API] 주문번호 추출:', {
        ord_no: response.data.ord_no,
        output_ord_no: response.data.output?.ord_no,
        추출된_주문번호: orderNo,
        응답_전체_키: Object.keys(response.data)
      });

      // 주문번호를 포함하여 반환
      return {
        ...response.data,
        orderNo: orderNo // 주문번호를 명시적으로 추가
      };
    } catch (error) {
      console.error('[키움증권 API] 주문 실행 실패:', error.response?.data || error.message);
      throw this.handleError(error);
    }
  }

  /**
   * 주식 취소주문 (kt10003)
   * @param {{ symbol: string, orderNo: string, quantity: number|string }} cancelData
   */
  async cancelOrder(cancelData, accessToken, appKey, appSecret, accountNo = null, dmstStexTp = 'KRX') {
    try {
      const endpoint = '/api/dostk/ordr';
      const url = `${this.baseURL}${endpoint}`;
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        authorization: `Bearer ${accessToken}`,
        'cont-yn': 'N',
        'next-key': '',
        'api-id': 'kt10003',
      };
      const qty = cancelData.quantity != null ? String(cancelData.quantity) : '0';
      const rawOrd = String(cancelData.orderNo || '').trim();
      // 영웅문 주문번호는 보통 7자리 제로패딩
      const origOrdNo = /^\d+$/.test(rawOrd) ? rawOrd.padStart(7, '0') : rawOrd;
      const data = {
        dmst_stex_tp: dmstStexTp || 'KRX',
        stk_cd: String(cancelData.symbol || '').substring(0, 6),
        orig_ord_no: origOrdNo,
        cncl_qty: qty === '0' ? '0' : qty,
      };

      console.log('[키움증권 API] 취소주문 (kt10003):', {
        url,
        accountNo,
        dmst_stex_tp: data.dmst_stex_tp,
        data,
      });

      const response = await axios.post(url, data, {
        headers,
        timeout: 15000,
        validateStatus: () => true,
      });

      console.log('[키움증권 API] 취소주문 응답:', {
        status: response.status,
        data: response.data,
      });

      if (response.status !== 200) {
        throw this.handleError({ response });
      }
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        throw {
          status: 400,
          message: response.data.return_msg || '취소 주문 실패',
          data: response.data,
        };
      }
      return response.data;
    } catch (error) {
      console.error('[키움증권 API] 취소주문 실패:', error.response?.data || error.message || error);
      throw this.handleError ? this.handleError(error) : error;
    }
  }

  /**
   * 미국주식 매수/매도 주문
   * ust20000 매수, ust20001 매도
   * stex_tp: NA AMEX, ND NASDAQ, NY NYSE
   * trde_tp: 00 지정가, 03 시장가
   */
  async placeUsOrder(orderData, accessToken, appKey, appSecret, accountNo = null, stexTp = 'ND') {
    try {
      const apiId = orderData.orderType === 'sell' ? 'ust20001' : 'ust20000';
      const data = {
        stex_tp: String(stexTp || 'ND'),
        stk_cd: String(orderData.symbol || '').trim().toUpperCase(),
        ord_qty: String(orderData.quantity),
        ord_uv: '',
        trde_tp: orderData.priceType === 'market' ? '03' : '00',
      };
      if (orderData.priceType === 'limit' && orderData.price != null && orderData.price !== '') {
        data.ord_uv = formatUsOrderUnitPrice(orderData.price);
      }
      if (orderData.orderType === 'sell' && orderData.stopPrice != null && orderData.stopPrice !== '') {
        data.stop_pric = formatUsOrderUnitPrice(orderData.stopPrice);
      }

      console.log(`[키움증권 API] 미국 주문 실행 (${apiId}):`, {
        accountNo,
        stex_tp: data.stex_tp,
        orderType: orderData.orderType,
        data,
      });

      const result = await this.postUsTr(accessToken, '/api/us/ordr', apiId, data, {
        timeout: 15000,
      });
      const payload = result.data || {};

      if (payload.return_code !== undefined && payload.return_code !== 0) {
        console.error('[키움증권 API] 미국 주문 실패:', payload);
        throw {
          status: 400,
          message: payload.return_msg || '미국 주문 접수에 실패했습니다.',
          data: payload,
        };
      }

      const rawOrderNo = payload.ord_no ?? payload.output?.ord_no ?? null;
      const orderNo =
        rawOrderNo != null && String(rawOrderNo).trim() !== ''
          ? String(rawOrderNo).trim()
          : null;

      console.log('[키움증권 API] 미국 주문번호 추출:', {
        ord_no: payload.ord_no,
        추출된_주문번호: orderNo,
      });

      return {
        ...payload,
        orderNo,
      };
    } catch (error) {
      console.error('[키움증권 API] 미국 주문 실패:', error.data || error.message || error);
      throw this.handleError ? this.handleError(error) : error;
    }
  }

  /**
   * 미국주식 정정주문 (ust20002)
   * @param {{ symbol, orderNo, price }} amendData
   */
  async amendUsOrder(amendData, accessToken, appKey, appSecret, accountNo = null, stexTp = 'ND') {
    try {
      const rawOrd = String(amendData.orderNo || '').trim();
      const data = {
        orig_ord_no: rawOrd,
        stex_tp: String(stexTp || 'ND'),
        stk_cd: String(amendData.symbol || '').trim().toUpperCase(),
        mdfy_uv: formatUsOrderUnitPrice(amendData.price),
      };

      console.log('[키움증권 API] 미국 정정주문 (ust20002):', { accountNo, data });
      const result = await this.postUsTr(accessToken, '/api/us/ordr', 'ust20002', data, {
        timeout: 15000,
      });
      return result.data || {};
    } catch (error) {
      console.error('[키움증권 API] 미국 정정주문 실패:', error.data || error.message || error);
      throw this.handleError ? this.handleError(error) : error;
    }
  }

  /**
   * 미국주식 취소주문 (ust20003)
   * @param {{ symbol, orderNo }} cancelData
   */
  async cancelUsOrder(cancelData, accessToken, appKey, appSecret, accountNo = null, stexTp = 'ND') {
    try {
      const rawOrd = String(cancelData.orderNo || '').trim();
      const data = {
        orig_ord_no: rawOrd,
        stex_tp: String(stexTp || 'ND'),
        stk_cd: String(cancelData.symbol || '').trim().toUpperCase(),
      };

      console.log('[키움증권 API] 미국 취소주문 (ust20003):', { accountNo, data });
      const result = await this.postUsTr(accessToken, '/api/us/ordr', 'ust20003', data, {
        timeout: 15000,
      });
      return result.data || {};
    } catch (error) {
      console.error('[키움증권 API] 미국 취소주문 실패:', error.data || error.message || error);
      throw this.handleError ? this.handleError(error) : error;
    }
  }

  // 주문번호로 체결 여부 확인
  async checkOrderExecution(accessToken, appKey, appSecret, accountNo, orderNo, dmstStexTp = 'KRX', ordDt = null) {
    try {
      // 모의투자는 ord_dt 를 비우면 "조회내역이 없습니다" — 당일(KST) 지정
      const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
      const executions = await this.getOrderHistory(
        accessToken,
        appKey,
        appSecret,
        accountNo,
        ordDt || todayKst, // startDate
        null, // endDate
        'N', // contYn
        '', // nextKey
        dmstStexTp
      );

      // 주문번호로 필터링
      const wantOrderNo = String(orderNo || '').trim().replace(/^0+/, '');
      if (executions && executions.acnt_ord_cntr_prst_array) {
        const matchedExecutions = executions.acnt_ord_cntr_prst_array.filter(exec => {
          const execOrderNo = exec.ord_no || exec.ord_no_remn || exec.order_no || '';
          return String(execOrderNo).trim().replace(/^0+/, '') === wantOrderNo;
        });
        
        return {
          ...executions,
          acnt_ord_cntr_prst_array: matchedExecutions,
          orderNo: orderNo,
          isExecuted: matchedExecutions.length > 0,
          executionCount: matchedExecutions.length
        };
      }
      
      return {
        ...executions,
        orderNo: orderNo,
        isExecuted: false,
        executionCount: 0
      };
    } catch (error) {
      console.error('[키움증권 API] 주문번호로 체결 여부 확인 실패:', error);
      throw this.handleError(error);
    }
  }

  // 당일 체결내역 전체 (kt00009 연속조회 포함) — 여러 주문 체결 확인을 1회 조회로 처리
  async getTodayExecutionsAllPages(accessToken, appKey, appSecret, accountNo, dmstStexTp = 'KRX', maxPages = 10) {
    const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
    const rows = [];
    let contYn = 'N';
    let nextKey = '';
    const fetchPage = () =>
      this.getOrderHistory(
        accessToken, appKey, appSecret, accountNo, todayKst, null, contYn, nextKey, dmstStexTp
      );
    for (let page = 0; page < maxPages; page += 1) {
      let res;
      try {
        try {
          res = await fetchPage();
        } catch (err) {
          if (!isKiwoomRateLimitError(err)) throw err;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          res = await fetchPage();
        }
      } catch (err) {
        // 다음 페이지 실패 시 이미 받은 페이지로 대조 (최근 주문은 앞 페이지에 있음)
        if (page === 0) throw err;
        console.warn(
          `[키움증권 API] kt00009 ${page + 1}페이지 조회 실패 — 앞 ${page}페이지(${rows.length}건)로 처리: ${err?.message || err}`
        );
        break;
      }
      rows.push(...(res?.acnt_ord_cntr_prst_array || []));
      const cont = res?.__cont;
      if (!cont || cont.contYn !== 'Y' || !cont.nextKey) break;
      contYn = 'Y';
      nextKey = cont.nextKey;
    }
    return rows;
  }

  // 주문 내역 조회
  // 주문체결 내역 조회 (최근 6개월치) - kt00009 (계좌별주문체결현황요청)
  async getOrderHistory(accessToken, appKey, appSecret, accountNo = null, startDate = null, endDate = null, contYn = 'N', nextKey = '', dmstStexTp = 'KRX', orderNo = null) {
    try {
      // 시작일이 없으면 빈 문자열로 설정 (전체 조회)
      // Python 코드에 따르면 ord_dt가 빈 문자열이면 전체 조회가 가능
      if (!startDate) {
        startDate = ''; // 빈 문자열이면 전체 조회
      }

      // 키움증권 API 엔드포인트
      const endpoint = '/api/dostk/acnt';
      const url = `${this.baseURL}${endpoint}`;

      // 헤더 설정
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'authorization': `Bearer ${accessToken}`,
        'cont-yn': contYn,
        'next-key': nextKey,
        'api-id': 'kt00009', // TR명 (계좌별주문체결현황요청)
      };

      // 요청 본문 (kt00009 파라미터 - Python 코드 참고)
      // 주의: ord_dt를 특정 날짜로 지정하면 그 날짜 이후 데이터만 조회됨
      // 빈 문자열이면 최근 2개월 전체 조회 가능
      const data = {
        ord_dt: startDate || '', // 주문일자 YYYYMMDD (빈 문자열이면 최근 2개월 전체)
        stk_bond_tp: '0', // 주식채권구분 0:전체, 1:주식, 2:채권
        mrkt_tp: '0', // 시장구분 0:전체, 1:코스피, 2:코스닥, 3:OTCBB, 4:ECN
        sell_tp: '0', // 매도수구분 0:전체, 1:매도, 2:매수
        qry_tp: '1', // 조회구분 0:전체, 1:체결 (체결 내역만 조회)
        stk_cd: '', // 종목코드 (전문 조회할 종목코드, 빈 문자열이면 전체)
        fr_ord_no: '', // 시작주문번호 (특정 주문번호로 필터링하려면 이 값 사용)
        dmst_stex_tp: dmstStexTp, // 국내거래소구분 %:전체,KRX:한국거래소,NXT:넥스트트레이드,SOR:최선주문집행
      };
      
      // 주문번호로 필터링 (orderNo 파라미터가 있으면)
      // fr_ord_no에 주문번호를 설정하면 해당 주문번호 이후의 체결내역만 조회됨
      // 정확한 주문번호만 조회하려면 응답에서 필터링 필요
      
      if (accountNo) {
        data.acnt_no = accountNo;
      }

      // 주문번호가 있으면 fr_ord_no에 설정 (해당 주문번호 이후의 체결내역 조회)
      if (orderNo) {
        data.fr_ord_no = String(orderNo);
      }

      const response = await axios.post(url, data, {
        headers,
        timeout: 15000,
        validateStatus: () => true
      });

      if (process.env.KIWOOM_API_VERBOSE === '1') {
        console.log('[키움증권 API] 주문체결 내역 응답:', {
          status: response.status,
          count: response.data?.acnt_ord_cntr_prst_array?.length ?? 0,
        });
      }
      
      // kt00009 응답: acnt_ord_cntr_prst_array 필드에 체결 내역 배열
      if (
        process.env.KIWOOM_API_VERBOSE === '1' &&
        response.data &&
        response.data.acnt_ord_cntr_prst_array &&
        Array.isArray(response.data.acnt_ord_cntr_prst_array) &&
        response.data.acnt_ord_cntr_prst_array.length > 0
      ) {
        const firstItem = response.data.acnt_ord_cntr_prst_array[0];
        console.log('[키움증권 API] kt00009 샘플:', JSON.stringify(firstItem, null, 2));
      }

      if (response.status !== 200) {
        throw this.handleError({ response });
      }

      // 키움증권 API는 HTTP 200이어도 return_code로 성공/실패를 판단
      // return_code: 20은 "관련자료가없습니다"를 의미하지만, 이는 데이터가 없는 경우이므로 에러가 아님
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        // return_code: 20은 데이터 없음을 의미 (에러 아님)
        if (response.data.return_code === 20) {
          console.log('[키움증권 API] 주문체결 내역 없음:', response.data.return_msg);
          // 빈 배열 구조로 반환
          return {
            return_code: 0,
            return_msg: response.data.return_msg,
            acnt_ord_cntr_prst_array: []
          };
        } else {
          // 다른 에러 코드는 실제 에러로 처리
          console.error('[키움증권 API] 주문체결 내역 조회 실패:', response.data);
          throw {
            status: 400,
            message: response.data.return_msg || '주문체결 내역 조회에 실패했습니다.',
            data: response.data
          };
        }
      }

      // 연속조회 정보 (응답 직렬화에 섞이지 않도록 non-enumerable)
      Object.defineProperty(response.data, '__cont', {
        value: {
          contYn: String(response.headers?.['cont-yn'] || 'N').toUpperCase(),
          nextKey: String(response.headers?.['next-key'] || ''),
        },
        enumerable: false,
      });
      return response.data;
    } catch (error) {
      console.error('[키움증권 API] 주문체결 내역 조회 실패:', error.response?.data || error.message);
      throw this.handleError(error);
    }
  }

  // 액세스 토큰 발급 (OAuth2 Client Credentials)
  async generateAccessToken(appKey, appSecret) {
    try {
      const tokenURL = getKiwoomTokenUrl();
      
      // App Key와 App Secret 검증
      if (!appKey || !appSecret) {
        throw {
          status: 400,
          message: 'App Key와 App Secret이 필요합니다.',
          data: null
        };
      }

      // 공백 제거
      const trimmedAppKey = appKey.trim();
      const trimmedAppSecret = appSecret.trim();

      console.log('[키움증권 API] 토큰 발급 요청:', {
        url: tokenURL,
        appKey: trimmedAppKey ? `${trimmedAppKey.substring(0, 4)}...` : '없음',
        hasAppSecret: !!trimmedAppSecret,
        appKeyLength: trimmedAppKey.length,
        appSecretLength: trimmedAppSecret.length
      });

      // 요청 본문 준비 (키움증권 API 형식)
      // 키움증권 API는 secretkey를 사용 (appsecret이 아님)
      const requestBody = {
        grant_type: 'client_credentials',
        appkey: trimmedAppKey,
        secretkey: trimmedAppSecret, // 키움증권은 secretkey 사용
      };

      // 키움증권 API는 JSON 형식으로 요청 (키움증권 공식 형식)
      const response = await axios.post(
        tokenURL,
        requestBody, // JSON 객체로 전송
        {
          headers: {
            'Content-Type': 'application/json;charset=UTF-8', // 키움증권 공식 형식
            'Accept': 'application/json',
          },
          timeout: 15000, // 15초 타임아웃
          validateStatus: () => true, // 모든 상태 코드를 응답으로 받음
        }
      );

      // 키움증권 API 응답 형식 확인
      // 성공 시: return_code: 0, token 포함
      // 실패 시: return_code: 0이 아님, return_msg 포함
      
      // 응답 상태 확인
      if (response.status !== 200) {
        console.error('[키움증권 API] 토큰 발급 실패 응답:', {
          status: response.status,
          statusText: response.statusText,
          data: response.data
        });
        throw {
          status: response.status,
          message: response.data?.return_msg || response.data?.error_description || response.data?.message || '토큰 발급에 실패했습니다.',
          data: response.data
        };
      }

      // 키움증권 API 응답 형식: return_code로 성공/실패 판단
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        // 키움증권 API 에러 응답
        console.error('[키움증권 API] 토큰 발급 실패:', response.data);
        throw {
          status: 400,
          message: response.data.return_msg || '토큰 발급에 실패했습니다.',
          data: response.data
        };
      }

      // 응답 데이터 검증 (키움증권은 "token" 필드 사용, "access_token" 아님)
      if (!response.data || !response.data.token) {
        console.error('[키움증권 API] 토큰 발급 응답 형식 오류:', response.data);
        throw {
          status: 500,
          message: response.data?.return_msg || '토큰 발급 응답 형식이 올바르지 않습니다.',
          data: response.data
        };
      }

      console.log('[키움증권 API] 토큰 발급 성공:', {
        hasToken: !!response.data.token,
        tokenType: response.data.token_type,
        expiresDt: response.data.expires_dt,
        returnCode: response.data.return_code,
        returnMsg: response.data.return_msg
      });

      // 키움증권 API 응답을 표준 형식으로 변환
      // 키움증권: { token, expires_dt }
      // 표준 형식: { access_token, expires_in }
      const expiresDt = response.data.expires_dt; // "20241107083713" 형식
      let expiresIn = 86400; // 기본 24시간
      
      if (expiresDt) {
        // expires_dt를 파싱하여 만료까지 남은 시간 계산
        // 형식: "YYYYMMDDHHmmss"
        try {
          const year = parseInt(expiresDt.substring(0, 4));
          const month = parseInt(expiresDt.substring(4, 6)) - 1;
          const day = parseInt(expiresDt.substring(6, 8));
          const hour = parseInt(expiresDt.substring(8, 10));
          const minute = parseInt(expiresDt.substring(10, 12));
          const second = parseInt(expiresDt.substring(12, 14));
          
          const expiresDate = new Date(year, month, day, hour, minute, second);
          const now = new Date();
          expiresIn = Math.floor((expiresDate - now) / 1000);
          
          if (expiresIn < 0) {
            expiresIn = 86400; // 과거 날짜면 기본값 사용
          }
        } catch (e) {
          console.warn('[키움증권 API] expires_dt 파싱 실패, 기본값 사용:', e);
        }
      }

      // 표준 형식으로 변환하여 반환
      return {
        access_token: response.data.token, // token을 access_token으로 변환
        token_type: response.data.token_type || 'bearer',
        expires_in: expiresIn,
        expires_dt: expiresDt, // 원본 값도 포함
        return_code: response.data.return_code,
        return_msg: response.data.return_msg
      };
    } catch (error) {
      // 이미 처리된 에러는 그대로 throw
      if (error.status) {
        throw error;
      }

      console.error('[키움증권 API] 토큰 발급 실패:', {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        code: error.code,
        stack: error.stack
      });
      throw this.handleError(error);
    }
  }

  // 에러 처리
  handleError(error) {
    // 이미 처리된 에러 객체(status 속성이 있는 경우)는 그대로 반환
    if (error.status && error.message) {
      return {
        status: error.status,
        message: error.message,
        data: error.data
      };
    }

    if (error.response) {
      // 서버가 응답했지만 에러 상태 코드
      const status = error.response.status;
      const responseData = error.response.data;
      
      // HTML 에러 페이지 응답 체크
      const responseDataStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || '');
      if (responseDataStr && (responseDataStr.includes('<html') || responseDataStr.includes('<meta') || responseDataStr.includes('error.jsp'))) {
        return {
          status: 500,
          message: '키움증권 API에서 에러 페이지가 반환되었습니다. API 인증 정보나 엔드포인트를 확인해주세요.',
          data: responseData
        };
      }
      
      // 상세한 에러 메시지 구성
      let errorMessage = 'API 요청 실패';
      
      if (responseData) {
        if (typeof responseData === 'string') {
          errorMessage = responseData;
        } else if (responseData.return_msg) {
          // 키움증권 API 에러 메시지 (가장 우선 처리)
          errorMessage = responseData.return_msg;
        } else if (responseData.error_description) {
          // 키움증권 OAuth2 에러 형식
          errorMessage = responseData.error_description;
        } else if (responseData.msg) {
          errorMessage = responseData.msg;
        } else if (responseData.message) {
          errorMessage = responseData.message;
        } else if (responseData.rt_cd) {
          // 키움증권 API 에러 코드 형식
          errorMessage = responseData.msg1 || responseData.msg || `에러 코드: ${responseData.rt_cd}`;
        }
      }
      
      // 디버깅을 위한 상세 로깅 (responseData가 있지만 메시지를 찾지 못한 경우)
      if (errorMessage === 'API 요청 실패' && responseData) {
        console.error('[키움증권 API] 에러 응답 상세:', {
          status,
          responseData,
          responseDataKeys: Object.keys(responseData),
          responseDataString: JSON.stringify(responseData).substring(0, 500)
        });
      }
      
      // 상태 코드에 따른 기본 메시지
      if (status === 401) {
        errorMessage = errorMessage || '인증에 실패했습니다. App Key와 App Secret을 확인해주세요.';
      } else if (status === 403) {
        errorMessage = errorMessage || '접근이 거부되었습니다. IP 등록 상태를 확인해주세요.';
      } else if (status === 404) {
        errorMessage = errorMessage || 'API 엔드포인트를 찾을 수 없습니다.';
      } else if (status >= 500) {
        errorMessage = errorMessage || '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
      }
      
      return {
        status: status,
        message: errorMessage,
        data: responseData
      };
    } else if (error.request) {
      // 요청은 보냈지만 응답을 받지 못함
      let errorMessage = '서버에 연결할 수 없습니다.';
      
      if (error.code === 'ECONNREFUSED') {
        errorMessage = '연결이 거부되었습니다. API 서버 주소를 확인해주세요.';
      } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        errorMessage = '연결 시간이 초과되었습니다. 네트워크 상태를 확인해주세요.';
      } else if (error.code === 'ENOTFOUND') {
        errorMessage = 'API 서버를 찾을 수 없습니다. URL을 확인해주세요.';
      }
      
      // 네트워크 오류 상세 로깅
      console.error('[키움증권 API] 네트워크 오류:', {
        code: error.code,
        message: error.message,
        requestUrl: error.config?.url,
        requestMethod: error.config?.method,
        timeout: error.config?.timeout
      });
      
      return {
        status: 500,
        message: errorMessage,
        data: { code: error.code, message: error.message }
      };
    } else {
      // 요청 설정 중 오류
      console.error('[키움증권 API] 요청 설정 오류:', {
        message: error.message,
        stack: error.stack,
        config: error.config
      });
      
      return {
        status: 500,
        message: error.message || '알 수 없는 오류가 발생했습니다.',
        data: { message: error.message }
      };
    }
  }

  // 거래대금 상위 종목 조회 (ka10032 - 거래대금상위요청)
  async getTopTradingValueStocks(accessToken, appKey, appSecret, limit = 50, mrktTp = '000', contYn = 'N', nextKey = '') {
    try {
      console.log(`[키움증권 API] 거래대금 상위 ${limit}위 종목 조회 시작 (시장구분: ${mrktTp})`);
      
      const endpoint = '/api/dostk/rkinfo';
      const url = `${this.baseURL}${endpoint}`;
      
      // 헤더 설정
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'authorization': `Bearer ${accessToken}`,
        'cont-yn': contYn,
        'next-key': nextKey,
        'api-id': 'ka10032', // TR명 (거래대금상위요청)
      };
      
      // 요청 본문 (ka10032 파라미터)
      const data = {
        mrkt_tp: mrktTp, // 시장구분 000:전체, 001:코스피, 101:코스닥
        mang_stk_incls: '1', // 관리종목포함 0:관리종목 미포함, 1:관리종목 포함
        stex_tp: '3', // 거래소구분 1:KRX, 2:NXT, 3:통합
      };

      const response = await axios.post(url, data, {
        headers,
        timeout: 30000,
        validateStatus: () => true
      });

      if (response.status !== 200) {
        throw this.handleError({ response });
      }

      // 응답 데이터 구조 확인 (디버깅)
      console.log('[키움증권 API] 거래대금 상위 종목 응답 구조:', {
        status: response.status,
        returnCode: response.data?.return_code,
        returnMsg: response.data?.return_msg,
        responseKeys: Object.keys(response.data || {}),
        responseDataType: typeof response.data
      });

      // 키움증권 API는 HTTP 200이어도 return_code로 성공/실패를 판단
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        console.error('[키움증권 API] 거래대금 상위 종목 조회 실패:', response.data);
        throw {
          status: 400,
          message: response.data.return_msg || '거래대금 상위 종목 조회에 실패했습니다.',
          data: response.data
        };
      }

      // 응답에서 종목 정보 추출
      const stockList = [];
      let responseData = response.data;
      
      // 응답 구조 확인 및 로깅
      console.log('[키움증권 API] 응답 데이터 전체 구조:', JSON.stringify(responseData, null, 2));
      
      // 다양한 응답 구조 지원
      let stockArray = null;
      
      // 1. atn_stk_infr 확인
      if (responseData.atn_stk_infr) {
        console.log('[키움증권 API] atn_stk_infr 발견:', Array.isArray(responseData.atn_stk_infr), responseData.atn_stk_infr?.length);
        stockArray = Array.isArray(responseData.atn_stk_infr) ? responseData.atn_stk_infr : null;
      }
      
      // 2. output 확인
      if (!stockArray && responseData.output) {
        console.log('[키움증권 API] output 발견:', Array.isArray(responseData.output), responseData.output?.length);
        stockArray = Array.isArray(responseData.output) ? responseData.output : null;
      }
      
      // 3. output1 확인
      if (!stockArray && responseData.output1) {
        console.log('[키움증권 API] output1 발견:', Array.isArray(responseData.output1), responseData.output1?.length);
        stockArray = Array.isArray(responseData.output1) ? responseData.output1 : null;
      }
      
      // 4. data 확인
      if (!stockArray && responseData.data) {
        console.log('[키움증권 API] data 발견:', Array.isArray(responseData.data), responseData.data?.length);
        stockArray = Array.isArray(responseData.data) ? responseData.data : null;
      }
      
      // 5. 배열 자체인 경우
      if (!stockArray && Array.isArray(responseData)) {
        console.log('[키움증권 API] 응답이 배열임');
        stockArray = responseData;
      }
      
      // 6. 객체의 값들 중 배열 찾기
      if (!stockArray && typeof responseData === 'object') {
        const values = Object.values(responseData);
        for (const value of values) {
          if (Array.isArray(value) && value.length > 0) {
            console.log('[키움증권 API] 객체 값에서 배열 발견:', value.length);
            stockArray = value;
            break;
          }
        }
      }

      if (stockArray && Array.isArray(stockArray) && stockArray.length > 0) {
        console.log(`[키움증권 API] 종목 배열 발견: ${stockArray.length}건`);
        console.log('[키움증권 API] 첫 번째 항목 구조:', JSON.stringify(stockArray[0], null, 2));
        console.log('[키움증권 API] 첫 번째 항목 키들:', Object.keys(stockArray[0] || {}));
        
        stockArray.forEach((item, index) => {
          // 모든 키 출력 (디버깅)
          if (index === 0) {
            console.log('[키움증권 API] 첫 번째 항목의 모든 키:', Object.keys(item));
            console.log('[키움증권 API] 첫 번째 항목 전체 데이터:', JSON.stringify(item, null, 2));
          }
          
          // 다양한 필드명 지원 (키움증권 API의 다양한 필드명 패턴)
          const stockCode = item.stk_cd || item.pdno || item.code || item.stock_code || item.stk_cd_remn || '';
          const stockName = item.stk_nm || item.pdno_nm || item.itm_nm || item.name || item.stock_name || item.stk_nm_remn || '';
          
          // 거래대금 필드명 (trde_prica가 실제 필드명)
          let tradingValue = 0;
          const tradingValueFields = [
            'trde_prica', // 실제 필드명
            'acml_tr_pbmn', 'trd_amt', 'acml_tr_pbmn_remn', 'trdval', 'trading_value', 
            'trdval_remn', 'trd_amt_remn', 'trd_pbmn', 'trd_pbmn_remn',
            'acml_tr_pbmn_remn', 'trd_amt_remn', 'trdval_remn', 'trd_pbmn_remn'
          ];
          for (const field of tradingValueFields) {
            if (item[field] !== undefined && item[field] !== null && item[field] !== '') {
              const val = parseFloat(item[field]);
              if (!isNaN(val) && val > 0) {
                tradingValue = val;
                if (index === 0) console.log(`[키움증권 API] 거래대금 필드 발견: ${field} = ${tradingValue}`);
                break;
              }
            }
          }
          
          // 현재가 필드명 (모든 가능한 필드명 시도)
          let price = 0;
          const priceFields = [
            'stck_prpr', 'prpr', 'stck_prpr_remn', 'now_prc', 'price', 
            'prpr_remn', 'cur_prc', 'current_price', 'stck_prpr_remn',
            'prpr_remn', 'now_prc_remn', 'cur_prc_remn', 'stck_prpr_clpr',
            'clpr', 'clpr_remn', 'base_prpr', 'base_prpr_remn', 'stck_prpr_clpr_remn'
          ];
          
          // 현재가 필드 디버깅 (첫 번째 항목만)
          if (index === 0) {
            console.log('[키움증권 API] 현재가 필드 검색 시작');
            console.log('[키움증권 API] stck_prpr 값:', item.stck_prpr, '타입:', typeof item.stck_prpr);
            console.log('[키움증권 API] prpr 값:', item.prpr, '타입:', typeof item.prpr);
            
            // 'prpr' 또는 'prc' 또는 'price'가 포함된 모든 필드 찾기
            const priceRelatedFields = Object.keys(item).filter(key => 
              key.toLowerCase().includes('prpr') || 
              key.toLowerCase().includes('prc') || 
              key.toLowerCase().includes('price')
            );
            console.log('[키움증권 API] 가격 관련 필드들:', priceRelatedFields.map(f => `${f}: ${item[f]}`));
          }
          
          for (const field of priceFields) {
            if (item[field] !== undefined && item[field] !== null && item[field] !== '') {
              const val = parseFloat(item[field]);
              if (!isNaN(val)) { // 0도 유효한 값일 수 있으므로 > 0 조건 제거
                price = val;
                if (index === 0) console.log(`[키움증권 API] 현재가 필드 발견: ${field} = ${price}`);
                break;
              } else if (index === 0) {
                console.log(`[키움증권 API] 현재가 필드 ${field} 값 파싱 실패:`, item[field]);
              }
            } else if (index === 0 && (field === 'stck_prpr' || field === 'prpr')) {
              console.log(`[키움증권 API] 현재가 필드 ${field} 없음 또는 빈 값`);
            }
          }
          
          // 현재가를 찾지 못한 경우 (첫 번째 항목만)
          if (index === 0 && price === 0) {
            console.log('[키움증권 API] 현재가 필드를 찾지 못함. 모든 필드명:', Object.keys(item));
          }
          
          // 전일대비 필드명 (pred_pre가 실제 필드명)
          let prevChange = 0;
          const prevChangeFields = [
            'pred_pre', // 실제 필드명 (전일대비)
            'pred_pre_remn', 'prev_change', 'prev_change_price',
            'prdy_ctrt', 'prdy_ctrt_remn', 'change', 'change_price',
            'vs', 'vs_remn', 'prdy_vrss', 'prdy_vrss_remn',
            'fltt_rt', 'fltt_rt_remn', 'prdy_vrss_sign', 'prdy_vrss_sign_remn'
          ];
          
          // 전일대비 필드 디버깅 (모든 종목에 대해)
          if (index < 3) {
            console.log(`[키움증권 API] 종목 ${stockCode} 전일대비 필드 검색 시작`);
            console.log(`[키움증권 API] 종목 ${stockCode} pred_pre 값:`, item.pred_pre, '타입:', typeof item.pred_pre);
            console.log(`[키움증권 API] 종목 ${stockCode} pred_pre_remn 값:`, item.pred_pre_remn, '타입:', typeof item.pred_pre_remn);
            
            // 'pred' 또는 'prev' 또는 'change' 또는 'vs' 또는 'vrss'가 포함된 모든 필드 찾기
            const changeRelatedFields = Object.keys(item).filter(key => 
              key.toLowerCase().includes('pred') || 
              key.toLowerCase().includes('prev') || 
              key.toLowerCase().includes('change') ||
              key.toLowerCase().includes('vs') ||
              key.toLowerCase().includes('vrss') ||
              key.toLowerCase().includes('fltt')
            );
            console.log(`[키움증권 API] 종목 ${stockCode} 전일대비 관련 필드들:`, changeRelatedFields.map(f => `${f}: ${item[f]}`));
          }
          
          for (const field of prevChangeFields) {
            if (item[field] !== undefined && item[field] !== null && item[field] !== '') {
              // 문자열인 경우 숫자 부분만 추출 (예: "+100", "-50", "100" 등)
              let valStr = String(item[field]).trim();
              // + 또는 - 기호 제거 후 파싱
              const val = parseFloat(valStr.replace(/[+\-]/g, ''));
              
              if (!isNaN(val)) {
                // 원래 값이 음수였는지 확인
                if (valStr.startsWith('-') || valStr.includes('-')) {
                  prevChange = -val;
                } else {
                  prevChange = val;
                }
                if (index < 3) console.log(`[키움증권 API] 종목 ${stockCode} 전일대비 필드 발견: ${field} = ${item[field]} -> ${prevChange}`);
                break;
              } else if (index < 3) {
                console.log(`[키움증권 API] 종목 ${stockCode} 전일대비 필드 ${field} 값 파싱 실패:`, item[field]);
              }
            } else if (index < 3 && field === 'pred_pre') {
              console.log(`[키움증권 API] 종목 ${stockCode} 전일대비 필드 ${field} 없음 또는 빈 값`);
            }
          }
          
          // 전일대비를 찾지 못한 경우 (처음 3개 종목만)
          if (index < 3 && prevChange === 0) {
            console.log(`[키움증권 API] 종목 ${stockCode} 전일대비 필드를 찾지 못함. 모든 필드명:`, Object.keys(item));
            // 모든 필드의 값 출력
            console.log(`[키움증권 API] 종목 ${stockCode} 모든 필드 값:`, JSON.stringify(item, null, 2));
          }
          
          // 현재 거래량 필드명 (now_trde_qty가 실제 필드명)
          let volume = 0;
          const volumeFields = [
            'now_trde_qty', // 실제 필드명 (현재 거래량)
            'acml_vol', 'vol', 'acml_vol_remn', 'volume', 'vol_remn',
            'trd_qty', 'trading_volume', 'acml_vol_remn', 'vol_remn',
            'trd_qty_remn', 'trading_volume_remn'
          ];
          for (const field of volumeFields) {
            if (item[field] !== undefined && item[field] !== null && item[field] !== '') {
              const val = parseFloat(item[field]);
              if (!isNaN(val) && val > 0) {
                volume = val;
                if (index === 0) console.log(`[키움증권 API] 현재 거래량 필드 발견: ${field} = ${volume}`);
                break;
              }
            }
          }
          
          // 전일 거래량 필드명 (pred_trde_qty가 실제 필드명)
          let prevVolume = 0;
          const prevVolumeFields = [
            'pred_trde_qty', // 실제 필드명 (전일 거래량)
            'prev_vol', 'prev_volume', 'pred_vol', 'pred_volume',
            'acml_vol_prev', 'vol_prev', 'prev_trde_qty', 'pred_trde_qty_remn',
            'acml_vol', 'acml_vol_remn' // 누적 거래량도 확인
          ];
          
          // 전일 거래량 필드 디버깅 (첫 번째 항목만)
          if (index === 0) {
            console.log('[키움증권 API] 전일 거래량 필드 검색 시작');
            console.log('[키움증권 API] pred_trde_qty 값:', item.pred_trde_qty, '타입:', typeof item.pred_trde_qty);
            console.log('[키움증권 API] pred_trde_qty_remn 값:', item.pred_trde_qty_remn, '타입:', typeof item.pred_trde_qty_remn);
            
            // 'pred' 또는 'prev' 또는 'qty'가 포함된 모든 필드 찾기
            const volumeRelatedFields = Object.keys(item).filter(key => 
              (key.toLowerCase().includes('pred') || 
               key.toLowerCase().includes('prev') || 
               key.toLowerCase().includes('qty')) &&
              key.toLowerCase().includes('trde')
            );
            console.log('[키움증권 API] 거래량 관련 필드들:', volumeRelatedFields.map(f => `${f}: ${item[f]}`));
          }
          
          for (const field of prevVolumeFields) {
            if (item[field] !== undefined && item[field] !== null && item[field] !== '') {
              const val = parseFloat(item[field]);
              if (!isNaN(val)) { // 0도 유효한 값일 수 있으므로 > 0 조건 제거
                prevVolume = val;
                if (index === 0) console.log(`[키움증권 API] 전일 거래량 필드 발견: ${field} = ${prevVolume}`);
                break;
              } else if (index === 0) {
                console.log(`[키움증권 API] 전일 거래량 필드 ${field} 값 파싱 실패:`, item[field]);
              }
            } else if (index === 0 && field === 'pred_trde_qty') {
              console.log(`[키움증권 API] 전일 거래량 필드 ${field} 없음 또는 빈 값`);
            }
          }
          
          // 전일 거래량을 찾지 못한 경우 (첫 번째 항목만)
          if (index === 0 && prevVolume === 0) {
            console.log('[키움증권 API] 전일 거래량 필드를 찾지 못함. 모든 필드명:', Object.keys(item));
          }
          
          // 모든 숫자 필드 확인 (디버깅용)
          if (index === 0) {
            const numericFields = Object.keys(item).filter(key => {
              const val = item[key];
              return (typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))) && parseFloat(val) > 0;
            });
            console.log('[키움증권 API] 숫자 값이 있는 필드들:', numericFields.map(field => `${field}: ${item[field]}`));
          }
          
          if (stockCode && stockName) {
            // 현재거래량 대비 감소여부 계산
            const isDecreased = prevVolume > 0 && volume < prevVolume;
            const decreaseRate = prevVolume > 0 ? ((prevVolume - volume) / prevVolume * 100) : 0;
            
            stockList.push({
              stockCode,
              stockName,
              tradingValue,
              price,
              prevChange, // 전일대비
              volume, // 현재 거래량
              prevVolume, // 전일 거래량
              isDecreased, // 감소 여부
              decreaseRate // 감소율 (%)
            });
            
            // 처음 3개 항목의 추출된 값 로깅
            if (index < 3) {
              console.log(`[키움증권 API] 종목 ${index + 1} 추출 결과:`, {
                stockCode,
                stockName,
                tradingValue,
                price,
                volume,
                rawItem: item
              });
            }
          } else if (index < 3) {
            // 처음 3개 항목의 구조를 로깅
            console.log(`[키움증권 API] 종목 정보 추출 실패 (인덱스 ${index}):`, {
              keys: Object.keys(item),
              item: JSON.stringify(item, null, 2)
            });
          }
        });
      } else {
        console.log('[키움증권 API] 종목 배열을 찾을 수 없음. 응답 데이터:', JSON.stringify(responseData, null, 2));
      }

      // 거래대금으로 정렬 (내림차순)
      stockList.sort((a, b) => b.tradingValue - a.tradingValue);
      
      // 상위 N개만 반환
      const topStocks = stockList.slice(0, limit);
      
      console.log(`[키움증권 API] 거래량 상위 ${limit}위 종목 조회 완료: ${topStocks.length}건`);
      
      // 종목코드와 종목명을 파일로 저장
      const filePath = path.join(DATA_DIR, 'top_volume_stocks.json');
      const fileDir = path.dirname(filePath);
      
      // 디렉토리가 없으면 생성
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
      }
      
      // 저장할 데이터 구조 (종목코드, 종목명만)
      const stocksToSave = topStocks.map(stock => ({
        stockCode: stock.stockCode,
        stockName: stock.stockName
      }));
      
      // 파일에 저장
      fs.writeFileSync(filePath, JSON.stringify(stocksToSave, null, 2), 'utf8');
      console.log(`[키움증권 API] 거래량 상위 ${limit}위 종목을 파일에 저장: ${filePath}`);
      
      // 파일에서 읽어온 종목들의 시가총액 체크
      const MIN_MARKET_CAP = 3000000000000; // 3조원
      const filteredStocks = [];
      
      // 순차적으로 처리하여 API 호출 제한 방지
      for (let i = 0; i < topStocks.length; i++) {
        const stock = topStocks[i];
        
        try {
          // API 호출 간 딜레이 추가 (200ms) - API 제한 방지
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          
          const basicInfo = await this.getStockBasicInfo(accessToken, appKey, appSecret, stock.stockCode);
          
          // ka10001 API 응답에서 시가총액 및 업종 정보 추출
          let marketCap = 0;
          let sector = ''; // 업종
          
          // 다양한 응답 구조 확인
          let output = null;
          if (basicInfo && basicInfo.output) {
            output = Array.isArray(basicInfo.output) ? basicInfo.output[0] : basicInfo.output;
          } else if (basicInfo && basicInfo.data) {
            output = Array.isArray(basicInfo.data) ? basicInfo.data[0] : basicInfo.data;
          } else if (basicInfo && typeof basicInfo === 'object') {
            // output이 없으면 basicInfo 자체가 output일 수 있음
            output = basicInfo;
          }
          
          if (output) {
            // 첫 번째 종목에서만 상세 로그 출력
            if (i === 0) {
              console.log(`[키움증권 API] 종목 ${stock.stockCode} output 구조:`, JSON.stringify(output, null, 2));
              console.log(`[키움증권 API] 종목 ${stock.stockCode} output 키들:`, Object.keys(output));
            }
            
            // 업종 정보 추출 (다양한 필드명 시도)
            const sectorFields = ['sector', 'sctr', 'stck_sctr', 'sctr_nm', 'sector_nm', 'itms_sctr_nm', 'itms_sctr'];
            for (const field of sectorFields) {
              if (output[field] && output[field] !== '') {
                sector = String(output[field]).trim();
                if (i === 0) console.log(`[키움증권 API] 업종 필드 발견: ${field} = ${sector}`);
                break;
              }
            }
            
            // 업종이 없으면 종목명 기반으로 분류
            if (!sector) {
              sector = this.classifyThemeByStockName(stock.stockName);
            }
            
            // 시가총액 필드명 후보들 (mac이 실제 필드명)
            const marketCapFields = [
              'mac', // 실제 필드명
              'mrkt_cap', 'market_cap', 'market_capitalization', 'stck_mrkt_cap',
              'mrkt_cap_remn', 'stck_mrkt_cap_remn', 'market_cap_remn',
              'tot_mrkt_cap', 'total_market_cap', 'tot_mrkt_cap_remn',
              'mrkt_tot_amt', 'stck_mrkt_tot_amt'
            ];
            
            for (const field of marketCapFields) {
              if (output[field] !== undefined && output[field] !== null && output[field] !== '') {
                const val = parseFloat(output[field]);
                if (!isNaN(val)) {
                  // mac 필드는 억원 단위이므로 원 단위로 변환 (억원 * 100,000,000)
                  if (field === 'mac') {
                    marketCap = val * 100000000; // 억원을 원으로 변환
                  } else {
                    marketCap = val;
                  }
                  console.log(`[키움증권 API] 종목 ${stock.stockCode} 시가총액 필드 발견: ${field} = ${output[field]} (${field === 'mac' ? '억원' : '원'}) -> ${marketCap.toLocaleString()}원`);
                  break;
                } else {
                  console.log(`[키움증권 API] 종목 ${stock.stockCode} 필드 ${field} 값 파싱 실패:`, output[field]);
                }
              }
            }
            
            // mac 필드가 없으면 모든 필드 확인
            if (marketCap === 0) {
              const allFields = Object.keys(output);
              console.log(`[키움증권 API] 종목 ${stock.stockCode} 시가총액을 찾지 못함. 모든 필드:`, allFields);
              // 숫자 값이 있는 필드들 확인
              const numericFields = allFields.filter(key => {
                const val = output[key];
                return (typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))) && parseFloat(val) > 0;
              });
              console.log(`[키움증권 API] 종목 ${stock.stockCode} 숫자 값이 있는 필드들:`, numericFields.map(f => `${f}: ${output[f]}`));
            }
          } else {
            console.log(`[키움증권 API] 종목 ${stock.stockCode} output을 찾을 수 없음`);
          }
          
          // 시가총액 3조 이상인 종목만 추가
          if (marketCap >= MIN_MARKET_CAP) {
            filteredStocks.push({
              ...stock,
              marketCap,
              sector: sector || '기타'
            });
            console.log(`[키움증권 API] 시가총액 3조 이상 종목 추가: ${stock.stockCode} (${stock.stockName}), 시가총액: ${marketCap.toLocaleString()}, 업종: ${sector || '기타'}`);
          } else {
            console.log(`[키움증권 API] 시가총액 3조 미만 종목 제외: ${stock.stockCode} (${stock.stockName}), 시가총액: ${marketCap.toLocaleString()}`);
          }
        } catch (error) {
          // API 제한 에러인 경우 중단
          if (error.message && error.message.includes('허용된 요청 개수를 초과')) {
            console.error(`[키움증권 API] API 호출 제한 초과, 조회 중단 (${filteredStocks.length}개 수집됨)`);
            break;
          }
          console.error(`[키움증권 API] 종목 ${stock.stockCode} 시가총액 조회 실패:`, error.message);
          // 에러 발생 시 해당 종목은 건너뛰기
          continue;
        }
      }
      
      console.log(`[키움증권 API] 거래량 상위 ${limit}위 종목 중 시가총액 3조 이상 필터링 완료: ${filteredStocks.length}건`);
      
      // 필터링된 결과를 파일에 저장
      const resultFilePath = path.join(DATA_DIR, 'filtered_stocks.json');
      const resultFileDir = path.dirname(resultFilePath);
      
      // 디렉토리가 없으면 생성
      if (!fs.existsSync(resultFileDir)) {
        fs.mkdirSync(resultFileDir, { recursive: true });
      }
      
      // 필터링된 종목 정보를 파일에 저장
      const resultData = {
        timestamp: new Date().toISOString(),
        totalCount: filteredStocks.length,
        stocks: filteredStocks.map(stock => ({
          stockCode: stock.stockCode,
          stockName: stock.stockName,
          tradingValue: stock.tradingValue,
          price: stock.price,
          prevChange: stock.prevChange || 0,
          volume: stock.volume,
          prevVolume: stock.prevVolume,
          marketCap: stock.marketCap,
          isDecreased: stock.isDecreased,
          decreaseRate: stock.decreaseRate,
          sector: stock.sector || '기타'
        }))
      };
      
      fs.writeFileSync(resultFilePath, JSON.stringify(resultData, null, 2), 'utf8');
      console.log(`[키움증권 API] 필터링된 종목 정보를 파일에 저장: ${resultFilePath}`);
      
      return filteredStocks;
    } catch (error) {
      console.error('[키움증권 API] 거래대금 상위 종목 조회 실패:', error);
      throw this.handleError(error);
    }
  }

  // 업종 정보를 기반으로 테마 분류
  classifyThemeBySector(sector, stockName) {
    if (!sector) return this.classifyThemeByStockName(stockName);
    
    // 종목명 기반 분류가 더 정확하므로 종목명으로 먼저 분류
    const nameBasedTheme = this.classifyThemeByStockName(stockName);
    if (nameBasedTheme !== '기타') {
      return nameBasedTheme;
    }
    
    const sectorLower = sector.toLowerCase();
    const nameLower = stockName.toLowerCase();
    
    // 반도체 / AI
    if (sectorLower.includes('반도체') || sectorLower.includes('반도체제조')) {
      return '반도체 / AI';
    }
    
    // 바이오 / 제약
    if (sectorLower.includes('바이오') || sectorLower.includes('제약') || 
        sectorLower.includes('의료') || sectorLower.includes('제조업')) {
      return '바이오 / 제약';
    }
    
    // 2차전지 / 전기차
    if (sectorLower.includes('전기차') || sectorLower.includes('배터리') || 
        sectorLower.includes('2차전지')) {
      return '2차전지 / 전기차';
    }
    
    // 방산 / 조선
    if (sectorLower.includes('방산') || sectorLower.includes('조선') || 
        sectorLower.includes('항공') || sectorLower.includes('우주')) {
      return '방산 / 조선';
    }
    
    // 전력 / 에너지 / 중공업
    if (sectorLower.includes('전력') || sectorLower.includes('에너지') || 
        sectorLower.includes('중공업') || sectorLower.includes('발전')) {
      return '전력 / 에너지 / 중공업';
    }
    
    // 자동차 / 모빌리티
    if (sectorLower.includes('자동차') || sectorLower.includes('모빌리티')) {
      return '자동차 / 모빌리티';
    }
    
    // 플랫폼 / 인터넷
    if (sectorLower.includes('인터넷') || sectorLower.includes('플랫폼') || 
        sectorLower.includes('it서비스')) {
      return '플랫폼 / 인터넷';
    }
    
    // ETF / 지수 / 파생
    if (sectorLower.includes('etf') || sectorLower.includes('지수') || 
        sectorLower.includes('파생')) {
      return 'ETF / 지수 / 파생';
    }
    
    return '소재 / 부품 / 기타 제조';
  }

  // 종목명을 기반으로 테마 분류
  classifyThemeByStockName(stockName) {
    if (!stockName) return '기타';
    
    const nameLower = stockName.toLowerCase();
    const nameNormalized = nameLower.replace(/\s+/g, ''); // 공백 제거
    
    // ETF / 지수 / 파생 (우선 확인)
    if (nameNormalized.includes('kodex') || nameNormalized.includes('tiger') || 
        nameNormalized.includes('etf') || nameNormalized.includes('레버리지') || 
        nameNormalized.includes('선물인버스') || nameNormalized.includes('지수') ||
        nameNormalized.includes('파생') || nameNormalized.includes('cd금리')) {
      return 'ETF / 지수 / 파생';
    }
    
    // 반도체 / AI
    if (nameNormalized.includes('sk하이닉스') || nameNormalized.includes('하이닉스') ||
        nameNormalized.includes('삼성전자') || nameNormalized.includes('한미반도체') ||
        nameNormalized.includes('이수페타시스') || nameNormalized.includes('반도체') ||
        nameNormalized.includes('ai') || nameNormalized.includes('인공지능')) {
      return '반도체 / AI';
    }
    
    // 바이오 / 제약
    if (nameNormalized.includes('알테오젠') || nameNormalized.includes('에이비엘바이오') ||
        nameNormalized.includes('펩트론') || nameNormalized.includes('삼성에피스홀딩스') ||
        nameNormalized.includes('바이오') || nameNormalized.includes('제약') ||
        nameNormalized.includes('셀트리온') || nameNormalized.includes('의료')) {
      return '바이오 / 제약';
    }
    
    // 2차전지 / 전기차
    if (nameNormalized.includes('lg에너지솔루션') || nameNormalized.includes('에너지솔루션') ||
        nameNormalized.includes('삼성sdi') || nameNormalized.includes('에코프로') ||
        nameNormalized.includes('2차전지') || nameNormalized.includes('배터리') ||
        nameNormalized.includes('전기차') || nameNormalized.includes('리튬')) {
      return '2차전지 / 전기차';
    }
    
    // 방산 / 조선
    if (nameNormalized.includes('한화에어로스페이스') || nameNormalized.includes('에어로스페이스') ||
        nameNormalized.includes('한화오션') || nameNormalized.includes('한국항공우주') ||
        nameNormalized.includes('현대로템') || nameNormalized.includes('방산') ||
        nameNormalized.includes('조선') || nameNormalized.includes('항공우주')) {
      return '방산 / 조선';
    }
    
    // 전력 / 에너지 / 중공업
    if (nameNormalized.includes('두산에너빌리티') || nameNormalized.includes('에너빌리티') ||
        nameNormalized.includes('한국전력') || nameNormalized.includes('한전') ||
        nameNormalized.includes('효성중공업') || nameNormalized.includes('대한전선') ||
        nameNormalized.includes('전력') || nameNormalized.includes('중공업')) {
      return '전력 / 에너지 / 중공업';
    }
    
    // 자동차 / 모빌리티
    if (nameNormalized.includes('현대차') || nameNormalized.includes('현대오토에버') ||
        nameNormalized.includes('기아') || nameNormalized.includes('자동차') ||
        nameNormalized.includes('모빌리티')) {
      return '자동차 / 모빌리티';
    }
    
    // 플랫폼 / 인터넷
    if (nameNormalized.includes('naver') || nameNormalized.includes('네이버') ||
        nameNormalized.includes('카카오') || nameNormalized.includes('kakao') ||
        nameNormalized.includes('sk스퀘어') || nameNormalized.includes('스퀘어') ||
        nameNormalized.includes('플랫폼') || nameNormalized.includes('인터넷')) {
      return '플랫폼 / 인터넷';
    }
    
    // 소재 / 부품 / 기타 제조
    if (nameNormalized.includes('원익홀딩스') || nameNormalized.includes('소재') ||
        nameNormalized.includes('부품') || nameNormalized.includes('제조')) {
      return '소재 / 부품 / 기타 제조';
    }
    
    return '소재 / 부품 / 기타 제조';
  }

  /**
   * 주식일봉차트조회요청 (ka10081)
   * @param {string} accessToken - 접근토큰
   * @param {string} appKey - 앱키
   * @param {string} appSecret - 앱시크릿
   * @param {string} stockCode - 종목코드 (거래소별 종목코드: KRX:039490, NXT:039490_NX, SOR:039490_AL)
   * @param {string} baseDate - 기준일자 (YYYYMMDD 형식)
   * @param {string} updStkpcTp - 수정주가구분 (0 or 1, 기본값: '1')
   * @param {string} contYn - 연속조회여부 (기본값: 'N')
   * @param {string} nextKey - 연속조회키 (기본값: '')
   * @returns {Promise<Object>} 일봉차트 데이터
   */
  async getDailyStockChart(accessToken, appKey, appSecret, stockCode, baseDate, updStkpcTp = '1', contYn = 'N', nextKey = '') {
    try {
      const endpoint = '/api/dostk/chart';
      const url = `${this.baseURL}${endpoint}`;

      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'authorization': `Bearer ${accessToken}`,
        'cont-yn': contYn,
        'next-key': nextKey,
        'api-id': 'ka10081', // TR명
      };

      const data = {
        stk_cd: stockCode, // 종목코드
        base_dt: baseDate, // 기준일자 YYYYMMDD
        upd_stkpc_tp: updStkpcTp, // 수정주가구분 0 or 1
      };

      console.log(`[키움증권 API] ka10081 요청:`, { stockCode, baseDate, endpoint, apiId: 'ka10081' });

      const response = await axios.post(url, data, {
        headers,
        timeout: 30000,
        validateStatus: () => true
      });

      if (response.status !== 200) {
        throw this.handleError({ response });
      }

      // 키움증권 API는 HTTP 200이어도 return_code로 성공/실패를 판단
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        // 요청 제한 초과 에러 (return_code: 5)
        if (response.data.return_code === 5) {
          const error = {
            status: 429,
            message: response.data.return_msg || '허용된 요청 개수를 초과하였습니다.',
            data: response.data,
            isRateLimit: true
          };
          console.error('[키움증권 API] 일봉차트 조회 실패 (요청 제한 초과):', response.data);
          throw error;
        }
        
        console.error('[키움증권 API] 일봉차트 조회 실패:', response.data);
        throw {
          status: response.status,
          message: response.data.return_msg || '일봉차트 조회 중 오류가 발생했습니다.',
          data: response.data
        };
      }

      console.log(`[키움증권 API] 일봉차트 조회 성공: ${stockCode}, 기준일: ${baseDate}`);

      return {
        return_code: response.data.return_code,
        return_msg: response.data.return_msg,
        next_key: response.headers['next-key'] || '',
        cont_yn: response.headers['cont-yn'] || 'N',
        data: response.data
      };
    } catch (error) {
      console.error('[키움증권 API] 일봉차트 조회 오류:', error);
      throw this.handleError(error);
    }
  }

  /** 일봉 차트 항목에서 숫자 필드 추출 */
  parseChartNumericField(item, fieldCandidates, keywordHints = []) {
    for (const field of fieldCandidates) {
      if (item[field] !== undefined && item[field] !== null && item[field] !== '') {
        const val = parseFloat(String(item[field]).trim().replace(/[+\-]/g, ''));
        if (!Number.isNaN(val) && val > 0) return val;
      }
    }
    if (keywordHints.length > 0) {
      const keys = Object.keys(item);
      const matched = keys.filter((f) =>
        keywordHints.some((hint) => f.toLowerCase().includes(hint))
      );
      for (const field of matched) {
        const val = parseFloat(String(item[field]).trim().replace(/[+\-]/g, ''));
        if (!Number.isNaN(val) && val > 0) return val;
      }
    }
    return null;
  }

  /** 한국(서울) 기준 YYYYMMDD */
  getKoreaYmd(date = new Date()) {
    const korea = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const y = korea.getFullYear();
    const m = String(korea.getMonth() + 1).padStart(2, '0');
    const d = String(korea.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }

  /** YYYY-MM-DD 또는 YYYYMMDD에서 calendar days 감소 → YYYYMMDD */
  shiftYmdBack(ymdOrDash, daysBack = 1) {
    const ymd = String(ymdOrDash).replace(/-/g, '');
    const y = parseInt(ymd.slice(0, 4), 10);
    const m = parseInt(ymd.slice(4, 6), 10) - 1;
    const d = parseInt(ymd.slice(6, 8), 10);
    const dt = new Date(Date.UTC(y, m, d));
    dt.setUTCDate(dt.getUTCDate() - daysBack);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
  }

  /** ka10081 / usa06012 응답에서 일봉 배열 추출 */
  extractDailyChartDataArray(apiData) {
    if (!apiData) return [];
    if (apiData.stk_dt_pole_chart_qry) {
      return Array.isArray(apiData.stk_dt_pole_chart_qry)
        ? apiData.stk_dt_pole_chart_qry
        : [apiData.stk_dt_pole_chart_qry];
    }
    // 미국주식 차트 (usa06012 등)
    if (apiData.result_list) {
      return Array.isArray(apiData.result_list) ? apiData.result_list : [apiData.result_list];
    }
    if (apiData.output) {
      return Array.isArray(apiData.output) ? apiData.output : [apiData.output];
    }
    if (apiData.data) {
      return Array.isArray(apiData.data) ? apiData.data : [apiData.data];
    }
    if (apiData.list) {
      return Array.isArray(apiData.list) ? apiData.list : [apiData.list];
    }
    if (apiData.output1) {
      return Array.isArray(apiData.output1) ? apiData.output1 : [apiData.output1];
    }
    if (apiData.output2) {
      return Array.isArray(apiData.output2) ? apiData.output2 : [apiData.output2];
    }
    if (Array.isArray(apiData)) return apiData;
    return [apiData];
  }

  /** 일봉 차트 1건 → OHLC 객체 (파싱 실패 시 null) */
  parseDailyBarFromChartItem(item) {
    if (!item) return null;

    let dateStr = null;
    if (item.dt) {
      const dateVal = String(item.dt);
      if (dateVal.length === 8) {
        dateStr = `${dateVal.substring(0, 4)}-${dateVal.substring(4, 6)}-${dateVal.substring(6, 8)}`;
      } else if (dateVal.length === 10 && dateVal.includes('-')) {
        dateStr = dateVal;
      }
    }
    if (!dateStr) return null;

    let closePrice = null;
    if (item.cur_prc !== undefined && item.cur_prc !== null && item.cur_prc !== '') {
      const val = Math.abs(parseFloat(String(item.cur_prc).trim().replace(/[+\-]/g, '')));
      if (!Number.isNaN(val) && val > 0) closePrice = val;
    }
    if (!closePrice) return null;

    let predPre = null;
    if (item.pred_pre !== undefined && item.pred_pre !== null && item.pred_pre !== '') {
      const val = parseFloat(String(item.pred_pre).trim());
      if (!Number.isNaN(val)) predPre = val;
    }

    return {
      date: dateStr,
      openPrice: this.parseChartNumericField(
        item,
        ['open_pric', 'open_prc', 'open_price', 'open', 'oprc', 'stck_oprc'],
        ['open', 'oprc', '시가']
      ),
      highPrice: this.parseChartNumericField(
        item,
        ['high_pric', 'high_prc', 'high_price', 'high', 'hprc', 'stck_hgpr', 'hgpr'],
        ['high', 'hgpr', '고가']
      ),
      lowPrice: this.parseChartNumericField(
        item,
        ['low_pric', 'low_prc', 'low_price', 'low', 'lprc', 'stck_lwpr', 'lwpr'],
        ['low', 'lwpr', '저가']
      ),
      closePrice,
      tradeVolume: this.parseChartNumericField(
        item,
        ['trde_qty', 'acc_trde_qty', 'trde_qty_remn', 'acml_vol', 'vol', 'volume'],
        ['qty', 'vol', '거래량']
      ),
      predPre: predPre !== null ? predPre : null,
    };
  }

  /**
   * 종목의 최근 N일치 거래일 OHLC 조회
   * - 연속조회로 가능한 만큼 한 번에 수집
   * - 신규상장 등 거래일이 N일 미만이면 조기 종료 (과거 날짜 반복 호출 없음)
   * @returns {Promise<Array>} [{ date, openPrice, highPrice, lowPrice, closePrice, predPre }, ...]
   */
  async getRecentDailyClosePrices(
    accessToken,
    appKey,
    appSecret,
    stockCode,
    days = 10,
    stockMarket = 'KRX',
    anchorYmd = null
  ) {
    try {
      const formattedStockCode = stockMarket === 'NXT' ? `${stockCode}_NX` : stockCode;
      const maxDays = Math.max(1, days);
      const pricesByDate = new Map();

      let baseDateYmd = anchorYmd || this.getKoreaYmd();
      const MAX_BASE_ANCHORS = 2;
      let baseAnchor = 0;

      while (baseAnchor <= MAX_BASE_ANCHORS) {
      let nextKey = '';
      let contYn = 'N';
        let addedThisAnchor = 0;

        try {
          do {
          const result = await this.getDailyStockChart(
            accessToken,
            appKey,
            appSecret,
            formattedStockCode,
              baseDateYmd,
              '1',
            contYn,
            nextKey
          );

            const chartData = this.extractDailyChartDataArray(result.data);
            for (const item of chartData) {
              const bar = this.parseDailyBarFromChartItem(item);
              if (bar && !pricesByDate.has(bar.date)) {
                pricesByDate.set(bar.date, bar);
                addedThisAnchor += 1;
              }
            }

            if (pricesByDate.size >= maxDays) break;

            if (result.cont_yn === 'Y' && result.next_key) {
              nextKey = result.next_key;
              contYn = 'Y';
              await new Promise((resolve) => setTimeout(resolve, 100));
          } else {
              break;
            }
          } while (true);
        } catch (error) {
          if (error.isRateLimit || error.status === 429 || error.data?.return_code === 5) {
            console.error(`[키움증권 API] 일봉차트 조회 실패 (요청 제한, ${baseDateYmd}):`, error.message);
            await new Promise((resolve) => setTimeout(resolve, 5000));
          } else {
            console.error(`[키움증권 API] 일봉차트 조회 실패 (${baseDateYmd}):`, error.message);
          }
          break;
        }

        if (pricesByDate.size >= maxDays) break;
        if (addedThisAnchor === 0) break;

        if (baseAnchor >= MAX_BASE_ANCHORS) break;

        const oldestDate = [...pricesByDate.keys()].sort((a, b) => a.localeCompare(b))[0];
        baseDateYmd = this.shiftYmdBack(oldestDate, 1);
        baseAnchor += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const sortedNewestFirst = [...pricesByDate.values()].sort((a, b) =>
        b.date.localeCompare(a.date)
      );
      const recentPrices = sortedNewestFirst.slice(0, maxDays);
      recentPrices.sort((a, b) => a.date.localeCompare(b.date));

      const isPartial = recentPrices.length < maxDays;
      console.log(
        `[키움증권 API] 일봉 조회 완료: ${stockCode}, 수집 ${recentPrices.length}/${maxDays}거래일` +
          (isPartial ? ' (상장일수 부족·조기종료)' : '')
      );

      return recentPrices;
    } catch (error) {
      console.error('[키움증권 API] 최근 종가 조회 오류:', error);
      throw error;
    }
  }

  /** 종목코드 6자리 정규화 (NXT 접미사 제거) */
  normalizeKrxStockCode(stockCode) {
    const raw = String(stockCode || '').trim();
    if (!raw) return '';
    if (raw.endsWith('_NX')) return raw.slice(0, 6);
    return raw.length >= 6 ? raw.slice(0, 6) : raw;
  }

  /** dostk 공통 POST */
  async postDostkTr(accessToken, endpoint, apiId, body, { timeout = 30000 } = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: `Bearer ${accessToken}`,
      'cont-yn': 'N',
      'next-key': '',
      'api-id': apiId,
    };

    const response = await axios.post(url, body, {
      headers,
      timeout,
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      throw this.handleError({ response });
    }

    if (response.data.return_code !== undefined && response.data.return_code !== 0) {
      if (response.data.return_code === 20) {
        return { return_code: 20, return_msg: response.data.return_msg, data: response.data };
      }
      const err = {
        status: response.data.return_code === 5 ? 429 : 400,
        message: response.data.return_msg || `${apiId} 조회 실패`,
        data: response.data,
        isRateLimit: response.data.return_code === 5,
      };
      throw err;
    }

    return response.data;
  }

  /** 응답 객체에서 배열 추출 */
  extractResponseArray(apiData) {
    if (!apiData) return [];
    if (Array.isArray(apiData)) return apiData;
    const keys = [
      'output',
      'output1',
      'output2',
      'data',
      'list',
      'stk_invsr_orgn',
      'stk_invsr_orgn_sum',
      'invstr_orgn',
      'frgn_orgn',
      'orgn_frgn',
      'atn_stk_infr',
      'dt_stk_invsr_orgn',
      'orgn_stk_infr',
      'frgn_stk_trde_trnsn',
      'frgn_stk_trde',
      'orgn_stk_trde',
      'stk_frgnistt',
    ];
    for (const key of keys) {
      if (apiData[key]) {
        return Array.isArray(apiData[key]) ? apiData[key] : [apiData[key]];
      }
    }
    for (const value of Object.values(apiData)) {
      if (Array.isArray(value) && value.length > 0) return value;
    }
    return [];
  }

  parseSignedNumber(raw) {
    if (raw == null || raw === '') return null;
    const cleaned = String(raw).replace(/,/g, '').trim();
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : null;
  }

  /** 행에서 순매수 수치 추출 (있으면 >0 만 통과용) */
  parseNetBuyFromRow(row) {
    if (!row || typeof row !== 'object') return null;
    const candidates = [
      row.netprps_qty,
      row.netprps_amt,
      row.netprps,
      row.net_buy_qty,
      row.net_buy_amt,
      row.net_buy,
      row.prsm_netprps_qty,
      row.prsm_netprps,
      row.frgn_ntby_qty,
      row.frgn_ntby_amt,
      row.orgn_ntby_qty,
      row.orgn_ntby_amt,
      row.ntby_qty,
      row.ntby_amt,
      row.frgnr_invsr,
      row.orgn,
      row.ind_invsr,
      row.chg_qty,
    ];
    for (const raw of candidates) {
      const num = this.parseSignedNumber(raw);
      if (num != null) return num;
    }
    return null;
  }

  /** 일봉/매매일 행에서 YYYYMMDD 추출 */
  parseRowDateYmd(row) {
    if (!row || typeof row !== 'object') return null;
    const raw = row.dt || row.bsop_dt || row.base_dt || row.date || row.trde_dt || row.stk_bsop_date;
    if (raw == null || raw === '') return null;
    const s = String(raw).replace(/-/g, '').trim();
    if (s.length >= 8) return s.slice(0, 8);
    return null;
  }

  /** 기준일(YYYYMMDD) 행의 순매수 — 없으면 기준일 이전 최신 거래일 */
  parseNetBuyOnReferenceDate(apiData, dateYmd) {
    const rows = this.extractResponseArray(apiData);
    if (!rows.length) return null;

    let matched = null;
    let latestNet = null;
    let latestYmd = '';

    for (const row of rows) {
      const net = this.parseNetBuyFromRow(row);
      if (net == null) continue;
      const rowYmd = this.parseRowDateYmd(row);
      if (rowYmd === dateYmd) {
        matched = net;
      }
      if (rowYmd && rowYmd <= dateYmd && rowYmd >= latestYmd) {
        latestYmd = rowYmd;
        latestNet = net;
      }
    }

    if (matched != null) return matched;
    if (latestNet != null) return latestNet;
    if (rows.length === 1) return this.parseNetBuyFromRow(rows[0]);
    return this.parseNetBuyFromRow(rows[rows.length - 1]);
  }

  extractStockCodesFromRankRows(rows, { requirePositiveNet = false } = {}) {
    const codes = new Set();
    for (const row of rows) {
      const code = this.normalizeKrxStockCode(
        row.stk_cd || row.code || row.stock_code || row.item_cd
      );
      if (!code || !/^\d{6}$/.test(code)) continue;
      if (requirePositiveNet) {
        const net = this.parseNetBuyFromRow(row);
        if (net != null && net <= 0) continue;
      }
      codes.add(code);
    }
    return codes;
  }

  /**
   * 종목별 투자자 매매 (ka10059 등) — 기준일 행의 frgnr_invsr(외인), orgn(기관)
   */
  parseInvestorNetBuyOnReferenceDate(apiData, dateYmd) {
    const rows = this.extractResponseArray(apiData);
    if (!rows.length) {
      return { foreignNetBuy: null, institutionalNetBuy: null };
    }

    let foreignNetBuy = null;
    let institutionalNetBuy = null;
    let latestYmd = '';

    for (const row of rows) {
      if (row.frgnr_invsr == null && row.orgn == null) continue;
      const rowYmd = this.parseRowDateYmd(row);
      if (!rowYmd || rowYmd > dateYmd) continue;

      const foreign = this.parseSignedNumber(row.frgnr_invsr);
      const institutional = this.parseSignedNumber(row.orgn);

      if (rowYmd === dateYmd) {
        return {
          foreignNetBuy: foreign,
          institutionalNetBuy: institutional,
        };
      }
      if (rowYmd >= latestYmd) {
        latestYmd = rowYmd;
        foreignNetBuy = foreign;
        institutionalNetBuy = institutional;
      }
    }

    return { foreignNetBuy, institutionalNetBuy };
  }

  /** API 응답에서 외인·기관 순매수 합계 파싱 */
  parseInvestorNetBuyFromData(apiData) {
    let foreignNetBuy = null;
    let institutionalNetBuy = null;

    const rows = this.extractResponseArray(apiData);
    for (const row of rows) {
      if (row.frgnr_invsr != null || row.orgn != null) {
        const foreign = this.parseSignedNumber(row.frgnr_invsr);
        const institutional = this.parseSignedNumber(row.orgn);
        if (foreign != null) foreignNetBuy = (foreignNetBuy ?? 0) + foreign;
        if (institutional != null) institutionalNetBuy = (institutionalNetBuy ?? 0) + institutional;
        continue;
      }

      const label = String(
        row.invtr_nm ||
          row.invstr_nm ||
          row.invst_nm ||
          row.invsr_nm ||
          row.orgn_nm ||
          row.invsr_tp_nm ||
          row.name ||
          row.tp ||
          ''
      ).trim();
      const invsrCd = String(row.invsr_cd || row.invsr_tp || row.invtr_cd || '').trim();
      const net = this.parseNetBuyFromRow(row);
      if (net == null) continue;

      const isForeign =
        label.includes('외국') ||
        label.includes('외인') ||
        invsrCd === '9000' ||
        invsrCd.startsWith('9');
      const isInstitution =
        label.includes('기관') ||
        invsrCd === '8000' ||
        invsrCd.startsWith('8');

      if (isForeign && !label.includes('기관')) {
        foreignNetBuy = (foreignNetBuy ?? 0) + net;
      } else if (isInstitution) {
        institutionalNetBuy = (institutionalNetBuy ?? 0) + net;
      }
    }

    const scanObject = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 4) return;
      if (Array.isArray(obj)) {
        obj.forEach((item) => scanObject(item, depth + 1));
        return;
      }
      for (const [key, val] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        if (typeof val === 'string' || typeof val === 'number') {
          const num = this.parseSignedNumber(val);
          if (num == null) continue;
          if (
            keyLower === 'frgnr_invsr' ||
            keyLower === 'frgnr_ntby' ||
            ((keyLower.includes('frgn') || keyLower.includes('foreign')) &&
              (keyLower.includes('invsr') ||
                keyLower.includes('ntby') ||
                keyLower.includes('net') ||
                keyLower.includes('prps')))
          ) {
            foreignNetBuy = (foreignNetBuy ?? 0) + num;
          }
          if (
            keyLower === 'orgn' ||
            keyLower === 'orgn_ntby' ||
            ((keyLower.includes('orgn') || keyLower.includes('inst')) &&
              (keyLower.includes('ntby') ||
                keyLower.includes('net') ||
                keyLower.includes('prps') ||
                keyLower === 'orgn'))
          ) {
            institutionalNetBuy = (institutionalNetBuy ?? 0) + num;
          }
        } else {
          scanObject(val, depth + 1);
        }
      }
    };

    if (foreignNetBuy == null || institutionalNetBuy == null) {
      scanObject(apiData);
    }

    return { foreignNetBuy, institutionalNetBuy };
  }

  /**
   * 주식외국인종목별매매동향 (ka10008) — /api/dostk/frgnistt
   */
  async getForeignStockTradingNetBuy(accessToken, appKey, appSecret, stockCode, dateYmd = null) {
    const code = this.normalizeKrxStockCode(stockCode);
    const dt = dateYmd || this.getKoreaYmd();
    try {
      const data = await this.postDostkTr(
        accessToken,
        '/api/dostk/frgnistt',
        'ka10008',
        { stk_cd: code }
      );
      const net = this.parseNetBuyOnReferenceDate(data, dt);
      if (net != null) return net;
      const parsed = this.parseInvestorNetBuyFromData(data);
      return parsed.foreignNetBuy;
        } catch (error) {
      if (error.isRateLimit || error.status === 429) throw error;
      return null;
    }
  }

  /**
   * 주식기관요청 (ka10009) — /api/dostk/frgnistt
   */
  async getInstitutionalStockNetBuy(accessToken, appKey, appSecret, stockCode, dateYmd = null) {
    const code = this.normalizeKrxStockCode(stockCode);
    const dt = dateYmd || this.getKoreaYmd();
    try {
      const data = await this.postDostkTr(
        accessToken,
        '/api/dostk/frgnistt',
        'ka10009',
        { stk_cd: code }
      );
      const net = this.parseNetBuyOnReferenceDate(data, dt);
      if (net != null) return net;
      const parsed = this.parseInvestorNetBuyFromData(data);
      return parsed.institutionalNetBuy;
    } catch (error) {
      if (error.isRateLimit || error.status === 429) throw error;
      return null;
    }
  }

  /**
   * 종목별 외인·기관 순매수 (ka10008/ka10009 → ka10061/ka10059 fallback)
   */
  async getStockInvestorNetBuy(accessToken, appKey, appSecret, stockCode, dateYmd = null) {
    const code = this.normalizeKrxStockCode(stockCode);
    const dt = dateYmd || this.getKoreaYmd();

    const stkinfoAttempts = [
      {
        apiId: 'ka10059',
        body: {
          stk_cd: code,
          base_dt: dt,
          dt,
          amt_qty_tp: '2',
          trde_tp: '0',
          unit_tp: '1',
        },
      },
      {
        apiId: 'ka10061',
        body: { stk_cd: code, base_dt: dt, dt, amt_qty_tp: '2', trde_tp: '0' },
      },
    ];

    for (const attempt of stkinfoAttempts) {
      try {
        const data = await this.postDostkTr(
          accessToken,
          '/api/dostk/stkinfo',
          attempt.apiId,
          attempt.body
        );
        const parsed = this.parseInvestorNetBuyOnReferenceDate(data, dt);
        if (parsed.foreignNetBuy != null || parsed.institutionalNetBuy != null) {
          return parsed;
        }
      } catch (error) {
        if (error.isRateLimit || error.status === 429) throw error;
      }
    }

    let foreignNetBuy = await this.getForeignStockTradingNetBuy(
      accessToken,
      appKey,
      appSecret,
      code,
      dt
    );
    let institutionalNetBuy = await this.getInstitutionalStockNetBuy(
      accessToken,
      appKey,
      appSecret,
      code,
      dt
    );

    return { foreignNetBuy, institutionalNetBuy };
  }

  /** 외인 기간별 순매수 상위 (ka10034) */
  async getForeignNetBuyRankStockCodes(accessToken, appKey, appSecret, dateYmd = null) {
    const dt = dateYmd || this.getKoreaYmd();
    const attempts = [
      {
        endpoint: '/api/dostk/rkinfo',
        apiId: 'ka10034',
        body: {
          strt_dt: dt,
          end_dt: dt,
          dt,
          base_dt: dt,
          mrkt_tp: '000',
          mang_stk_incls: '1',
          stex_tp: '3',
          amt_qty_tp: '2',
          trde_tp: '0',
        },
      },
      {
        endpoint: '/api/dostk/rkinfo',
        apiId: 'ka10035',
        body: {
          mrkt_tp: '000',
          mang_stk_incls: '1',
          stex_tp: '3',
          amt_qty_tp: '2',
          trde_tp: '0',
          strt_dt: dt,
          end_dt: dt,
          base_dt_tp: '1',
          dt,
          base_dt: dt,
        },
      },
    ];

    for (const attempt of attempts) {
      try {
        const data = await this.postDostkTr(
          accessToken,
          attempt.endpoint,
          attempt.apiId,
          attempt.body
        );
        const codes = this.extractStockCodesFromRankRows(this.extractResponseArray(data), {
          requirePositiveNet: true,
        });
        if (codes.size > 0) {
          console.log(`[키움증권 API] ${attempt.apiId} 외인 순매수 종목 ${codes.size}건 (기준일 ${dt})`);
          return codes;
        }
      } catch (error) {
        console.warn(`[키움증권 API] ${attempt.apiId} 외인 순위 실패:`, error.message);
      }
    }
    return new Set();
  }

  /** 일별 기관 매매 종목 (ka10044) — /api/dostk/mrkcond */
  async getInstitutionalNetBuyRankStockCodes(accessToken, appKey, appSecret, dateYmd = null) {
    const dt = dateYmd || this.getKoreaYmd();
    const attempts = [
      {
        endpoint: '/api/dostk/mrkcond',
        apiId: 'ka10044',
        body: {
          strt_dt: dt,
          end_dt: dt,
          bsop_dt: dt,
          dt,
          base_dt: dt,
          mrkt_tp: '000',
          mang_stk_incls: '1',
          stex_tp: '3',
          amt_qty_tp: '2',
          trde_tp: '0',
        },
      },
    ];

    for (const attempt of attempts) {
      try {
        const data = await this.postDostkTr(
          accessToken,
          attempt.endpoint,
          attempt.apiId,
          attempt.body
        );
        const codes = this.extractStockCodesFromRankRows(this.extractResponseArray(data), {
          requirePositiveNet: true,
        });
        if (codes.size > 0) {
          console.log(`[키움증권 API] ${attempt.apiId} 기관 순매수 종목 ${codes.size}건 (기준일 ${dt})`);
          return codes;
        }
    } catch (error) {
        console.warn(`[키움증권 API] ${attempt.apiId} 기관 순위 실패:`, error.message);
      }
    }
    return new Set();
  }

  extractMinuteChartDataArray(apiData) {
    if (!apiData) return [];
    if (apiData.stk_min_pole_chart_qry) {
      return Array.isArray(apiData.stk_min_pole_chart_qry)
        ? apiData.stk_min_pole_chart_qry
        : [apiData.stk_min_pole_chart_qry];
    }
    if (Array.isArray(apiData)) return apiData;
    return [apiData];
  }

  parseMinuteBarCloseFromChartItem(item) {
    if (!item) return null;
    const closePrice = this.parseChartNumericField(
      item,
      ['cur_prc', 'close_pric', 'close_prc', 'close', 'stck_clpr', 'clpr'],
      ['close', '종가', 'cur']
    );
    if (closePrice == null || closePrice <= 0) return null;
    const dt = item.dt != null ? String(item.dt).padStart(8, '0') : '';
    const tm = item.cntr_tm != null
      ? String(item.cntr_tm).padStart(6, '0')
      : item.tm != null
        ? String(item.tm).padStart(6, '0')
        : '';
    return { closePrice, sortKey: `${dt}${tm}` };
  }

  /**
   * 주식 분봉차트 (ka10080)
   * @param {string} ticScope - '1' 1분, '5' 5분, '60' 60분 등
   */
  async getMinuteStockChart(
    accessToken,
    appKey,
    appSecret,
    stockCode,
    ticScope = '5',
    updStkpcTp = '1',
    contYn = 'N',
    nextKey = ''
  ) {
    try {
      const endpoint = '/api/dostk/chart';
      const url = `${this.baseURL}${endpoint}`;
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        authorization: `Bearer ${accessToken}`,
        'cont-yn': contYn,
        'next-key': nextKey,
        'api-id': 'ka10080',
      };
      const data = {
        stk_cd: stockCode,
        tic_scope: String(ticScope),
        upd_stkpc_tp: updStkpcTp,
      };

      const response = await axios.post(url, data, {
        headers,
        timeout: 30000,
        validateStatus: () => true,
      });

      if (response.status !== 200) {
        throw this.handleError({ response });
      }
      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        if (response.data.return_code === 5) {
          throw {
            status: 429,
            message: response.data.return_msg || '허용된 요청 개수를 초과하였습니다.',
            data: response.data,
            isRateLimit: true,
          };
        }
        throw {
          status: response.status,
          message: response.data.return_msg || '분봉차트 조회 중 오류가 발생했습니다.',
          data: response.data,
        };
      }

      return {
        return_code: response.data.return_code,
        return_msg: response.data.return_msg,
        next_key: response.headers['next-key'] || '',
        cont_yn: response.headers['cont-yn'] || 'N',
        data: response.data,
      };
    } catch (error) {
      console.error('[키움증권 API] 분봉차트 조회 오류:', error);
      throw this.handleError(error);
    }
  }

  /**
   * 5분봉 최근 N개 종가 (오래된 → 최신 순)
   */
  async getRecentMinuteClosePrices(
    accessToken,
    appKey,
    appSecret,
    stockCode,
    barCount = 20,
    ticScope = '5',
    stockMarket = 'KRX'
  ) {
    const formattedStockCode = stockMarket === 'NXT' ? `${stockCode}_NX` : stockCode;
    const bars = [];
    let nextKey = '';
    let contYn = 'N';
    const maxPages = 8;

    for (let page = 0; page < maxPages && bars.length < barCount; page += 1) {
      const result = await this.getMinuteStockChart(
        accessToken,
        appKey,
        appSecret,
        formattedStockCode,
        ticScope,
        '1',
        contYn,
        nextKey
      );
      const chartData = this.extractMinuteChartDataArray(result.data);
      for (const item of chartData) {
        const parsed = this.parseMinuteBarCloseFromChartItem(item);
        if (parsed) bars.push(parsed);
      }
      if (bars.length >= barCount) break;
      if (result.cont_yn === 'Y' && result.next_key) {
        nextKey = result.next_key;
        contYn = 'Y';
        await new Promise((resolve) => setTimeout(resolve, 120));
      } else {
        break;
      }
    }

    bars.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    const closes = bars.map((b) => b.closePrice);
    return closes.length > barCount ? closes.slice(-barCount) : closes;
  }

  /** @deprecated getForeignNetBuyRankStockCodes / getInstitutionalNetBuyRankStockCodes 사용 */
  async getInvestorNetBuyRankStockCodes(
    accessToken,
    appKey,
    appSecret,
    { investorType = 'foreign', dateYmd = null } = {}
  ) {
    if (investorType === 'institutional') {
      return this.getInstitutionalNetBuyRankStockCodes(accessToken, appKey, appSecret, dateYmd);
    }
    return this.getForeignNetBuyRankStockCodes(accessToken, appKey, appSecret, dateYmd);
  }

  /**
   * 미국주식 공통 POST (/api/us/*)
   * cont-yn / next-key 헤더 연속조회 지원
   */
  async postUsTr(accessToken, endpoint, apiId, body, { timeout = 30000, contYn = 'N', nextKey = '' } = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: `Bearer ${accessToken}`,
      'cont-yn': contYn || 'N',
      'next-key': nextKey || '',
      'api-id': apiId,
    };

    const response = await axios.post(url, body || {}, {
      headers,
      timeout,
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      throw this.handleError({ response });
    }

    if (response.data?.return_code !== undefined && response.data.return_code !== 0) {
      if (response.data.return_code === 20) {
        return {
          data: response.data,
          stocks: [],
          nextKey: '',
          contYn: 'N',
          return_code: 20,
        };
      }
      const err = {
        status: response.data.return_code === 5 ? 429 : 400,
        message: response.data.return_msg || `${apiId} 조회 실패`,
        data: response.data,
        isRateLimit: response.data.return_code === 5,
      };
      throw err;
    }

    return {
      data: response.data,
      nextKey: response.headers['next-key'] || '',
      contYn: response.headers['cont-yn'] || 'N',
      return_code: response.data?.return_code,
    };
  }

  /** @deprecated postUsTr 사용 */
  async postUstkTr(accessToken, endpoint, apiId, body, opts) {
    return this.postUsTr(accessToken, endpoint, apiId, body, opts);
  }

  /** usa10098/usa10099/usa10104 응답에서 종목 배열 파싱 */
  parseUsStockListItems(apiData, defaultExchange = null) {
    const list = this.extractResponseArray(apiData);
    const stocks = [];
    list.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const ticker = String(
        item.stk_cd ||
          item.symb ||
          item.ticker ||
          item.code ||
          item.stk_code ||
          item.isu_cd ||
          ''
      )
        .trim()
        .toUpperCase();
      const stockName = String(
        item.stk_nm || item.symb_nm || item.name || item.stk_name || item.isu_nm || ticker
      ).trim();
      const exchange = String(
        item.stex_tp ||
          item.exch_id ||
          item.exch_cd ||
          item.mrkt_tp ||
          item.natn_cd ||
          defaultExchange ||
          ''
      ).trim() || null;

      if (ticker) {
        stocks.push({
          ticker,
          stockCode: ticker,
          stockName: stockName || ticker,
          exchange,
        });
      } else if (index < 3) {
        console.log(`[키움증권 API] 미국 종목 파싱 실패 (인덱스 ${index}):`, Object.keys(item));
      }
    });
    return stocks;
  }

  /**
   * 미국주식 종목리스트 1회 (usa10099)
   * stex_tp: % 전체, NA AMEX, ND NASDAQ, NY NYSE
   */
  async getUsMarketStockList(accessToken, stexTp = '%', contYn = 'N', nextKey = '') {
    const result = await this.postUsTr(
      accessToken,
      '/api/us/stkinfo',
      'usa10099',
      { stex_tp: String(stexTp || '%') },
      { contYn, nextKey }
    );
    const stocks = this.parseUsStockListItems(result.data, stexTp === '%' ? null : stexTp);
    return {
      stocks,
      nextKey: result.nextKey,
      contYn: result.contYn,
    };
  }

  /**
   * 미국 전체 종목 마스터 수집 (usa10099, stex_tp=% + 연속조회)
   * 유량: usa10099는 계좌당 1분 5회 → 페이지 간 대기
   */
  async getAllUsStocks(accessToken) {
    console.log('[키움증권 API] 미국 종목 목록 조회 시작 (usa10099 stex_tp=%)');
    const allStocks = [];
    const seen = new Set();

    const pushAll = (stocks) => {
      stocks.forEach((s) => {
        if (!s?.ticker || seen.has(s.ticker)) return;
        seen.add(s.ticker);
        allStocks.push(s);
      });
    };

    // 키움 제한: usa10099 1분당 5회 → 연속조회 간격 약 13초
    const PAGE_GAP_MS = 13000;
    let contYn = 'N';
    let nextKey = '';
    let loopCount = 0;
    const maxLoops = 200;

    while (loopCount < maxLoops) {
      loopCount += 1;
      try {
        const page = await this.getUsMarketStockList(accessToken, '%', contYn, nextKey);
        pushAll(page.stocks);
        console.log(
          `[키움증권 API] usa10099 % ${loopCount}회차: ${page.stocks.length}건, 누적 ${allStocks.length}건` +
            ` cont=${page.contYn || 'N'}`
        );
        nextKey = page.nextKey;
        contYn = page.contYn;
        if (contYn !== 'Y' || !nextKey) break;
        console.log(`[키움증권 API] usa10099 유량 대기 ${PAGE_GAP_MS / 1000}초...`);
        await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
      } catch (error) {
        if (error?.isRateLimit) {
          console.warn('[키움증권 API] usa10099 유량 초과 — 60초 후 재시도');
          await new Promise((r) => setTimeout(r, 60000));
          continue;
        }
        console.error('[키움증권 API] usa10099 실패:', error.message || error);
        break;
      }
    }

    console.log(`[키움증권 API] 미국 종목 목록 조회 완료: 총 ${allStocks.length}건`);
    return allStocks;
  }

  /**
   * 미국주식 일/주/월 차트 (usa06012 / usa06013 / usa06014)
   * @param {string} accessToken
   * @param {string} ticker - 종목코드 (예: NVDA)
   * @param {string} stexTp - NA AMEX / ND NASDAQ / NY NYSE
   * @param {string} strtDt - 기준일자 YYYYMMDD (이 날짜부터 과거로 조회)
   * @param {'day'|'week'|'month'} interval
   * @param {string} contYn
   * @param {string} nextKey
   */
  async getUsStockChart(
    accessToken,
    ticker,
    stexTp = 'ND',
    strtDt,
    interval = 'day',
    contYn = 'N',
    nextKey = ''
  ) {
    const apiId =
      interval === 'month' ? 'usa06014' : interval === 'week' ? 'usa06013' : 'usa06012';
    const body = {
      stex_tp: String(stexTp || 'ND').toUpperCase(),
      stk_cd: String(ticker || '').trim().toUpperCase(),
      strt_dt: String(strtDt || this.getKoreaYmd()),
      upd_stkpc_tp: '1',
      exrt_appl_tp: '0',
    };

    console.log(`[키움증권 API] ${apiId} 요청:`, {
      ticker: body.stk_cd,
      stexTp: body.stex_tp,
      strtDt: body.strt_dt,
      interval,
    });

    const result = await this.postUsTr(accessToken, '/api/us/chart', apiId, body, {
      contYn,
      nextKey,
      timeout: 30000,
    });

    return {
      return_code: result.return_code,
      next_key: result.nextKey || '',
      cont_yn: result.contYn || 'N',
      data: result.data,
    };
  }

  /**
   * 미국주식 최근 N개 일/주/월봉 OHLC
   * @returns {Promise<Array>} [{ date, openPrice, highPrice, lowPrice, closePrice, tradeVolume, predPre }, ...]
   */
  async getRecentUsDailyClosePrices(
    accessToken,
    ticker,
    days = 240,
    stexTp = 'ND',
    interval = 'day',
    anchorYmd = null
  ) {
    const stkCd = String(ticker || '').trim().toUpperCase();
    if (!stkCd) return [];

    const maxDays = Math.max(1, days);
    const pricesByDate = new Map();
    let baseDateYmd = anchorYmd || this.getKoreaYmd();
    const MAX_BASE_ANCHORS = 3;
    let baseAnchor = 0;

    while (baseAnchor <= MAX_BASE_ANCHORS) {
      let nextKey = '';
      let contYn = 'N';
      let addedThisAnchor = 0;

      try {
        do {
          const result = await this.getUsStockChart(
            accessToken,
            stkCd,
            stexTp,
            baseDateYmd,
            interval,
            contYn,
            nextKey
          );

          const chartData = this.extractDailyChartDataArray(result.data);
          for (const item of chartData) {
            const bar = this.parseDailyBarFromChartItem(item);
            if (bar && !pricesByDate.has(bar.date)) {
              pricesByDate.set(bar.date, bar);
              addedThisAnchor += 1;
            }
          }

          if (pricesByDate.size >= maxDays) break;

          if (result.cont_yn === 'Y' && result.next_key) {
            nextKey = result.next_key;
            contYn = 'Y';
            await new Promise((resolve) => setTimeout(resolve, 150));
          } else {
            break;
          }
        } while (true);
      } catch (error) {
        if (error.isRateLimit || error.status === 429 || error.data?.return_code === 5) {
          console.error(
            `[키움증권 API] 미국 차트 조회 실패 (요청 제한, ${baseDateYmd}):`,
            error.message
          );
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } else {
          console.error(`[키움증권 API] 미국 차트 조회 실패 (${baseDateYmd}):`, error.message);
        }
        break;
      }

      if (pricesByDate.size >= maxDays) break;
      if (addedThisAnchor === 0) break;
      if (baseAnchor >= MAX_BASE_ANCHORS) break;

      const oldestDate = [...pricesByDate.keys()].sort((a, b) => a.localeCompare(b))[0];
      baseDateYmd = this.shiftYmdBack(oldestDate, 1);
      baseAnchor += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const sortedNewestFirst = [...pricesByDate.values()].sort((a, b) =>
      b.date.localeCompare(a.date)
    );
    const recentPrices = sortedNewestFirst.slice(0, maxDays);
    recentPrices.sort((a, b) => a.date.localeCompare(b.date));

    console.log(
      `[키움증권 API] 미국 ${interval}봉 조회 완료: ${stkCd}, 수집 ${recentPrices.length}/${maxDays}`
    );

    return recentPrices;
  }

  /**
   * 미국주식 현재가 종목정보 1행 파싱 (usa20100)
   */
  parseUsQuoteItem(item, fallbackTicker = '', stexTp = null) {
    if (!item || typeof item !== 'object') return null;
    const stkCd = String(
      item.stk_cd ?? item.symbol ?? item.ticker ?? fallbackTicker ?? ''
    )
      .trim()
      .toUpperCase()
      .replace(/\|.*$/, ''); // 배치 응답에 파이프가 섞인 경우 방어
    if (!stkCd) return null;

    const price = Math.abs(
      parseFloat(
        String(
          item.cur_prc ?? item.last ?? item.price ?? item.close ?? item['10'] ?? '0'
        ).replace(/,/g, '')
      ) || 0
    );
    const change =
      parseFloat(String(item.pred_pre ?? item.change ?? item['11'] ?? '0').replace(/,/g, '')) || 0;
    const changeRate =
      parseFloat(
        String(item.flu_rt ?? item.changeRate ?? item['12'] ?? '0').replace(/,/g, '')
      ) || 0;

    return {
      stockCode: stkCd,
      stockName: String(item.stk_nm ?? item.name ?? stkCd).trim() || stkCd,
      price,
      change,
      changeRate,
      exchange: item.stex_tp || stexTp || null,
    };
  }

  /**
   * 미국주식 현재가 종목정보 (usa20100) — 단건
   * @returns {{ stockCode, stockName, price, change, changeRate, exchange }|null}
   */
  async getUsStockQuote(accessToken, ticker, stexTp = null) {
    const list = await this.getUsStockQuotes(accessToken, [ticker], stexTp);
    return list[0] || null;
  }

  /**
   * 미국주식 현재가 배치 (usa20100)
   * 국내 ka10095처럼 stk_cd에 | 구분을 시도하고, 실패·부분응답 시 단건 폴백
   * @param {string} accessToken
   * @param {string[]} tickers
   * @param {string|null} stexTp
   * @returns {Promise<Array<{ stockCode, stockName, price, change, changeRate, exchange }>>}
   */
  /**
   * 미국주식 현재가 배치 (usa20100)
   * ※ 검증 결과: stk_cd에 AAPL|MSFT 형태는 키움이 거부함 → 단건만 사용
   * stex_tp 필수 (예: ND). 없으면 us_stock_list.exchange 조회, 기본 ND
   * @param {string} accessToken
   * @param {string[]} tickers
   * @param {string|null} stexTp 공통 거래소 (종목별이 다르면 null 권장)
   * @returns {Promise<Array<{ stockCode, stockName, price, change, changeRate, exchange }>>}
   */
  async getUsStockQuotes(accessToken, tickers, stexTp = null) {
    const codes = [
      ...new Set(
        (tickers || [])
          .map((t) => String(t || '').trim().toUpperCase())
          .filter(Boolean)
      ),
    ];
    if (!codes.length) return [];

    const { getUsStockByTicker } = require('../utils/usStockListStore');
    const endpoint = '/api/us/mrkcond';
    const mapByCode = new Map();

    // 종목별 stex_tp 결정
    const jobs = [];
    for (const stkCd of codes) {
      let stex = stexTp != null && String(stexTp).trim() !== '' ? String(stexTp).trim() : null;
      if (!stex) {
        try {
          const master = await getUsStockByTicker(stkCd);
          stex = master?.exchange || null;
        } catch {
          /* ignore */
        }
      }
      if (!stex) stex = 'ND';
      jobs.push({ stkCd, stex });
    }

    // 유량 제한(usa20100 ~5회) 대비 순차 호출
    for (const { stkCd, stex } of jobs) {
      try {
        const body = { stk_cd: stkCd, stex_tp: stex };
        const result = await this.postUsTr(accessToken, endpoint, 'usa20100', body);
        const rows = this.extractResponseArray(result.data);
        const item = rows[0] || result.data || {};
        const got = this.parseUsQuoteItem(item, stkCd, stex);
        if (got) mapByCode.set(stkCd, got);
      } catch (error) {
        console.warn(
          `[키움증권 API] usa20100 단건 실패 ${stkCd}(${stex}):`,
          error.message || error
        );
        if (error?.isRateLimit) break;
      }
    }

    return codes.map((c) => mapByCode.get(c)).filter(Boolean);
  }

  /**
   * 국내주식 예수금상세현황 (kt00001)
   * qry_tp: 3=추정조회, 2=일반조회
   */
  async getKrDeposit(accessToken, { qryTp = '3', contYn = 'N', nextKey = '' } = {}) {
    try {
      const endpoint = '/api/dostk/acnt';
      const url = `${this.baseURL}${endpoint}`;
      const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        authorization: `Bearer ${accessToken}`,
        'cont-yn': contYn || 'N',
        'next-key': nextKey || '',
        'api-id': 'kt00001',
      };
      const data = {
        qry_tp: String(qryTp || '3'),
      };

      const response = await axios.post(url, data, {
        headers,
        timeout: 15000,
        validateStatus: () => true,
      });

      if (response.status !== 200) {
        throw this.handleError({ response });
      }

      if (response.data.return_code !== undefined && response.data.return_code !== 0) {
        console.error('[키움증권 API] 예수금상세현황 조회 실패:', response.data);
        throw {
          status: 400,
          message: response.data.return_msg || '예수금 조회에 실패했습니다.',
          data: response.data,
        };
      }

      return response.data;
    } catch (error) {
      console.error('[키움증권 API] 예수금상세현황 조회 실패:', error.response?.data || error.message);
      throw this.handleError(error);
    }
  }

  /**
   * 해외주식 예수금 (ust21110)
   */
  async getUsDeposit(accessToken) {
    const result = await this.postUsTr(accessToken, '/api/us/acnt', 'ust21110', {});
    return result.data || {};
  }

  /**
   * 미국주식 원장잔고확인 (ust21070)
   * stex_tp: ND/NY/NA 또는 빈값(전체), stk_cd 빈값=전체
   */
  async getUsLedgerBalance(accessToken, { stexTp = '', stkCd = '', maxPages = 30 } = {}) {
    const allRows = [];
    let contYn = 'N';
    let nextKey = '';
    let firstPage = null;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.postUsTr(
        accessToken,
        '/api/us/acnt',
        'ust21070',
        {
          stex_tp: stexTp == null ? '' : String(stexTp),
          stk_cd: stkCd == null ? '' : String(stkCd).trim().toUpperCase(),
        },
        { contYn, nextKey, timeout: 20000 }
      );
      const data = result.data || {};
      if (!firstPage) firstPage = data;
      const rows = this.extractResponseArray(data);
      if (Array.isArray(rows) && rows.length) {
        allRows.push(...rows);
      }
      if (result.contYn !== 'Y' || !result.nextKey) break;
      contYn = 'Y';
      nextKey = result.nextKey;
    }

    return {
      ...(firstPage || {}),
      holdings: allRows,
      return_code: firstPage?.return_code ?? 0,
      return_msg: firstPage?.return_msg,
    };
  }

  /**
   * 미국주식 당일 주문체결 확인 (ust21510)
   * slby_tp: 0 전체 / 1 매도 / 2 매수, stex_tp 는 stk_cd 입력 시에만 의미
   */
  async getUsOrderExecutions(accessToken, { slbyTp = '0', stexTp = '', stkCd = '', maxPages = 10 } = {}) {
    const allRows = [];
    let contYn = 'N';
    let nextKey = '';
    let firstPage = null;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.postUsTr(
        accessToken,
        '/api/us/acnt',
        'ust21510',
        {
          slby_tp: String(slbyTp ?? '0'),
          stex_tp: stexTp == null ? '' : String(stexTp),
          stk_cd: stkCd == null ? '' : String(stkCd).trim().toUpperCase(),
        },
        { contYn, nextKey, timeout: 20000 }
      );
      const data = result.data || {};
      if (!firstPage) firstPage = data;
      const rows = this.extractResponseArray(data);
      if (Array.isArray(rows) && rows.length) {
        allRows.push(...rows);
      }
      if (result.contYn !== 'Y' || !result.nextKey) break;
      contYn = 'Y';
      nextKey = result.nextKey;
    }

    return {
      rows: allRows,
      return_code: firstPage?.return_code ?? 0,
      return_msg: firstPage?.return_msg,
    };
  }
}

module.exports = new KiwoomAPI();


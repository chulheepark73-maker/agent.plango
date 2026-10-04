/**
 * 키움증권 관련 공통 유틸리티 함수
 */

/**
 * 사용자 키움 정보 (broker_accounts + broker_account_credentials)
 * @param {string} userId - 사용자 ID
 * @returns {Promise<Object|null>} 키움 정보 객체 또는 null
 */
const getKiwoomInfo = async (userId) => {
  const { getBrokerKiwoomBundle } = require('./brokerCredentialsStore');
  const bundle = await getBrokerKiwoomBundle(userId);
  if (!bundle) {
    return {
      accessToken: null,
      appKey: null,
      appSecret: null,
      accountNo: null,
      tokenExpiresAt: null,
    };
  }

  let accessToken = bundle.accessToken || null;
  const tokenExpiresAt = bundle.tokenExpiresAt;

  if (accessToken && tokenExpiresAt) {
    const expiresAt = new Date(tokenExpiresAt);
    if (Date.now() >= expiresAt.getTime()) {
      console.warn(
        `[kiwoomUtils] user=${userId} 토큰 만료 처리 expiresAt=${tokenExpiresAt} now=${new Date().toISOString()}`
      );
      accessToken = null;
    }
  }

  return {
    accessToken,
    appKey: bundle.appKey || null,
    appSecret: bundle.appSecret || null,
    accountNo: bundle.accountNo || null,
    tokenExpiresAt: tokenExpiresAt || null,
  };
};

/**
 * 종목코드 정규화 (앞뒤 문자 제거, 거래소 접미사 제거)
 * @param {string} code - 원본 종목코드
 * @returns {string} 정규화된 종목코드
 */
const normalizeStockCode = (code) => {
  if (!code || typeof code !== 'string') return '';
  
  let normalized = code;
  // 앞의 *A나 다른 문자 제거 (예: *A451250 -> 451250)
  normalized = normalized.replace(/^[*A-Z]/, '');
  // 뒤의 _NX, _NX2 등 거래소 접미사 제거 (예: 451250_NX -> 451250)
  normalized = normalized.replace(/_[A-Z0-9]+$/, '');
  // 앞뒤 공백 제거
  normalized = normalized.trim();
  
  return normalized;
};

/**
 * 종목코드로 매핑 맵 생성 (응답 데이터에서)
 * @param {Array} stockInfoArray - 종목 정보 배열 (atn_stk_infr 등)
 * @returns {Map} 정규화된 종목코드를 키로 하는 Map
 */
const createStockCodeMap = (stockInfoArray) => {
  const codeMap = new Map();
  
  if (!Array.isArray(stockInfoArray)) return codeMap;
  
  stockInfoArray.forEach(info => {
    const code = info.stk_cd || info.pdno || '';
    const normalized = normalizeStockCode(code);
    
    if (normalized) {
      // 전체 코드로 매핑
      codeMap.set(normalized, info);
      // 앞 6자리로도 매핑 (005930_NX -> 005930 형태 처리)
      const baseCode = normalized.substring(0, 6);
      if (baseCode && baseCode !== normalized) {
        codeMap.set(baseCode, info);
      }
    }
  });
  
  return codeMap;
};

/**
 * 키움 정보 검증 (공통 체크)
 * @param {Object} kiwoomInfo - 키움 정보 객체
 * @returns {Object|null} 에러 객체 또는 null (에러 없음)
 */
const validateKiwoomInfo = (kiwoomInfo) => {
  if (!kiwoomInfo || !kiwoomInfo.accessToken) {
    return {
      status: 400,
      error:
        '키움증권 토큰이 설정되지 않았거나 만료되었습니다. 나의 환경설정에서 토큰을 발급해주세요.',
    };
  }

  if (!kiwoomInfo.appKey || !kiwoomInfo.appSecret) {
    return {
      status: 400,
      error: 'App Key와 App Secret을 먼저 등록해주세요.',
    };
  }

  return null;
};

module.exports = {
  getKiwoomInfo,
  normalizeStockCode,
  createStockCodeMap,
  validateKiwoomInfo,
  /** getAllUsers 결과 중 키움 연동 가능 사용자만 */
  async filterUsersWithKiwoom(users, { requireAccount = false } = {}) {
    const out = [];
    for (const user of users || []) {
      try {
        const info = await getKiwoomInfo(user.id);
        if (!info?.accessToken || !info?.appKey || !info?.appSecret) continue;
        if (requireAccount && !info.accountNo) continue;
        out.push(user);
      } catch {
        /* skip */
      }
    }
    return out;
  },
};

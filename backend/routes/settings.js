const express = require('express');
const path = require('path');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const { getUserById } = require('../utils/userStore');
const kiwoomAPI = require('../services/kiwoomApi');
const central = require('../services/centralClient');
const pool = require('../utils/db');
const {
  getOrCreateUserSettings,
  updateUserSettings,
} = require('../utils/userSettingsStore');
const { getSubscriptionSummaryForUser } = require('../utils/subscriptionStore');
const {
  ensurePlanStatusTable,
  getPlanStatusByUserId,
} = require('../utils/planStatusStore');
const {
  getBrokerKiwoomBundle,
  getBrokerFeeRates,
  saveBrokerFeeRates,
  saveAccountNo,
  saveAppCredentials,
  saveAccessToken,
  clearAccessToken,
} = require('../utils/brokerCredentialsStore');

let appVersion = '0.0.0';
try {
  // 루트 package.json (backend/routes → ../../package.json)
  appVersion = require(path.join(__dirname, '../../package.json')).version || appVersion;
} catch {
  try {
    appVersion = require(path.join(__dirname, '../package.json')).version || appVersion;
  } catch {
    /* ignore */
  }
}
const DEFAULT_WATCH_LIST_NAME = '제목없음';
const normalizeWatchListTitle = (value) => {
  const v = String(value ?? '').trim();
  if (!v) return DEFAULT_WATCH_LIST_NAME;
  return v.length > 30 ? v.slice(0, 30) : v;
};

const parseTargetAmount = (value) => {
  const cleaned = String(value ?? '').replace(/[^0-9]/g, '');
  if (!cleaned) return 0;
  const parsed = parseInt(cleaned, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
};

// 환경설정 조회
router.get('/', authenticateToken, async (req, res) => {
  try {
    await ensurePlanStatusTable();
    const user = await getUserById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }
    const plan = await getPlanStatusByUserId(req.user.userId);
    const kiwoom = await getBrokerKiwoomBundle(req.user.userId);

    // 토큰 만료 체크 (broker_account_credentials)
    let hasAccessToken = !!kiwoom?.accessToken;
    let isTokenExpired = false;
    let tokenStatus = 'none'; // 'none', 'valid', 'expired'
    
    if (kiwoom?.accessToken && kiwoom?.tokenExpiresAt) {
      const expiresAt = new Date(kiwoom.tokenExpiresAt);
      const now = new Date();

      if (now >= expiresAt) {
        isTokenExpired = true;
        tokenStatus = 'expired';
      } else {
        tokenStatus = 'valid';
      }
    } else if (!kiwoom?.accessToken) {
      tokenStatus = 'none';
    }

    // 토큰 남은 시간 계산
    let tokenRemainingTime = null;
    if (kiwoom?.tokenExpiresAt) {
      const expiresAt = new Date(kiwoom.tokenExpiresAt);
      const now = new Date();
      const timeDiff = expiresAt - now;
      if (timeDiff > 0) {
        const hours = Math.floor(timeDiff / (1000 * 60 * 60));
        const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
        tokenRemainingTime = {
          totalMs: timeDiff,
          hours: hours,
          minutes: minutes,
          formatted: hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`
        };
      }
    }

    let telegram = {};
    try {
      // 연결 대기 중에는 프론트가 2초 간격으로 조회 → 캐시 우회
      const pending = !!central.getCachedOwnerStatus()?.telegram?.telegramLinkPending;
      telegram = (await central.getOwnerStatus({ force: pending }))?.telegram || {};
    } catch (e) {
      console.warn('[환경설정 조회] 중앙 텔레그램 상태 조회 실패:', e.message);
    }

    // 민감한 정보는 제외하고 반환
    const feeRates = await getBrokerFeeRates(req.user.userId);
    res.json({
      kiwoomAppKey: kiwoom?.appKey || '',
      kiwoomAppSecret: kiwoom?.appSecret ? '***' : '',
      hasAppSecret: !!kiwoom?.appSecret,
      hasAccessToken: hasAccessToken,
      isTokenExpired: isTokenExpired,
      tokenStatus: tokenStatus,
      tokenExpiresAt: kiwoom?.tokenExpiresAt || null,
      tokenRemainingTime: tokenRemainingTime,
      kiwoomAccountNo: kiwoom?.accountNo || null,
      buyFeeRate: feeRates.buyFeeRate,
      sellFeeRate: feeRates.sellFeeRate,
      sellTaxRate: feeRates.sellTaxRate,
      usBuyFeeRate: feeRates.usBuyFeeRate,
      usSellFeeRate: feeRates.usSellFeeRate,
      usSellTaxRate: feeRates.usSellTaxRate,
      hasTelegramChatId: !!telegram.hasTelegramChatId,
      telegramDeepLinkReady: !!telegram.telegramDeepLinkReady,
      telegramLinkPending: !!telegram.telegramLinkPending,
      planWeek: Number(plan.krWeek || 0),
      planMonth: Number(plan.krMonth || 0),
      planYear: Number(plan.krYear || 0),
      planUsWeek: Number(plan.usWeek || 0),
      planUsMonth: Number(plan.usMonth || 0),
      planUsYear: Number(plan.usYear || 0),
      appVersion,
    });
  } catch (error) {
    console.error('[환경설정 조회] 에러:', error);
    res.status(500).json({ error: '환경설정 조회 중 오류가 발생했습니다.' });
  }
});

// Plan 대비 진행사항 목표금액 저장 (KR / US)
router.post('/plan-status', authenticateToken, async (req, res) => {
  try {
    await ensurePlanStatusTable();
    const existing = await getPlanStatusByUserId(req.user.userId);

    const hasKr =
      req.body.week != null ||
      req.body.month != null ||
      req.body.year != null ||
      req.body.krWeek != null ||
      req.body.krMonth != null ||
      req.body.krYear != null;
    const hasUs =
      req.body.usWeek != null ||
      req.body.usMonth != null ||
      req.body.usYear != null ||
      req.body.us_week != null ||
      req.body.us_month != null ||
      req.body.us_year != null;

    const krWeek = hasKr
      ? parseTargetAmount(req.body.krWeek ?? req.body.week ?? existing.krWeek)
      : existing.krWeek;
    const krMonth = hasKr
      ? parseTargetAmount(req.body.krMonth ?? req.body.month ?? existing.krMonth)
      : existing.krMonth;
    const krYear = hasKr
      ? parseTargetAmount(req.body.krYear ?? req.body.year ?? existing.krYear)
      : existing.krYear;

    const usWeek = hasUs
      ? parseTargetAmount(req.body.usWeek ?? req.body.us_week ?? existing.usWeek)
      : existing.usWeek;
    const usMonth = hasUs
      ? parseTargetAmount(req.body.usMonth ?? req.body.us_month ?? existing.usMonth)
      : existing.usMonth;
    const usYear = hasUs
      ? parseTargetAmount(req.body.usYear ?? req.body.us_year ?? existing.usYear)
      : existing.usYear;

    if (!hasKr && !hasUs) {
      return res.status(400).json({
        error: '저장할 목표금액이 없습니다.',
      });
    }

    if (
      krWeek === null ||
      krMonth === null ||
      krYear === null ||
      usWeek === null ||
      usMonth === null ||
      usYear === null
    ) {
      return res.status(400).json({
        error: '주간/월간/년간 목표금액은 0 이상의 숫자만 입력해주세요.',
      });
    }

    const result = await pool.query(
      `
      INSERT INTO plan_status (
        user_id, kr_week, kr_month, kr_year, us_week, us_month, us_year, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) DO UPDATE
      SET kr_week = EXCLUDED.kr_week,
          kr_month = EXCLUDED.kr_month,
          kr_year = EXCLUDED.kr_year,
          us_week = EXCLUDED.us_week,
          us_month = EXCLUDED.us_month,
          us_year = EXCLUDED.us_year,
          updated_at = CURRENT_TIMESTAMP
      RETURNING kr_week, kr_month, kr_year, us_week, us_month, us_year, updated_at
      `,
      [req.user.userId, krWeek, krMonth, krYear, usWeek, usMonth, usYear]
    );

    const row = result.rows[0];
    return res.json({
      message: '수익 목표가 저장되었습니다.',
      planWeek: Number(row.kr_week || 0),
      planMonth: Number(row.kr_month || 0),
      planYear: Number(row.kr_year || 0),
      planUsWeek: Number(row.us_week || 0),
      planUsMonth: Number(row.us_month || 0),
      planUsYear: Number(row.us_year || 0),
      updatedAt: row.updated_at,
    });
  } catch (error) {
    console.error('[Plan Status 저장] 에러:', error);
    return res.status(500).json({ error: '수익 목표 저장 중 오류가 발생했습니다.' });
  }
});

// 관심종목 이름 저장 (레거시 → user_settings.group_name1~5)
router.post('/watchlist-names', authenticateToken, async (req, res) => {
  try {
    const patch = {
      groupName1: normalizeWatchListTitle(req.body.watchList1 ?? req.body.groupName1),
      groupName2: normalizeWatchListTitle(req.body.watchList2 ?? req.body.groupName2),
      groupName3: normalizeWatchListTitle(req.body.watchList3 ?? req.body.groupName3),
      groupName4: normalizeWatchListTitle(req.body.watchList4 ?? req.body.groupName4),
      groupName5: normalizeWatchListTitle(req.body.watchList5 ?? req.body.groupName5),
    };
    const settings = await updateUserSettings(req.user.userId, patch);
    return res.json({
      message: '관심종목 이름이 저장되었습니다.',
      watchList1: settings.groupName1,
      watchList2: settings.groupName2,
      watchList3: settings.groupName3,
      watchList4: settings.groupName4,
      watchList5: settings.groupName5,
      groupName1: settings.groupName1,
      groupName2: settings.groupName2,
      groupName3: settings.groupName3,
      groupName4: settings.groupName4,
      groupName5: settings.groupName5,
    });
  } catch (error) {
    console.error('[관심종목 이름 저장] 에러:', error);
    return res.status(500).json({ error: '관심종목 이름 저장 중 오류가 발생했습니다.' });
  }
});

// user_settings 조회 (V2-1 그룹명·테마·가격갱신주기)
router.get('/user-settings', authenticateToken, async (req, res) => {
  try {
    const settings = await getOrCreateUserSettings(req.user.userId);
    return res.json(settings);
  } catch (error) {
    console.error('[user-settings 조회] 에러:', error);
    return res.status(500).json({ error: '사용자 설정 조회 중 오류가 발생했습니다.' });
  }
});

// user_settings 부분 업데이트 (theme / priceRefreshInterval / groupName*)
router.put('/user-settings', authenticateToken, async (req, res) => {
  try {
    const patch = {};
    if (req.body.theme !== undefined) patch.theme = req.body.theme;
    if (req.body.priceRefreshInterval !== undefined) {
      patch.priceRefreshInterval = req.body.priceRefreshInterval;
    }
    for (let n = 1; n <= 8; n += 1) {
      const key = `groupName${n}`;
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }

    const settings = await updateUserSettings(req.user.userId, patch);
    return res.json({
      message: '사용자 설정이 저장되었습니다.',
      ...settings,
    });
  } catch (error) {
    console.error('[user-settings 저장] 에러:', error);
    return res.status(500).json({ error: '사용자 설정 저장 중 오류가 발생했습니다.' });
  }
});

// V2 관심그룹 이름 저장 (user_settings.group_name1~8)
router.post('/user-settings/group-names', authenticateToken, async (req, res) => {
  try {
    const patch = {};
    for (let n = 1; n <= 8; n += 1) {
      const key = `groupName${n}`;
      // 항상 8개 컬럼을 갱신 (미전송·빈값 → 제목없음은 store에서 정규화)
      patch[key] = req.body?.[key] ?? '';
    }
    const settings = await updateUserSettings(req.user.userId, patch);
    const names = {};
    for (let n = 1; n <= 8; n += 1) {
      const key = `groupName${n}`;
      names[key] = settings[key];
    }
    console.log('[user-settings 그룹명 저장]', {
      userId: req.user.userId,
      ...names,
    });
    return res.json({
      message: 'V2 관심그룹 이름이 저장되었습니다.',
      ...names,
    });
  } catch (error) {
    console.error('[user-settings 그룹명 저장] 에러:', error);
    return res.status(500).json({ error: 'V2 관심그룹 이름 저장 중 오류가 발생했습니다.' });
  }
});

// 미국 관심종목 이름 저장 (레거시 → user_settings.group_name1~5 공유)
router.post('/us-watchlist-names', authenticateToken, async (req, res) => {
  try {
    const patch = {
      groupName1: normalizeWatchListTitle(req.body.usWatchList1 ?? req.body.groupName1),
      groupName2: normalizeWatchListTitle(req.body.usWatchList2 ?? req.body.groupName2),
      groupName3: normalizeWatchListTitle(req.body.usWatchList3 ?? req.body.groupName3),
      groupName4: normalizeWatchListTitle(req.body.usWatchList4 ?? req.body.groupName4),
      groupName5: normalizeWatchListTitle(req.body.usWatchList5 ?? req.body.groupName5),
    };
    const settings = await updateUserSettings(req.user.userId, patch);
    return res.json({
      message: '미국 관심종목 이름이 저장되었습니다.',
      usWatchList1: settings.groupName1,
      usWatchList2: settings.groupName2,
      usWatchList3: settings.groupName3,
      usWatchList4: settings.groupName4,
      usWatchList5: settings.groupName5,
      groupName1: settings.groupName1,
      groupName2: settings.groupName2,
      groupName3: settings.groupName3,
      groupName4: settings.groupName4,
      groupName5: settings.groupName5,
    });
  } catch (error) {
    console.error('[미국 관심종목 이름 저장] 에러:', error);
    return res.status(500).json({ error: '미국 관심종목 이름 저장 중 오류가 발생했습니다.' });
  }
});

// App Key/Secret 저장
router.post('/app-credentials', authenticateToken, [
  body('appKey').notEmpty().withMessage('App Key가 필요합니다.')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { appKey, appSecret } = req.body;

    await saveAppCredentials(req.user.userId, {
      appKey,
      ...(appSecret ? { appSecret } : {}),
    });

    res.json({
      message: 'App Key/Secret이 저장되었습니다.',
      hasAccessToken: false,
    });
  } catch (error) {
    res.status(500).json({ error: 'App Key/Secret 저장 중 오류가 발생했습니다.' });
  }
});

// 액세스 토큰 발급
router.post('/generate-token', authenticateToken, async (req, res) => {
  try {
    const kiwoom = await getBrokerKiwoomBundle(req.user.userId);
    if (!kiwoom) {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }

    if (!kiwoom.appKey || !kiwoom.appSecret) {
      return res.status(400).json({ 
        error: 'App Key와 App Secret을 먼저 등록해주세요.' 
      });
    }

    // 키움증권 API를 통해 토큰 발급
    console.log('[토큰 발급] 사용자 정보:', {
      userId: req.user.userId,
      hasAppKey: !!kiwoom.appKey,
      hasAppSecret: !!kiwoom.appSecret,
      appKeyLength: kiwoom.appKey?.length,
      appSecretLength: kiwoom.appSecret?.length
    });
    
    let tokenData;
    try {
      tokenData = await kiwoomAPI.generateAccessToken(
        kiwoom.appKey,
        kiwoom.appSecret
      );
    } catch (error) {
      // 단말기 인증 실패 오류 처리
      if (error.data?.return_code === 3 && error.message?.includes('8050')) {
        return res.status(400).json({
          error: '단말기 인증에 실패했습니다.',
          details: '키움증권 홈페이지에서 현재 IP 주소를 등록해주세요.',
          help: '키움증권 OpenAPI 홈페이지 > 단말기 등록 메뉴에서 현재 컴퓨터의 IP 주소를 등록해야 합니다.',
          errorCode: error.data?.return_code,
          errorMessage: error.message
        });
      }
      throw error;
    }

    // 토큰 만료 시간 처리
    // 키움증권 API는 expires_dt를 반환: "20241107083713" 형식
    let expiresAt;
    let expiresIn = 86400; // 기본값
    
    if (tokenData.expires_dt) {
      // expires_dt를 ISO 형식으로 변환
      // 키움증권 API의 expires_dt는 한국 시간(KST, UTC+9) 형식입니다
      const expiresDt = tokenData.expires_dt; // "YYYYMMDDHHmmss"
      try {
        const year = expiresDt.substring(0, 4);
        const month = expiresDt.substring(4, 6);
        const day = expiresDt.substring(6, 8);
        const hour = expiresDt.substring(8, 10);
        const minute = expiresDt.substring(10, 12);
        const second = expiresDt.substring(12, 14);
        
        // 한국 시간(KST) 문자열을 UTC로 변환
        // "YYYY-MM-DDTHH:mm:ss+09:00" 형식으로 만들어서 UTC로 변환
        const kstString = `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
        const expiresDateUTC = new Date(kstString);
        expiresAt = expiresDateUTC.toISOString();
        
        // expires_dt로부터 expires_in 계산
        const now = new Date();
        expiresIn = Math.floor((expiresDateUTC - now) / 1000);
        if (expiresIn < 0) {
          expiresIn = 86400; // 과거 날짜면 기본값 사용
        }
      } catch (e) {
        console.error('[토큰 발급] expires_dt 파싱 실패:', e);
        // 파싱 실패 시 expires_in 사용
        expiresIn = tokenData.expires_in || 86400;
        expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      }
    } else {
      // expires_dt가 없으면 expires_in 사용
      expiresIn = tokenData.expires_in || 86400;
      expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    }

    // broker_account_credentials 에 토큰 저장
    await saveAccessToken(req.user.userId, {
      accessToken: tokenData.access_token,
      expiresAt: expiresAt,
    });

    res.json({
      message: '액세스 토큰이 발급되었습니다.',
      expiresAt: expiresAt,
      expiresIn: expiresIn,
    });
  } catch (error) {
    console.error('[토큰 발급 API] 에러:', error);
    
    // 에러 객체에서 상세 정보 추출
    const status = error.status || 500;
    const message = error.message || '토큰 발급 중 오류가 발생했습니다.';
    const errorData = error.data || null;
    
    // 상세한 에러 메시지 구성
    let detailedMessage = message;
    if (errorData) {
      if (typeof errorData === 'object' && errorData.msg) {
        detailedMessage = errorData.msg;
      } else if (typeof errorData === 'string') {
        detailedMessage = errorData;
      }
    }
    
    res.status(status).json({
      error: detailedMessage,
      status: status,
      data: errorData,
    });
  }
});

// 액세스 토큰 삭제
router.delete('/token', authenticateToken, async (req, res) => {
  try {
    await clearAccessToken(req.user.userId);

    res.json({ message: '액세스 토큰이 삭제되었습니다.' });
  } catch (error) {
    res.status(500).json({ error: '토큰 삭제 중 오류가 발생했습니다.' });
  }
});

// 텔레그램 봇 연결 딥링크 — 중앙 서버가 발급 (봇 토큰·chat_id 는 중앙에만 저장)
router.post('/telegram-deep-link', authenticateToken, async (req, res) => {
  try {
    const data = await central.createTelegramDeepLink();
    central.invalidateOwnerStatus();
    res.json(data);
  } catch (error) {
    console.error('[텔레그램 딥링크] 중앙 오류:', error.message);
    res.status(error.status && error.status < 500 ? error.status : 502).json({
      error: error.data?.error || '연결 링크 생성 중 오류가 발생했습니다.',
    });
  }
});

// 텔레그램 연결 해제 — 중앙 서버
router.delete('/telegram-notification', authenticateToken, async (req, res) => {
  try {
    await central.unlinkTelegram();
    central.invalidateOwnerStatus();
    res.json({
      message: '텔레그램 알림 설정이 삭제되었습니다.',
      hasTelegramChatId: false,
      telegramLinkPending: false,
    });
  } catch (error) {
    console.error('[텔레그램 알림 삭제] 중앙 오류:', error.message);
    res.status(502).json({ error: '삭제 중 오류가 발생했습니다.' });
  }
});

// 계좌번호 + 국내 수수료·거래세 저장 (broker_accounts)
router.post('/account-no', authenticateToken, [
  body('accountNo').notEmpty().withMessage('계좌번호가 필요합니다.')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { accountNo } = req.body;
    await saveAccountNo(req.user.userId, accountNo);

    const toRate = (percent) => {
      if (percent == null || percent === '') return undefined;
      const n = Number(percent);
      if (!Number.isFinite(n) || n < 0 || n > 10) {
        throw Object.assign(new Error('수수료/세금 %는 0~10 범위여야 합니다.'), { status: 400 });
      }
      return n / 100;
    };

    const feeRates = await saveBrokerFeeRates(req.user.userId, {
      buyFeeRate:
        req.body.buyFeePercent != null && req.body.buyFeePercent !== ''
          ? toRate(req.body.buyFeePercent)
          : undefined,
      sellFeeRate:
        req.body.sellFeePercent != null && req.body.sellFeePercent !== ''
          ? toRate(req.body.sellFeePercent)
          : undefined,
      sellTaxRate:
        req.body.sellTaxPercent != null && req.body.sellTaxPercent !== ''
          ? toRate(req.body.sellTaxPercent)
          : undefined,
      usBuyFeeRate:
        req.body.usBuyFeePercent != null && req.body.usBuyFeePercent !== ''
          ? toRate(req.body.usBuyFeePercent)
          : undefined,
      usSellFeeRate:
        req.body.usSellFeePercent != null && req.body.usSellFeePercent !== ''
          ? toRate(req.body.usSellFeePercent)
          : undefined,
      usSellTaxRate:
        req.body.usSellTaxPercent != null && req.body.usSellTaxPercent !== ''
          ? toRate(req.body.usSellTaxPercent)
          : undefined,
    });

    res.json({
      message: '계좌·수수료 설정이 저장되었습니다.',
      kiwoomAccountNo: accountNo,
      buyFeeRate: feeRates.buyFeeRate,
      sellFeeRate: feeRates.sellFeeRate,
      sellTaxRate: feeRates.sellTaxRate,
      usBuyFeeRate: feeRates.usBuyFeeRate,
      usSellFeeRate: feeRates.usSellFeeRate,
      usSellTaxRate: feeRates.usSellTaxRate,
    });
  } catch (error) {
    console.error('[계좌·수수료 저장] 에러:', error);
    res.status(error.status || 500).json({
      error: error.message || '계좌·수수료 저장 중 오류가 발생했습니다.',
    });
  }
});

// 내 구독 요약 (중앙 서버 기준, 구독 신청/취소는 중앙 웹에서)
router.get('/subscription', authenticateToken, async (req, res) => {
  try {
    const summary = await getSubscriptionSummaryForUser(req.user.userId);
    res.json(summary);
  } catch (error) {
    console.error('[구독 조회] 에러:', error);
    res.status(500).json({ error: '구독 정보 조회 중 오류가 발생했습니다.' });
  }
});

module.exports = router;

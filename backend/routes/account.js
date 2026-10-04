const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const kiwoomAPI = require('../services/kiwoomApi');
const { getKiwoomInfo, validateKiwoomInfo } = require('../utils/kiwoomUtils');

// 중복 로그 방지를 위한 캐시 (userId -> { lastLogTime, lastLogType })
const logCache = new Map();
const LOG_DEDUP_INTERVAL = 1000; // 1초 내 중복 로그 방지

// 계좌 정보 조회
router.get('/info', authenticateToken, async (req, res) => {
  try {
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    const accountInfo = await kiwoomAPI.getAccountInfo(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      kiwoomInfo.accountNo
    );

    res.json(accountInfo);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || '계좌 정보 조회 중 오류가 발생했습니다.',
      data: error.data
    });
  }
});

// 잔고 조회
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    const balance = await kiwoomAPI.getBalance(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret
    );
    res.json(balance);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || '잔고 조회 중 오류가 발생했습니다.',
      data: error.data
    });
  }
});

// 보유 종목 조회 (kt00004 - 계좌평가현황요청)
// 참고: kt00004는 계좌 평가 현황과 함께 보유 종목 정보를 제공합니다.
router.get('/holdings', authenticateToken, async (req, res) => {
  try {
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    // 쿼리 파라미터에서 연속조회 정보 가져오기
    const contYn = req.query.cont_yn || 'N';
    const nextKey = req.query.next_key || '';

    const holdings = await kiwoomAPI.getHoldings(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      kiwoomInfo.accountNo,
      contYn,
      nextKey
    );

    res.json(holdings);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || '보유 종목 조회 중 오류가 발생했습니다.',
      data: error.data
    });
  }
});

/** 국내주식 예수금상세현황 (kt00001) */
router.get('/deposit', authenticateToken, async (req, res) => {
  try {
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    const qryTp = req.query.qry_tp != null ? String(req.query.qry_tp) : '3';
    const contYn = req.query.cont_yn || 'N';
    const nextKey = req.query.next_key || '';
    const deposit = await kiwoomAPI.getKrDeposit(kiwoomInfo.accessToken, {
      qryTp,
      contYn,
      nextKey,
    });
    res.json(deposit);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || '국내주식 예수금 조회 중 오류가 발생했습니다.',
      data: error.data,
    });
  }
});

/** 미국주식 예수금 (ust21110) */
router.get('/us/deposit', authenticateToken, async (req, res) => {
  try {
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    const deposit = await kiwoomAPI.getUsDeposit(kiwoomInfo.accessToken);
    res.json(deposit);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || '미국주식 예수금 조회 중 오류가 발생했습니다.',
      data: error.data,
    });
  }
});

/** 미국주식 원장잔고 (ust21070) */
router.get('/us/holdings', authenticateToken, async (req, res) => {
  try {
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    const stexTp = req.query.stex_tp != null ? String(req.query.stex_tp) : '';
    const stkCd = req.query.stk_cd != null ? String(req.query.stk_cd) : '';
    const ledger = await kiwoomAPI.getUsLedgerBalance(kiwoomInfo.accessToken, {
      stexTp,
      stkCd,
    });
    res.json(ledger);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || '미국주식 원장잔고 조회 중 오류가 발생했습니다.',
      data: error.data,
    });
  }
});

// 통합 조회: 계좌정보만 조회 (kt00004 - 계좌평가현황요청)
router.get('/all', authenticateToken, async (req, res) => {
  try {
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    // 계좌정보만 조회 (kt00004)
    const accountInfo = await kiwoomAPI.getAccountInfo(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      kiwoomInfo.accountNo
    );

    res.json({
      accountInfo: accountInfo
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || '계좌 정보 조회 중 오류가 발생했습니다.',
      data: error.data
    });
  }
});

// 주문번호로 체결 여부 확인
router.get('/executions/check/:orderNo', authenticateToken, async (req, res) => {
  const startTime = Date.now();
  const userId = req.user.userId;
  const orderNo = req.params.orderNo;
  
  console.log('[체결 여부 확인 API] 요청 시작');
  console.log('[체결 여부 확인 API] 사용자 ID:', userId);
  console.log('[체결 여부 확인 API] 주문번호:', orderNo);
  
  try {
    const kiwoomInfo = await getKiwoomInfo(userId);
    
    if (!kiwoomInfo || !kiwoomInfo.accessToken) {
      return res.status(400).json({ 
        error: '키움증권 토큰이 설정되지 않았거나 만료되었습니다.' 
      });
    }
    if (!kiwoomInfo.appKey || !kiwoomInfo.appSecret) {
      return res.status(400).json({ error: 'App Key와 App Secret을 먼저 등록해주세요.' });
    }

    const result = await kiwoomAPI.checkOrderExecution(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      kiwoomInfo.accountNo,
      orderNo
    );
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log('[체결 여부 확인 API] 완료 (소요시간:', duration, 'ms)');
    console.log('[체결 여부 확인 API] 체결 여부:', result.isExecuted);
    console.log('[체결 여부 확인 API] 체결 건수:', result.executionCount);
    
    res.json(result);
  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.error('[체결 여부 확인 API] 에러 발생 (소요시간:', duration, 'ms)');
    console.error('[체결 여부 확인 API] 에러:', error);
    
    res.status(error.status || 500).json({
      error: error.message || '체결 여부 확인 중 오류가 발생했습니다.',
      data: error.data
    });
  }
});

// 체결내역 조회 (kt00009 - 계좌별주문체결현황요청)
router.get('/executions', authenticateToken, async (req, res) => {
  const startTime = Date.now();
  const userId = req.user.userId;
  
  console.log('[체결내역 조회 API] 요청 시작');
  console.log('[체결내역 조회 API] 사용자 ID:', userId);
  console.log('[체결내역 조회 API] 쿼리 파라미터:', req.query);
  
  try {
    console.log('[체결내역 조회 API] 키움 정보 조회 시작');
    const kiwoomInfo = await getKiwoomInfo(userId);
    
    console.log('[체결내역 조회 API] 키움 정보 조회 결과:', {
      hasAccessToken: !!kiwoomInfo?.accessToken,
      hasAppKey: !!kiwoomInfo?.appKey,
      hasAppSecret: !!kiwoomInfo?.appSecret,
      hasAccountNo: !!kiwoomInfo?.accountNo,
      accountNo: kiwoomInfo?.accountNo
    });
    
    if (!kiwoomInfo || !kiwoomInfo.accessToken) {
      console.error('[체결내역 조회 API] 토큰 없음');
      return res.status(400).json({ 
        error: '키움증권 토큰이 설정되지 않았거나 만료되었습니다. 나의 환경설정에서 토큰을 발급해주세요.' 
      });
    }
    if (!kiwoomInfo.appKey || !kiwoomInfo.appSecret) {
      console.error('[체결내역 조회 API] App Key/Secret 없음');
      return res.status(400).json({ error: 'App Key와 App Secret을 먼저 등록해주세요.' });
    }

    // 쿼리 파라미터에서 연속조회 정보 가져오기
    const contYn = req.query.cont_yn || 'N';
    const nextKey = req.query.next_key || '';
    const startDate = req.query.start_date || null;
    const endDate = req.query.end_date || null;
    const orderNo = req.query.order_no || null; // 주문번호 필터링

    console.log('[체결내역 조회 API] TR 호출 파라미터:', {
      accountNo: kiwoomInfo.accountNo,
      startDate,
      endDate,
      orderNo,
      contYn,
      nextKey
    });

    console.log('[체결내역 조회 API] kiwoomAPI.getOrderHistory 호출 시작');
    const executions = await kiwoomAPI.getOrderHistory(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      kiwoomInfo.accountNo,
      startDate,
      endDate,
      contYn,
      nextKey,
      'KRX', // dmstStexTp
      orderNo // 주문번호 필터링
    );
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log('[체결내역 조회 API] TR 호출 완료 (소요시간:', duration, 'ms)');
    console.log('[체결내역 조회 API] 응답 데이터 타입:', typeof executions);
    console.log('[체결내역 조회 API] 응답 데이터 키 목록:', executions ? Object.keys(executions) : 'null');
    
    if (executions) {
      console.log('[체결내역 조회 API] return_code:', executions.return_code);
      console.log('[체결내역 조회 API] return_msg:', executions.return_msg);
      
      if (executions.acnt_ord_cntr_prst_array) {
        console.log('[체결내역 조회 API] acnt_ord_cntr_prst_array 존재');
        console.log('[체결내역 조회 API] acnt_ord_cntr_prst_array 타입:', typeof executions.acnt_ord_cntr_prst_array);
        console.log('[체결내역 조회 API] acnt_ord_cntr_prst_array 배열 여부:', Array.isArray(executions.acnt_ord_cntr_prst_array));
        
        if (Array.isArray(executions.acnt_ord_cntr_prst_array)) {
          console.log('[체결내역 조회 API] 체결내역 개수:', executions.acnt_ord_cntr_prst_array.length);
          
          if (executions.acnt_ord_cntr_prst_array.length > 0) {
            const firstItem = executions.acnt_ord_cntr_prst_array[0];
            console.log('[체결내역 조회 API] 첫 번째 항목 필드명:', Object.keys(firstItem));
            console.log('[체결내역 조회 API] 첫 번째 항목 전체:', JSON.stringify(firstItem, null, 2));
            
            // cntr_qty 필드 확인
            if (firstItem.cntr_qty !== undefined) {
              console.log('[체결내역 조회 API] ✓ cntr_qty 필드 존재, 값:', firstItem.cntr_qty);
            } else {
              console.log('[체결내역 조회 API] ✗ cntr_qty 필드 없음');
            }
            
            // exec_qty 필드 확인
            if (firstItem.exec_qty !== undefined) {
              console.log('[체결내역 조회 API] ✓ exec_qty 필드 존재, 값:', firstItem.exec_qty);
            } else {
              console.log('[체결내역 조회 API] ✗ exec_qty 필드 없음');
            }
          }
        }
      }
    }
    
    // 체결내역 조회 완료 로그 (중복 방지)
    const logKey = `${userId}_executions`;
    const lastLog = logCache.get(logKey);
    const now = Date.now();
    
    if (!lastLog || (now - lastLog.lastLogTime) > LOG_DEDUP_INTERVAL) {
      console.log(`[체결내역 조회 완료] 사용자 ID: ${userId} - 체결내역 조회가 완료되었습니다. (소요시간: ${duration}ms)`);
      logCache.set(logKey, { lastLogTime: now });
    }
    
    console.log('[체결내역 조회 API] 응답 전송 시작');
    res.json(executions);
    console.log('[체결내역 조회 API] 응답 전송 완료');
  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.error('[체결내역 조회 API] 에러 발생 (소요시간:', duration, 'ms)');
    console.error('[체결내역 조회 API] 에러 타입:', error.constructor.name);
    console.error('[체결내역 조회 API] 에러 메시지:', error.message);
    console.error('[체결내역 조회 API] 에러 스택:', error.stack);
    
    if (error.status) {
      console.error('[체결내역 조회 API] 에러 상태:', error.status);
    }
    if (error.data) {
      console.error('[체결내역 조회 API] 에러 데이터:', JSON.stringify(error.data, null, 2));
    }
    
    res.status(error.status || 500).json({
      error: error.message || '체결내역 조회 중 오류가 발생했습니다.',
      data: error.data
    });
  }
});

module.exports = router;


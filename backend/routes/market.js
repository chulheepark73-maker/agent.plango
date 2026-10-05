const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const kiwoomAPI = require('../services/kiwoomApi');
const { getKiwoomInfo, validateKiwoomInfo } = require('../utils/kiwoomUtils');
const { extractStockName } = require('../utils/stockUtils');
const { computeSwingBuyDropRates } = require('../utils/swingLowLevels');
const { computeSwingSellProfitRates } = require('../utils/swingHighLevels');
const { searchStocks } = require('../utils/stockSearchStore');

/**
 * 종목 검색 전용 (KRX + US 마스터)
 * POST /api/market/stocks/search { query }
 * GET  /api/market/stocks/search?q=
 */
router.post('/stocks/search', authenticateToken, async (req, res) => {
  try {
    const query = String(req.body?.query || req.body?.stockName || '').trim();
    if (!query) {
      return res.status(400).json({ error: '검색어를 입력해주세요.' });
    }
    const results = await searchStocks(query);
    res.json({ results, query });
  } catch (error) {
    console.error('[market] stocks/search 실패:', error);
    res.status(500).json({ error: '종목 검색 중 오류가 발생했습니다.' });
  }
});

router.get('/stocks/search', authenticateToken, async (req, res) => {
  try {
    const query = String(req.query?.q || req.query?.query || req.query?.stockName || '').trim();
    if (!query) {
      return res.status(400).json({ error: '검색어를 입력해주세요.' });
    }
    const results = await searchStocks(query);
    res.json({ results, query });
  } catch (error) {
    console.error('[market] stocks/search 실패:', error);
    res.status(500).json({ error: '종목 검색 중 오류가 발생했습니다.' });
  }
});

// 종목 정보 조회 (ka10095)
router.get('/stock-info/:stockCode', authenticateToken, async (req, res) => {
  try {
    const { stockCode } = req.params;
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    const stockInfo = await kiwoomAPI.getStockInfo(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      stockCode
    );
    res.json(stockInfo);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || '종목 정보 조회 중 오류가 발생했습니다.',
      data: error.data
    });
  }
});

// 종목명으로 종목 검색
router.get('/search-stock', authenticateToken, async (req, res) => {
  try {
    const { stockName } = req.query;
    
    if (!stockName || stockName.trim().length < 2) {
      return res.status(400).json({ error: '종목명을 2자 이상 입력해주세요.' });
    }
    
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    // 키움증권 API에 종목명 검색 API가 있다면 사용
    // 없으면 일반적인 종목코드로 시도 (예: 삼성전자 -> 005930)
    // 실제로는 종목명 검색 API가 필요하지만, 일단은 간단한 매핑이나 다른 방법 사용
    
    // TODO: 키움증권 API에 종목명 검색 API가 있는지 확인 필요
    // 현재는 종목명으로 종목코드를 찾는 로직이 필요함
    
    // 임시로 일반적인 종목코드 매핑 사용 (실제로는 API 호출 필요)
    const commonStocks = {
      '삼성전자': '005930',
      'SK하이닉스': '000660',
      'NAVER': '035420',
      '카카오': '035720',
      'LG전자': '066570',
      '현대차': '005380',
      '기아': '000270',
      '셀트리온': '068270',
      'POSCO홀딩스': '005490',
      'KB금융': '105560'
    };
    
    const trimmedName = stockName.trim();
    const stockCode = commonStocks[trimmedName];
    
    // 매핑에 있는 종목은 바로 조회
    if (stockCode) {
      try {
        const stockInfo = await kiwoomAPI.getStockInfo(
          kiwoomInfo.accessToken,
          kiwoomInfo.appKey,
          kiwoomInfo.appSecret,
          stockCode
        );
        
        // 응답에서 종목명 추출 (atn_stk_infr 배열 사용)
        let foundStockName = trimmedName;
        if (stockInfo.atn_stk_infr && Array.isArray(stockInfo.atn_stk_infr) && stockInfo.atn_stk_infr.length > 0) {
          foundStockName = stockInfo.atn_stk_infr[0].stk_nm || trimmedName;
        } else if (stockInfo.output && Array.isArray(stockInfo.output) && stockInfo.output.length > 0) {
          foundStockName = stockInfo.output[0].stk_nm || stockInfo.output[0].itm_nm || stockInfo.output[0].pdno_nm || trimmedName;
        } else if (stockInfo.stk_nm) {
          foundStockName = stockInfo.stk_nm;
        } else if (stockInfo.itm_nm) {
          foundStockName = stockInfo.itm_nm;
        }
        
        return res.json({
          stockCode,
          stockName: foundStockName
        });
      } catch (error) {
        console.error('[종목 검색] 종목 정보 조회 실패:', error);
        return res.status(500).json({ 
          error: `종목명 "${trimmedName}" 조회 중 오류가 발생했습니다.`,
          details: error.message
        });
      }
    }
    
    // 매핑에 없는 종목은 일반적인 종목코드로 시도 (예: 6자리 숫자)
    // 실제로는 종목명 검색 API가 필요하지만, 일단은 사용자에게 종목코드를 입력하도록 안내
    // 또는 보유 종목 목록에서 검색할 수도 있음
    
    // 보유 종목 목록에서 검색 시도 (보유 종목이 있다면)
    try {
      const holdings = await kiwoomAPI.getHoldings(
        kiwoomInfo.accessToken,
        kiwoomInfo.appKey,
        kiwoomInfo.appSecret,
        null, // 계좌번호 없이 전체 조회
        'N',
        ''
      );
      
      // 보유 종목 목록에서 종목명으로 검색
      // holdings 응답 구조에 따라 수정 필요
      if (holdings && holdings.output && Array.isArray(holdings.output)) {
        const found = holdings.output.find(item => {
          const itemName = item.stk_nm || item.itm_nm || item.pdno_nm || '';
          return itemName.includes(trimmedName) || trimmedName.includes(itemName);
        });
        
        if (found) {
          const foundStockCode = found.stk_cd || found.pdno || found.code || '';
          const foundStockName = found.stk_nm || found.itm_nm || found.pdno_nm || trimmedName;
          
          return res.json({
            stockCode: foundStockCode,
            stockName: foundStockName
          });
        }
      }
    } catch (holdingsError) {
      console.log('[종목 검색] 보유 종목 검색 실패 (무시):', holdingsError.message);
    }
    
    // 매핑에 없고 보유 종목에도 없으면 에러
    return res.status(404).json({ 
      error: `종목명 "${trimmedName}"에 대한 종목 정보를 찾을 수 없습니다.`,
      suggestion: '지원되는 종목: ' + Object.keys(commonStocks).join(', ') + ' 또는 종목코드를 직접 입력해주세요.'
    });
  } catch (error) {
    console.error('[종목 검색] 실패:', error);
    res.status(error.status || 500).json({
      error: error.message || '종목 검색 중 오류가 발생했습니다.',
      data: error.data
    });
  }
});

// 거래대금 상위 종목 조회 (실시간)
router.get('/top-trading-value', authenticateToken, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const limitNum = parseInt(limit) || 50;
    
    if (limitNum > 100) {
      return res.status(400).json({ error: '최대 100개까지 조회 가능합니다.' });
    }
    
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    const topStocks = await kiwoomAPI.getTopTradingValueStocks(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      limitNum
    );
    
    // 디버깅: 응답 데이터도 함께 반환 (임시)
    res.json({
      stocks: topStocks,
      debug: process.env.NODE_ENV === 'development' ? {
        count: topStocks.length,
        sample: topStocks.length > 0 ? topStocks[0] : null
      } : undefined
    });
  } catch (error) {
    console.error('[거래대금 상위 종목] 조회 실패:', error);
    res.status(error.status || 500).json({
      error: error.message || '거래대금 상위 종목 조회 중 오류가 발생했습니다.',
      data: error.data
    });
  }
});

/**
 * 일봉 → 주봉/월봉 집계
 * @param {Array<{date,open,high,low,close,volume}>} dailyBars 오름차순
 * @param {'day'|'week'|'month'} interval
 */
const aggregateChartBars = (dailyBars, interval) => {
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) return [];
  if (interval === 'day') return dailyBars;

  const groups = new Map();
  for (const b of dailyBars) {
    const d = String(b.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    let key;
    if (interval === 'month') {
      key = d.slice(0, 7); // YYYY-MM
    } else {
      // week: ISO-ish — Monday as week start
      const [yy, mm, dd] = d.split('-').map(Number);
      const dt = new Date(Date.UTC(yy, mm - 1, dd));
      const day = dt.getUTCDay(); // 0 Sun
      const diffToMon = day === 0 ? -6 : 1 - day;
      dt.setUTCDate(dt.getUTCDate() + diffToMon);
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const da = String(dt.getUTCDate()).padStart(2, '0');
      key = `${y}-${m}-${da}`;
    }
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        date: d, // 기간 마지막 거래일로 갱신
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: Number(b.volume) || 0,
      });
    } else {
      g.high = Math.max(Number(g.high) || 0, Number(b.high) || 0);
      const lowB = Number(b.low);
      const lowG = Number(g.low);
      g.low = lowG > 0 && lowB > 0 ? Math.min(lowG, lowB) : lowG || lowB;
      g.close = b.close;
      g.date = d;
      g.volume = (Number(g.volume) || 0) + (Number(b.volume) || 0);
    }
  }
  return [...groups.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
};

/**
 * 일/주/월봉 차트 OHLC (관심종목 차트용)
 * GET /api/market/daily-chart/:stockCode?days=240&market=KRX|NXT|US&interval=day|week|month&stex_tp=ND
 */
router.get('/daily-chart/:stockCode', authenticateToken, async (req, res) => {
  try {
    const rawCode = String(req.params.stockCode || '').trim();
    if (!rawCode) {
      return res.status(400).json({ error: '종목코드가 필요합니다.' });
    }

    let interval = String(req.query.interval || 'day').toLowerCase();
    if (!['day', 'week', 'month'].includes(interval)) interval = 'day';

    let market = String(req.query.market || 'KRX').toUpperCase();
    if (!['KRX', 'NXT', 'US'].includes(market)) market = 'KRX';

    // 주/월봉은 일봉을 더 많이 받아 집계 (미국은 네이티브 주/월봉 API 사용)
    const defaultDays =
      market === 'US'
        ? interval === 'month'
          ? 120
          : interval === 'week'
            ? 200
            : 240
        : interval === 'month'
          ? 600
          : interval === 'week'
            ? 500
            : 240;
    const days = Math.min(600, Math.max(30, parseInt(req.query.days, 10) || defaultDays));

    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    let stockCodeOut = rawCode;
    let stexTp = null;
    let daily;

    if (market === 'US') {
      const ticker = rawCode.toUpperCase();
      stockCodeOut = ticker;
      const { resolveUsStexTpPreferMaster } = require('../utils/autoTradingMarket');
      stexTp = await resolveUsStexTpPreferMaster(ticker, req.query.stex_tp || null);

      const rawBars = await kiwoomAPI.getRecentUsDailyClosePrices(
        kiwoomInfo.accessToken,
        ticker,
        days,
        stexTp,
        interval
      );
      daily = (rawBars || []).map((b) => ({
        date: b.date,
        open: b.openPrice,
        high: b.highPrice,
        low: b.lowPrice,
        close: b.closePrice,
        volume: b.tradeVolume,
      }));
      // 미국은 일/주/월 네이티브 TR — 추가 집계 없음
      return res.json({
        stockCode: stockCodeOut,
        market,
        stexTp,
        days,
        interval,
        bars: daily,
      });
    }

    const code6 = rawCode.replace(/_NX$/i, '').substring(0, 6);
    if (!code6) {
      return res.status(400).json({ error: '종목코드가 필요합니다.' });
    }
    stockCodeOut = code6;

    const rawBars = await kiwoomAPI.getRecentDailyClosePrices(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      code6,
      days,
      market
    );

    daily = (rawBars || []).map((b) => ({
      date: b.date,
      open: b.openPrice,
      high: b.highPrice,
      low: b.lowPrice,
      close: b.closePrice,
      volume: b.tradeVolume,
    }));

    const bars = aggregateChartBars(daily, interval);

    res.json({
      stockCode: stockCodeOut,
      market,
      days,
      interval,
      bars,
    });
  } catch (error) {
    console.error('[차트] 조회 실패:', error?.message || error);
    res.status(error.status || 500).json({
      error: error.message || '차트 조회 중 오류가 발생했습니다.',
      data: error.data,
    });
  }
});

/**
 * 일봉 스윙 저점/고점 → 매수 dropRate(%) · 매도 profitRate(%)
 * POST /api/market/swing-levels
 * body: { stockCode, market?, days?, currentPrice, buyStages?, stex_tp? }
 */
router.post('/swing-levels', authenticateToken, async (req, res) => {
  try {
    const body = req.body || {};
    const rawCode = String(body.stockCode || '').trim();
    if (!rawCode) {
      return res.status(400).json({ error: '종목코드가 필요합니다.' });
    }

    const currentPrice = Number(body.currentPrice);
    if (!(currentPrice > 0)) {
      return res.status(400).json({ error: '현재가가 필요합니다.' });
    }

    let market = String(body.market || 'KRX').toUpperCase();
    if (!['KRX', 'NXT', 'US'].includes(market)) market = 'KRX';

    const days = Math.min(600, Math.max(30, parseInt(body.days, 10) || 240));
    const buyStages = Array.isArray(body.buyStages) ? body.buyStages : [];

    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    let stockCodeOut = rawCode;
    let stexTp = null;
    let daily;

    if (market === 'US') {
      const ticker = rawCode.toUpperCase();
      stockCodeOut = ticker;
      const { resolveUsStexTpPreferMaster } = require('../utils/autoTradingMarket');
      stexTp = await resolveUsStexTpPreferMaster(ticker, body.stex_tp || null);

      const rawBars = await kiwoomAPI.getRecentUsDailyClosePrices(
        kiwoomInfo.accessToken,
        ticker,
        days,
        stexTp,
        'day'
      );
      daily = (rawBars || []).map((b) => ({
        date: b.date,
        open: b.openPrice,
        high: b.highPrice,
        low: b.lowPrice,
        close: b.closePrice,
        volume: b.tradeVolume,
      }));
    } else {
      const code6 = rawCode.replace(/_NX$/i, '').substring(0, 6);
      if (!code6) {
        return res.status(400).json({ error: '종목코드가 필요합니다.' });
      }
      stockCodeOut = code6;

      const rawBars = await kiwoomAPI.getRecentDailyClosePrices(
        kiwoomInfo.accessToken,
        kiwoomInfo.appKey,
        kiwoomInfo.appSecret,
        code6,
        days,
        market
      );

      daily = (rawBars || []).map((b) => ({
        date: b.date,
        open: b.openPrice,
        high: b.highPrice,
        low: b.lowPrice,
        close: b.closePrice,
        volume: b.tradeVolume,
      }));
    }

    const bars = Array.isArray(daily) ? daily : [];
    if (!bars.length) {
      return res.status(404).json({ error: '일봉 데이터가 없어 스윙 지점을 찾을 수 없습니다.' });
    }

    const buy = computeSwingBuyDropRates({
      bars,
      currentPrice,
      stages: buyStages,
    });

    if (!buy.ok) {
      return res.json({
        stockCode: stockCodeOut,
        market,
        stexTp,
        days,
        buy,
        sell: {
          ok: false,
          profitRates: [],
          targets: [],
          swings: [],
          atr: null,
          message: '매수% 산출 실패로 매도%를 계산하지 않았습니다.',
        },
      });
    }

    const buyPricesForSell = (buy.targets || []).map((t, idx) => {
      const stage = buyStages[idx];
      if (stage?.buyEnd === 'Y' && Number(stage.buyPrice) > 0) {
        return Number(stage.buyPrice);
      }
      return Number(t) || 0;
    });

    const sell = computeSwingSellProfitRates({
      bars,
      buyPrices: buyPricesForSell,
    });

    res.json({
      stockCode: stockCodeOut,
      market,
      stexTp,
      days,
      buy,
      sell,
    });
  } catch (error) {
    console.error('[스윙레벨] 조회 실패:', error?.message || error);
    res.status(error.status || 500).json({
      error: error.message || '스윙 지점 계산 중 오류가 발생했습니다.',
      data: error.data,
    });
  }
});

module.exports = router;


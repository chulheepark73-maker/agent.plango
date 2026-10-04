/**
 * 관심종목 V2 API — /api/watchlist-v2
 * 시세: 장중 WS(lastPrices) / 장외·캐시 없을 때 키움 REST 폴백
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  listWatchlistV2,
  addWatchlistV2Item,
  removeWatchlistV2Item,
} = require('../utils/watchlistV2Store');
const { ensureTradingV2Tables } = require('../utils/tradingV2Store');
const { isNXTStock, writeStockListFile, searchStockByName } = require('../utils/stockListStore');
const { isEtfLikeMrktTp } = require('../utils/krMrktTp');
const { getKiwoomInfo, validateKiwoomInfo, normalizeStockCode, createStockCodeMap } = require('../utils/kiwoomUtils');
const { extractPriceData, isKRXSessionOpen, isNXTTradingHours } = require('../utils/stockUtils');
const { writeUsStockList } = require('../utils/usStockListStore');
const { getUserById } = require('../utils/userStore');
const kiwoomAPI = require('../services/kiwoomApi');

router.use(authenticateToken);

/** 국내 종목명 검색 (stock_list) */
router.post('/search', async (req, res) => {
  try {
    const trimmedName = req.body?.stockName?.trim();
    if (!trimmedName) {
      return res.status(400).json({ error: '종목명은 필수입니다.' });
    }

    const foundStock = await searchStockByName(trimmedName);
    if (!foundStock) {
      const allMatches = await searchStockByName(trimmedName, true);
      const suggestion = allMatches?.length > 0
        ? `유사한 종목: ${allMatches.slice(0, 5).map((s) => s.stockName).join(', ')}`
        : '종목명 업데이트 버튼을 클릭하여 종목 목록을 업데이트해주세요.';
      return res.status(404).json({
        error: `종목명 "${trimmedName}"에 대한 종목 정보를 찾을 수 없습니다.`,
        suggestion,
      });
    }

    res.json(foundStock);
  } catch (error) {
    console.error('[watchlist-v2] 종목 검색 실패:', error);
    res.status(500).json({
      error: '종목 검색 중 오류가 발생했습니다.',
      message: error.message,
    });
  }
});

/** 국내 종목 마스터 갱신 — KRX 전체 → stock_list */
router.post('/update-stock-list', async (req, res) => {
  try {
    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    console.log('[국내주식] 종목 목록 업데이트 시작...');
    const krxStocks = await kiwoomAPI.getAllStocks(
      kiwoomInfo.accessToken,
      kiwoomInfo.appKey,
      kiwoomInfo.appSecret,
      'KRX'
    );
    await writeStockListFile(krxStocks);

    const etfCount = krxStocks.filter((s) => isEtfLikeMrktTp(s.mrktTp)).length;
    console.log(
      `[국내주식] 종목 목록 업데이트 완료: KRX ${krxStocks.length}건 (ETF/ETN ${etfCount}건)`
    );
    res.json({
      message: '종목 목록이 업데이트되었습니다.',
      totalCount: krxStocks.length,
      etfEtnCount: etfCount,
    });
  } catch (error) {
    console.error('[국내주식] 종목 목록 업데이트 실패:', error);
    res.status(500).json({
      error: '종목 목록 업데이트 중 오류가 발생했습니다.',
      message: error.message,
    });
  }
});

/** 미국 종목 마스터 갱신 (admin) — usa10099 → us_stock_list */
router.post('/update-us-stock-list', async (req, res) => {
  try {
    const user = await getUserById(req.user.userId);
    if (!user?.username || String(user.username).toLowerCase() !== 'admin') {
      return res.status(403).json({ error: '관리자만 미국 종목 목록을 업데이트할 수 있습니다.' });
    }

    const kiwoomInfo = await getKiwoomInfo(req.user.userId);
    const validationError = validateKiwoomInfo(kiwoomInfo);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    console.log('[미국주식] 종목 목록 업데이트 시작...');
    const stocks = await kiwoomAPI.getAllUsStocks(kiwoomInfo.accessToken);
    if (!stocks.length) {
      return res.status(502).json({
        error: '키움에서 미국 종목 목록을 가져오지 못했습니다. API 경로/권한을 확인하세요.',
      });
    }

    const saved = await writeUsStockList(stocks);
    console.log(`[미국주식] 종목 목록 업데이트 완료: ${saved.totalCount}건`);
    res.json({
      message: '미국 종목 목록이 업데이트되었습니다.',
      totalCount: saved.totalCount,
    });
  } catch (error) {
    console.error('[미국주식] 종목 목록 업데이트 실패:', error);
    res.status(500).json({
      error: '미국 종목 목록 업데이트 중 오류가 발생했습니다.',
      message: error.message,
    });
  }
});

router.get('/', async (req, res) => {
  try {
    await ensureTradingV2Tables();
    const list = await listWatchlistV2(req.user.userId, {
      groupNo: req.query.groupNo,
    });
    const withNxt = await Promise.all(
      list.map(async (item) => ({
        ...item,
        nxtTradable:
          item.stockMarket !== 'US' &&
          (item.stockMarket === 'NXT' || (await isNXTStock(String(item.stockCode || '')))),
      }))
    );
    res.json(withNxt);
  } catch (error) {
    console.error('[watchlist-v2] 목록 실패:', error);
    res.status(500).json({ error: error.message || '관심종목 V2 목록 조회 실패' });
  }
});

router.post('/', async (req, res) => {
  try {
    const item = await addWatchlistV2Item(req.user.userId, req.body || {});
    res.status(201).json(item);
  } catch (error) {
    const status = error.status || 500;
    console.error('[watchlist-v2] 추가 실패:', error.message);
    res.status(status).json({ error: error.message || '관심종목 V2 추가 실패' });
  }
});

/**
 * 현재가
 * 1) WS lastPrices 캐시
 * 2) 장외(국내 세션 밖)이거나 US 캐시 없음 → 키움 REST 폴백
 */
router.get('/prices', async (req, res) => {
  try {
    const list = await listWatchlistV2(req.user.userId, {
      groupNo: req.query.groupNo,
    });
    if (!list.length) return res.json([]);

    const {
      buildPriceRowsFromLastPrices,
      setLastPrice,
    } = require('../services/watchlistPriceWsHub');

    const nameMap = new Map();
    const marketByCode = new Map();
    for (const item of list) {
      const isUs = item.stockMarket === 'US';
      const key = isUs
        ? String(item.stockCode || '').toUpperCase()
        : String(item.stockCode || '').substring(0, 6);
      if (!key) continue;
      if (item.stockName) nameMap.set(key, item.stockName);
      marketByCode.set(key, item.stockMarket || (isUs ? 'US' : 'KRX'));
      nameMap.set(item.stockCode, item.stockName);
      marketByCode.set(item.stockCode, item.stockMarket);
    }

    const cachedRows = buildPriceRowsFromLastPrices(
      req.user.userId,
      list.map((w) => w.stockCode),
      { stockNameMap: nameMap, marketByCode }
    );
    const byCode = new Map();
    for (const r of cachedRows) {
      const code = String(r.stockCode || '');
      const isUs = r.stockMarket === 'US' || /[A-Za-z]/.test(code.charAt(0));
      byCode.set(isUs ? code.toUpperCase() : code.substring(0, 6), r);
      byCode.set(code, r);
    }

    const krSessionOpen = isKRXSessionOpen() || isNXTTradingHours();

    const needRest = list.filter((item) => {
      const isUs = item.stockMarket === 'US';
      const key = isUs
        ? String(item.stockCode).toUpperCase()
        : String(item.stockCode).substring(0, 6);
      const row = byCode.get(key) || byCode.get(item.stockCode);
      const hasPrice = row && Number(row.price) > 0;
      if (hasPrice) return false;
      // 국내: 장외만 REST / 미국: 캐시 없으면 REST(시드)
      if (isUs) return true;
      return !krSessionOpen;
    });

    if (needRest.length > 0) {
      const kiwoomInfo = await getKiwoomInfo(req.user.userId);
      const validationError = validateKiwoomInfo(kiwoomInfo);

      if (!validationError && kiwoomInfo?.accessToken) {
        const krItems = needRest.filter((i) => i.stockMarket !== 'US');
        const usItems = needRest.filter((i) => i.stockMarket === 'US');

        if (krItems.length > 0) {
          try {
            const stockCodes = krItems.map((i) => i.stockCode).join('|');
            const stockInfo = await kiwoomAPI.getStockInfo(
              kiwoomInfo.accessToken,
              kiwoomInfo.appKey,
              kiwoomInfo.appSecret,
              stockCodes,
              'N',
              '',
              'KRX'
            );
            if (stockInfo?.return_code === 0 && stockInfo?.atn_stk_infr?.length) {
              const infoMap = createStockCodeMap(stockInfo.atn_stk_infr);
              for (const item of krItems) {
                const searchCode = normalizeStockCode(item.stockCode || '');
                const info = infoMap.get(searchCode) || infoMap.get(searchCode.substring(0, 6));
                if (!info) continue;
                const { price, change, changeRate } = extractPriceData({ atn_stk_infr: [info] });
                const row = {
                  stockCode: item.stockCode,
                  stockName: item.stockName,
                  stockMarket: item.stockMarket || 'KRX',
                  price,
                  change,
                  changeRate,
                  source: 'rest',
                };
                byCode.set(String(item.stockCode).substring(0, 6), row);
                byCode.set(item.stockCode, row);
                if (price > 0) setLastPrice(req.user.userId, row);
              }
            }
          } catch (err) {
            console.warn('[watchlist-v2] KR REST 시세 실패:', err.message || err);
          }
        }

        if (usItems.length > 0) {
          try {
            const quotes = await kiwoomAPI.getUsStockQuotes(
              kiwoomInfo.accessToken,
              usItems.map((i) => i.stockCode),
              null
            );
            const quoteByCode = new Map(
              (quotes || []).map((q) => [String(q.stockCode).toUpperCase(), q])
            );
            for (const item of usItems) {
              const stockCode = String(item.stockCode || '').toUpperCase();
              const quote = quoteByCode.get(stockCode);
              if (quote && Number(quote.price) > 0) {
                const row = {
                  stockCode,
                  stockName: item.stockName || quote.stockName || stockCode,
                  stockMarket: 'US',
                  exchange: item.exchange || quote.exchange || null,
                  price: quote.price || 0,
                  change: quote.change || 0,
                  changeRate: quote.changeRate || 0,
                  source: 'rest',
                };
                byCode.set(stockCode, row);
                setLastPrice(req.user.userId, row);
              }
            }
          } catch (err) {
            console.warn('[watchlist-v2] US REST 시세 실패:', err.message || err);
          }
        }
      }
    }

    res.json(
      list.map((item) => {
        const isUs = item.stockMarket === 'US';
        const key = isUs
          ? String(item.stockCode).toUpperCase()
          : String(item.stockCode).substring(0, 6);
        const row = byCode.get(key) || byCode.get(item.stockCode);
        return {
          stockCode: item.stockCode,
          stockName: item.stockName,
          stockMarket: item.stockMarket,
          exchange: item.exchange || null,
          price: row?.price ?? 0,
          change: row?.change ?? 0,
          changeRate: row?.changeRate ?? 0,
          source: row?.source || (row ? 'lastPrices' : 'empty'),
        };
      })
    );
  } catch (error) {
    console.error('[watchlist-v2] prices 실패:', error);
    res.status(500).json({ error: error.message || '시세 조회 실패' });
  }
});

router.delete('/', async (req, res) => {
  try {
    const result = await removeWatchlistV2Item(req.user.userId, {
      symbol: req.query.symbol,
      market: req.query.market,
      instrumentId: req.query.instrumentId,
    });
    res.json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message || '관심종목 V2 삭제 실패' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await removeWatchlistV2Item(req.user.userId, {
      id: req.params.id,
    });
    res.json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message || '관심종목 V2 삭제 실패' });
  }
});

module.exports = router;

const pool = require('./tradingDb');
const { normalizeKrSymbol, ETF_LIKE_MRKT_TPS, isEtfLikeMrktTp } = require('./krMrktTp');

/** stock_list 조회용 — 6자리 정규화 코드로 mrkt_tp 찾기 */
const getKrMrktTp = async (symbol) => {
  try {
    const code = normalizeKrSymbol(symbol);
    if (!code) return null;
    const result = await pool.query(
      `SELECT mrkt_tp FROM stock_list
       WHERE mrkt_tp IS NOT NULL
         AND mrkt_tp <> ''
         AND (
           UPPER(TRIM(stock_code)) = $1
           OR UPPER(SUBSTR(TRIM(stock_code), 1, 6)) = $1
         )
       ORDER BY
         CASE WHEN UPPER(TRIM(stock_code)) = $1 THEN 0 ELSE 1 END,
         CASE WHEN mrkt_tp IN ('8','60','70','90') THEN 0 ELSE 1 END
       LIMIT 1`,
      [code]
    );
    const tp = result.rows[0]?.mrkt_tp;
    return tp != null && String(tp).trim() !== '' ? String(tp).trim() : null;
  } catch (error) {
    console.error('[stockListStore] getKrMrktTp 오류:', error.message);
    return null;
  }
};

const applyMrktTpToInstruments = async () => {
  try {
    const { applyMrktTpFromStockList } = require('./tradingV2Store');
    const n = await applyMrktTpFromStockList();
    if (n > 0) console.log(`[stockListStore] instruments mrkt_tp 반영 ${n}건`);
    return n;
  } catch (error) {
    console.error('[stockListStore] instruments mrkt_tp 반영 실패:', error.message);
    return 0;
  }
};

// 종목 목록 파일 읽기
const readStockListFile = async () => {
  try {
    const result = await pool.query('SELECT stock_code, stock_name FROM stock_list ORDER BY stock_code');
    return result.rows.map(row => ({
      stockCode: row.stock_code,
      stockName: row.stock_name
    }));
  } catch (error) {
    console.error('[stockListStore] readStockListFile 오류:', error);
    return [];
  }
};

/** 저장 전 코드 정규화 + ETF/ETN mrkt_tp 우선 */
const normalizeStockListForWrite = (stockList) => {
  const byCode = new Map();
  for (const stock of stockList || []) {
    const code = normalizeKrSymbol(stock.stockCode);
    if (!code) continue;
    const name = stock.stockName != null ? String(stock.stockName) : '';
    const mrktTp =
      stock.mrktTp != null && String(stock.mrktTp).trim() !== ''
        ? String(stock.mrktTp).trim()
        : null;
    const prev = byCode.get(code);
    if (!prev) {
      byCode.set(code, { stockCode: code, stockName: name, mrktTp });
      continue;
    }
    if (name && !prev.stockName) prev.stockName = name;
    if (isEtfLikeMrktTp(mrktTp) && !isEtfLikeMrktTp(prev.mrktTp)) {
      prev.mrktTp = mrktTp;
      if (name) prev.stockName = name;
    } else if (prev.mrktTp == null && mrktTp != null) {
      prev.mrktTp = mrktTp;
    }
  }
  return Array.from(byCode.values());
};

// 종목 목록 파일 쓰기
const writeStockListFile = async (stockList) => {
  try {
    const normalized = normalizeStockListForWrite(stockList);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (normalized.length > 0) {
        const values = normalized
          .map((_, index) => {
            const baseIndex = index * 3;
            return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3})`;
          })
          .join(', ');

        const params = normalized.flatMap((stock) => [
          stock.stockCode,
          stock.stockName,
          stock.mrktTp,
        ]);
        await client.query(
          `INSERT INTO stock_list (stock_code, stock_name, mrkt_tp) VALUES ${values}
           ON CONFLICT (stock_code) DO UPDATE
           SET stock_name = EXCLUDED.stock_name,
               mrkt_tp = COALESCE(EXCLUDED.mrkt_tp, stock_list.mrkt_tp)`,
          params
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await applyMrktTpToInstruments();
  } catch (error) {
    console.error('[stockListStore] writeStockListFile 오류:', error);
    throw error;
  }
};

// NXT 종목 목록 쓰기 (전체 교체: CSV/목록에 없는 종목은 삭제)
const writeStockListNxtFile = async (stockList) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 항상 전체 교체 (UPSERT만 하면 제거된 종목이 DB에 남음)
      await client.query('DELETE FROM stock_list_nxt');

      if (stockList && stockList.length > 0) {
        // NXT 코드는 항상 *_NX 포맷으로 정규화하고 중복 제거
        const normalizedMap = new Map();
        stockList.forEach(stock => {
          const rawCode = String(stock.stockCode || '').trim();
          const normalizedCode = rawCode.endsWith('_NX') ? rawCode : `${rawCode.substring(0, 6)}_NX`;
          if (!normalizedCode || normalizedCode === '_NX') return;
          normalizedMap.set(normalizedCode, {
            stockCode: normalizedCode,
            stockName: stock.stockName || '',
          });
        });

        const normalizedStocks = Array.from(normalizedMap.values());
        const values = normalizedStocks.map((stock, index) => {
          const baseIndex = index * 2;
          return `($${baseIndex + 1}, $${baseIndex + 2})`;
        }).join(', ');

        const params = normalizedStocks.flatMap(stock => [stock.stockCode, stock.stockName]);
        await client.query(
          `INSERT INTO stock_list_nxt (stock_code, stock_name) VALUES ${values}`,
          params
        );
      }

      await client.query('COMMIT');
      nxtStockCache = null;
      nxtStockCacheTime = null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[stockListStore] writeStockListNxtFile 오류:', error);
    throw error;
  }
};

// 종목명으로 검색 (여러 결과 반환 가능)
const searchStockByName = async (stockName, returnAll = false) => {
  try {
    const searchName = stockName.trim();
    
    if (!searchName) {
      return returnAll ? [] : null;
    }
    
    // 정규화된 검색어
    const normalizedSearch = searchName.replace(/\s/g, '');
    
    // 1. 정확히 일치하는 종목 찾기
    let result = await pool.query(
      `SELECT stock_code, stock_name FROM stock_list 
       WHERE stock_name = $1 OR REPLACE(stock_name, ' ', '') = $2
       LIMIT ${returnAll ? '1000' : '1'}`,
      [searchName, normalizedSearch]
    );
    
    if (result.rows.length > 0) {
      const matches = result.rows.map(row => ({
        stockCode: row.stock_code,
        stockName: row.stock_name
      }));
      return returnAll ? matches : matches[0];
    }
    
    // 2. 시작 부분 일치 검색
    result = await pool.query(
      `SELECT stock_code, stock_name FROM stock_list 
       WHERE stock_name LIKE $1 OR stock_name LIKE $2
       LIMIT ${returnAll ? '100' : '1'}`,
      [`${searchName}%`, `%${searchName}%`]
    );
    
    if (result.rows.length > 0) {
      const matches = result.rows.map(row => ({
        stockCode: row.stock_code,
        stockName: row.stock_name
      }));
      return returnAll ? matches : matches[0];
    }
    
    // 3. 포함 검색
    result = await pool.query(
      `SELECT stock_code, stock_name FROM stock_list 
       WHERE stock_name LIKE $1
       LIMIT ${returnAll ? '100' : '1'}`,
      [`%${searchName}%`]
    );
    
    if (result.rows.length > 0) {
      const matches = result.rows.map(row => ({
        stockCode: row.stock_code,
        stockName: row.stock_name
      }));
      return returnAll ? matches : matches[0];
    }
    
    return returnAll ? [] : null;
  } catch (error) {
    console.error('[stockListStore] searchStockByName 오류:', error);
    return returnAll ? [] : null;
  }
};

// NXT 종목 목록 캐시
let nxtStockCache = null;
let nxtStockCacheTime = null;
const NXT_CACHE_TTL = 60 * 60 * 1000; // 1시간 캐시

// NXT 종목 목록 캐시 초기화/갱신
const getNXTStockCache = async () => {
  const now = Date.now();
  if (nxtStockCache === null || !nxtStockCacheTime || (now - nxtStockCacheTime) > NXT_CACHE_TTL) {
    try {
      const result = await pool.query('SELECT stock_code FROM stock_list_nxt');
      nxtStockCache = result.rows.map(row => ({
        stockCode: row.stock_code
      }));
      // 빈 목록은 캐시하지 않음 (나중에 import 하면 바로 반영)
      nxtStockCacheTime = nxtStockCache.length > 0 ? now : null;
    } catch (error) {
      console.error('[stockListStore] getNXTStockCache 오류:', error);
      nxtStockCache = [];
    }
  }
  return nxtStockCache;
};

// 종목코드 앞 6자리로 NXT 여부 확인
const isNXTStock = async (stockCode) => {
  try {
    const stockListNxt = await getNXTStockCache();
    const codePrefix = stockCode.substring(0, 6);
    
    const found = stockListNxt.some(stock => {
      if (!stock?.stockCode) return false;
      const nxtCodePrefix = stock.stockCode.substring(0, 6);
      return nxtCodePrefix === codePrefix;
    });
    
    return found;
  } catch (error) {
    console.error('[stockListStore] NXT 종목 확인 실패:', error);
    return false;
  }
};

/** ka10099 ETF/ETN 목록 → stock_list.mrkt_tp / instruments.mrkt_tp */
let etfSyncPromise = null;
let etfSyncAt = 0;
const ETF_SYNC_TTL_MS = 6 * 60 * 60 * 1000;

const fetchMarketStocksByTypes = async (kiwoomInfo, types) => {
  const kiwoomAPI = require('../services/kiwoomApi');
  const byCode = new Map();
  for (const tp of types) {
    let contYn = 'N';
    let nextKey = '';
    for (let loop = 0; loop < 100; loop += 1) {
      const result = await kiwoomAPI.getMarketStockList(
        kiwoomInfo.accessToken,
        kiwoomInfo.appKey,
        kiwoomInfo.appSecret,
        tp,
        contYn,
        nextKey
      );
      for (const stock of result.stocks || []) {
        const code = normalizeKrSymbol(stock.stockCode);
        if (!code) continue;
        byCode.set(code, {
          stockCode: code,
          stockName: stock.stockName,
          mrktTp: String(tp),
        });
      }
      nextKey = result.nextKey;
      contYn = result.contYn;
      if (contYn !== 'Y' || !nextKey) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return Array.from(byCode.values());
};

const syncEtfMrktTpFromKiwoom = async (userId) => {
  if (etfSyncAt > 0 && Date.now() - etfSyncAt < ETF_SYNC_TTL_MS) return etfSyncAt;
  if (etfSyncPromise) return etfSyncPromise;

  etfSyncPromise = (async () => {
    const { getKiwoomInfo, validateKiwoomInfo } = require('./kiwoomUtils');
    const kiwoomInfo = await getKiwoomInfo(String(userId));
    if (validateKiwoomInfo(kiwoomInfo)) {
      console.warn('[stockListStore] ETF mrkt_tp 동기화 스킵: 키움 토큰 없음');
      return 0;
    }
    const types = Array.from(ETF_LIKE_MRKT_TPS);
    console.log(`[stockListStore] ka10099 ETF/ETN 목록 조회 (${types.join(',')})`);
    const stocks = await fetchMarketStocksByTypes(kiwoomInfo, types);
    if (!stocks.length) {
      console.warn('[stockListStore] ETF/ETN 목록 비어 있음');
      etfSyncAt = Date.now();
      return 0;
    }
    await writeStockListFile(stocks);
    etfSyncAt = Date.now();
    console.log(`[stockListStore] ETF/ETN mrkt_tp 동기화 ${stocks.length}건`);
    return stocks.length;
  })()
    .catch((err) => {
      console.error('[stockListStore] ETF mrkt_tp 동기화 실패:', err.message);
      return 0;
    })
    .finally(() => {
      etfSyncPromise = null;
    });

  return etfSyncPromise;
};

const resolveKrMrktTp = async (userId, symbol) => {
  // stock_list 우선 (KRX 종목명 업데이트로 채워진 값)
  const tp = await getKrMrktTp(symbol);
  if (tp) return tp;
  // 목록에 없을 때만 ETF/ETN 보완 동기화 (일반주 0/10은 종목명 업데이트로 채움)
  if (!userId) return null;
  await syncEtfMrktTpFromKiwoom(userId);
  return getKrMrktTp(symbol);
};

module.exports = {
  readStockListFile,
  writeStockListFile,
  writeStockListNxtFile,
  searchStockByName,
  isNXTStock,
  getKrMrktTp,
  resolveKrMrktTp,
  syncEtfMrktTpFromKiwoom,
};

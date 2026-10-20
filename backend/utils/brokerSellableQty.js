/**
 * 매도 직전 키움 실제 매도가능수량 조회
 * - 국내: kt00018 trde_able_qty (없으면 rmnd_qty)
 * - 미국: ust21070 원장잔고 (주문가능 → 보유 수량 순)
 *
 * qty=null 은 "알 수 없음" (조회 실패·필드 없음·일부 페이지만 받음) — 호출 측은 DB 잔량 기준으로만 진행한다.
 * 종목이 잔고 목록에 없으면(전체 페이지를 받았을 때) qty=0.
 */
const kiwoomAPI = require('../services/kiwoomApi');

const KR_QTY_KEYS = ['trde_able_qty', 'rmnd_qty'];
const US_QTY_KEYS = ['ord_psbl_qty', 'sell_psbl_qty', 'trde_able_qty', 'poss_qty', 'rmnd_qty', 'hldg_qty', 'qty'];
const US_CODE_KEYS = ['stk_cd', 'pdno', 'symbol', 'ticker'];

const pickQty = (row, keys) => {
  for (const k of keys) {
    const raw = row?.[k];
    if (raw == null || String(raw).trim() === '') continue;
    const n = Math.abs(parseFloat(String(raw).replace(/,/g, '')));
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return null;
};

const normKrCode = (c) => String(c || '').trim().toUpperCase().replace(/^A/, '').slice(0, 6);

/**
 * @param {{ accessToken: string }} kiwoomInfo
 * @param {string} code 국내 6자리 / 미국 티커
 * @param {string} stockMarket 'KRX' | 'NXT' | 'US'
 * @returns {Promise<{ qty: number|null, reason?: string }>}
 */
const getBrokerSellableQty = async (kiwoomInfo, code, stockMarket) => {
  try {
    if (stockMarket === 'US') {
      const ticker = String(code || '').trim().toUpperCase();
      const res = await kiwoomAPI.getUsLedgerBalance(kiwoomInfo.accessToken, { stexTp: '', stkCd: ticker });
      const rows = Array.isArray(res?.holdings) ? res.holdings : [];
      const row = rows.find((r) =>
        US_CODE_KEYS.some((k) => String(r?.[k] || '').trim().toUpperCase() === ticker)
      );
      if (!row) return { qty: 0, reason: '잔고에 종목 없음' };
      const qty = pickQty(row, US_QTY_KEYS);
      return qty == null ? { qty: null, reason: '수량 필드 없음' } : { qty };
    }

    const { rows, complete } = await kiwoomAPI.getAccountEvaluationRowsAllPages(kiwoomInfo.accessToken);
    const want = normKrCode(code);
    const row = rows.find((r) => normKrCode(r?.stk_cd) === want);
    if (!row) return complete ? { qty: 0, reason: '잔고에 종목 없음' } : { qty: null, reason: '잔고 일부 페이지만 조회' };
    const qty = pickQty(row, KR_QTY_KEYS);
    return qty == null ? { qty: null, reason: '수량 필드 없음' } : { qty };
  } catch (err) {
    return { qty: null, reason: `잔고 조회 실패: ${err?.message || err}` };
  }
};

module.exports = { getBrokerSellableQty };

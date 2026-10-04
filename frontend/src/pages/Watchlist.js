import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import {
  Container,
  Paper,
  Typography,
  Box,
  TextField,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Alert,
  CircularProgress,
  Grid,
  InputAdornment,
  Checkbox,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControlLabel,
  FormControl,
  Select,
  MenuItem,
  Chip,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import SearchIcon from '@mui/icons-material/Search';
import DeleteIcon from '@mui/icons-material/Delete';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import SettingsIcon from '@mui/icons-material/Settings';
import CandlestickChartIcon from '@mui/icons-material/CandlestickChart';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import AllInclusiveIcon from '@mui/icons-material/AllInclusive';
import apiClient from '../utils/axios';
import StockDailyChartDialog from '../components/StockDailyChartDialog';
import NxtBadge from '../components/NxtBadge';
import { formatNumber, formatUsMoney } from '../utils/formatUtils';
import { adjustPriceToTickSize } from '../utils/priceUtils';
import { useAuth } from '../contexts/AuthContext';
import { isTradingHours, isNXTTradingHours } from '../utils/tradingHours';
import { connectWatchlistPricesWs } from '../utils/watchlistPricesWs';
import { looksLikeUsTicker, isUsMarket } from '../utils/marketUtils';

// 소수 % 입력: 콤마 소수·복수 점 제거, "0." 유지, 음수 기호는 허용하지 않음(null → onChange에서 무시)
const sanitizeDecimalPercentInput = (input) => {
  let s = String(input ?? '');
  const t = s.trim();
  if (/[-−﹣]/.test(t)) return null;
  if (!t.includes('.') && /^\d+,\d*$/.test(t)) {
    s = t.replace(',', '.');
  } else {
    s = t.replace(/,/g, '');
  }
  let out = '';
  let dotSeen = false;
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === '.' && !dotSeen) {
      out += '.';
      dotSeen = true;
    }
  }
  return out;
};

const parsePercentFieldForSave = (value, fallback) => {
  const s = String(value ?? '').trim().replace(',', '.');
  if (s === '' || s === '.') return fallback;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

/** 차수별 % 필드(하락률·수익률) 숫자 해석 — 문자열/숫자 혼용, 음수는 0 */
const parseRateValue = (v) => {
  const n = parseFloat(String(v ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
};

/** 무한매수 기본 단계별 배수 (평단 대비 구간, 라면형) */
const DEFAULT_INFINITE_BUY_MULTIPLIERS = ['0', '0.5', '1', '1.5', '2', '2.5'];

/** V2 자동매매 활성화 해제 시 해당 전략 패널 비활성 표시 */
const V2_DISABLED_PANEL_SX = { opacity: 0.4, pointerEvents: 'none', userSelect: 'none' };

/** 단계별 배수 Select 옵션 */
const INFINITE_BUY_MULTIPLIER_OPTIONS = ['0', '0.5', '1', '1.5', '2', '2.5', '3'];

/** 무한매수 입력 — 알약형 필드 */
const INFINITE_PILL_INPUT_SX = {
  '& .MuiOutlinedInput-root': {
    height: 32,
    borderRadius: '20px',
    bgcolor: '#081120',
    '& fieldset': { borderColor: '#1e2d45' },
    '&:hover fieldset': { borderColor: '#8b949e' },
    '&.Mui-focused fieldset': { borderColor: '#58a6ff' },
  },
  '& input': {
    fontSize: '0.8rem',
    textAlign: 'right',
    py: 0.5,
    fontWeight: 600,
    pr: 0.25,
  },
};

const INFINITE_PILL_SELECT_SX = {
  height: 32,
  borderRadius: '20px',
  fontSize: '0.8rem',
  bgcolor: '#081120',
  '& .MuiOutlinedInput-notchedOutline': { borderColor: '#1e2d45' },
  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#8b949e' },
  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: '#58a6ff' },
  '& .MuiSelect-select': {
    textAlign: 'right',
    pr: 3,
    py: 0.5,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    fontWeight: 600,
  },
};

const INFINITE_BAND_LABEL_RED = '#ff9ea0';
const INFINITE_BAND_LABEL_BLUE = '#9ecbff';

const infiniteBandLabelColor = (index) => {
  if (index <= 1) return INFINITE_BAND_LABEL_RED;
  if (index >= 2) return INFINITE_BAND_LABEL_BLUE;
  return 'text.secondary';
};

const InfiniteBandRow = ({ label, value, onChange, labelColor = 'text.secondary' }) => (
  <Box
    display="flex"
    alignItems="center"
    justifyContent="space-between"
    gap={1}
    sx={{ py: 0.7, minHeight: 44 }}
  >
    <Typography
      variant="body2"
      sx={{ fontSize: '0.8rem', color: labelColor, whiteSpace: 'nowrap', minWidth: 0 }}
    >
      {label}
    </Typography>
    <FormControl size="small" sx={{ width: 88, flexShrink: 0 }}>
      <Select
        value={
          INFINITE_BUY_MULTIPLIER_OPTIONS.includes(String(value))
            ? String(value)
            : String(value ?? '1')
        }
        onChange={onChange}
        sx={INFINITE_PILL_SELECT_SX}
        renderValue={(selected) => `${selected}배`}
      >
        {INFINITE_BUY_MULTIPLIER_OPTIONS.map((opt) => (
          <MenuItem
            key={opt}
            value={opt}
            dense
            sx={{ justifyContent: 'flex-end', fontSize: '0.8rem', minHeight: 32 }}
          >
            {opt}배
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  </Box>
);

/** buyStepPercent 기준 구간 라벨 */
const infiniteBuyBandLabel = (index, stepPercent, bandCount) => {
  const s = Number(String(stepPercent ?? '').replace(',', '.')) || 2;
  const n = bandCount || DEFAULT_INFINITE_BUY_MULTIPLIERS.length;
  if (index === 0) return `+${s}%↑`;
  if (index === 1) return `~+${s}%`;
  if (index === 2) return `-${s}%~평단`;
  if (index === n - 1) return `-${(n - 3) * s}%↓`;
  const upper = (index - 1) * s;
  const lower = (index - 2) * s;
  return `-${upper}%~-${lower}%`;
};

/** US 주문금액: 소수 2자리 / KR: 정수 */
const parseOrderAmountValue = (raw, isUs) => {
  const s = String(raw ?? '')
    .replace(/,/g, '')
    .trim();
  if (!s) return 0;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (isUs) return Math.round(n * 100) / 100;
  return Math.floor(n);
};

/** 주문금액 입력 sanitize — US는 소수 2자리까지 */
const sanitizeOrderAmountInput = (raw, isUs) => {
  const cleaned = String(raw || '').replace(/,/g, '');
  if (!isUs) return cleaned.replace(/[^0-9]/g, '');
  let s = cleaned.replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) {
    s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
    const [whole, frac = ''] = s.split('.');
    s = `${whole}.${frac.slice(0, 2)}`;
  }
  return s;
};

/** 주문금액 표시 */
const formatOrderAmountDisplay = (value, isUs) => {
  if (value == null || value === '') return '';
  const n =
    typeof value === 'string'
      ? parseFloat(String(value).replace(/,/g, ''))
      : Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (isUs) {
    return n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return formatNumber(Math.floor(n));
};

/** 현재가격 열 폭 — 종목 열 쪽으로 여유 (시세·등락 한 줄 맞춤) */
const WATCHLIST_PRICE_COL_SX = {
  width: 168,
  minWidth: 156,
  maxWidth: 188,
  boxSizing: 'border-box',
  verticalAlign: 'middle',
  px: 1.25,
};

/** V2 Stage 열 — 현재가격·매수목표가 사이 균등 간격 */
const WATCHLIST_STAGE_COL_SX = {
  width: 72,
  minWidth: 72,
  maxWidth: 72,
  boxSizing: 'border-box',
  verticalAlign: 'middle',
  px: 1.25,
  whiteSpace: 'nowrap',
};

/** 매수목표가 열 — 현재가격과 비슷한 폭 */
const WATCHLIST_TARGET_COL_SX = {
  width: 120,
  minWidth: 112,
  maxWidth: 136,
  boxSizing: 'border-box',
  verticalAlign: 'middle',
  px: 1.25,
  whiteSpace: 'nowrap',
};

/** 매수수량 / 차트 / 자동매매 — 동일 폭으로 간격 균일 */
const WATCHLIST_MID_COL_SX = {
  width: 100,
  minWidth: 100,
  maxWidth: 100,
  boxSizing: 'border-box',
  verticalAlign: 'middle',
  px: 1,
  whiteSpace: 'nowrap',
};

/** V2 전략유형 열 */
const WATCHLIST_STRATEGY_COL_SX = {
  width: 104,
  minWidth: 96,
  maxWidth: 120,
  boxSizing: 'border-box',
  verticalAlign: 'middle',
  px: 0.75,
};

const STRATEGY_TYPE_LABELS = {
  SPLIT_TRADE: '분할',
  INFINITE_TRADE: '무한',
};

const formatStrategyTypeLabel = (strategyType) => {
  if (!strategyType) return null;
  if (Array.isArray(strategyType)) {
    const labels = strategyType
      .map((t) => STRATEGY_TYPE_LABELS[t] || t)
      .filter(Boolean);
    return labels.length ? labels.join(' / ') : null;
  }
  return STRATEGY_TYPE_LABELS[strategyType] || strategyType;
};

/** V2 종목코드 ↔ plan.instrument.symbol 매칭 */
const matchTradingPlanSymbol = (plan, stockCode) => {
  const sym = String(plan?.instrument?.symbol || '').trim();
  const code = String(stockCode || '').trim();
  if (!sym || !code) return false;
  if (sym === code || sym.toUpperCase() === code.toUpperCase()) return true;
  if (/^\d+$/.test(sym) && /^\d+$/.test(code)) {
    return sym.substring(0, 6) === code.substring(0, 6);
  }
  return false;
};

/** watchlist 종목 → trading_plans market/exchange
 *  instruments.market 은 KR | US (KRX 아님)
 */
const resolveV2MarketExchange = (stock) => {
  const sm = String(stock?.stockMarket || '').toUpperCase();
  const code = String(stock?.stockCode || '');
  if (isUsMarket(sm, code)) {
    const ex = stock?.exchange || stock?.stexTp || null;
    return { market: 'US', exchange: ex || 'NASDAQ', currency: 'USD' };
  }
  if (sm === 'NXT') {
    return { market: 'KR', exchange: 'NXT', currency: 'KRW' };
  }
  return { market: 'KR', exchange: 'KRX', currency: 'KRW' };
};

const trailingToFormString = (n, fallback = '0.3') => {
  if (n === null || n === undefined || n === '') return fallback;
  const v = typeof n === 'number' ? n : parseFloat(String(n).replace(',', '.'));
  if (!Number.isFinite(v) || v < 0) return fallback;
  return String(v);
};

/** 작업 열 */
const WATCHLIST_ICON_COL_SX = {
  width: 72,
  minWidth: 72,
  maxWidth: 72,
  boxSizing: 'border-box',
  verticalAlign: 'middle',
  px: 0.5,
  whiteSpace: 'nowrap',
};

// 관심종목 행 컴포넌트 (메모이제이션으로 최적화)
const formatPriceWithCurrency = (value, currencySymbol = '원') => {
  if (currencySymbol === '$') {
    const formatted = formatUsMoney(value);
    return formatted === '-' ? '-' : `$${formatted}`;
  }
  const formatted = formatNumber(value);
  return `${formatted}원`;
};

/** 등락 색: 상승 빨강, 하락 파랑, 보합 흰색 */
const getRiseFallColor = (change, changeRate) => {
  const delta = Number(change);
  const rate = Number(changeRate);
  const signed = Number.isFinite(delta) && delta !== 0
    ? delta
    : (Number.isFinite(rate) ? rate : 0);
  if (signed > 0) return 'error.main';
  if (signed < 0) return 'primary.main';
  return 'text.primary';
};

const WatchlistRow = memo(({
  item,
  priceInfo,
  targetBuy,
  priceLoading,
  selectedStockCode,
  blinking,
  onSelectStock,
  onDeleteStock,
  onOpenRepeatAutoTrading,
  onOpenChart,
  hideNxtBadge = false,
  currencySymbol = '원',
  strategyTypeLabel = null,
}) => {
  const isLoading = priceLoading && !priceInfo;
  const price = priceInfo?.price || 0;
  const change = Number(priceInfo?.change);
  const changeRate = Number(priceInfo?.changeRate);
  const changeNum = Number.isFinite(change) ? change : 0;
  const changeRateNum = Number.isFinite(changeRate) ? changeRate : 0;
  const riseFallColor = getRiseFallColor(changeNum, changeRateNum);
  // auto_trading의 auto 필드만 사용 (auto_trading.json의 "auto" 필드가 'Y'인 경우에만)
  const autoBuy = targetBuy?.auto === 'Y';
  // 자동매매가 해제된 경우 (targetBuy가 존재하지만 auto가 'N'인 경우)
  const autoBuyDisabled = targetBuy && targetBuy.auto === 'N';
  // 전략유형(플랜)이 있으면 관심종목 체크 불가
  const checkboxDisabled = !!strategyTypeLabel;
  const isSelected = selectedStockCode === item.stockCode;

  const handleCheckboxChange = useCallback((e) => {
    if (e.target.checked) {
      onSelectStock(item.stockCode);
    } else {
      onSelectStock(null);
    }
  }, [item.stockCode, onSelectStock]);

  const handleDelete = useCallback(() => {
    onDeleteStock(item.stockCode);
  }, [item.stockCode, onDeleteStock]);

  const isNXT =
    !hideNxtBadge &&
    (item.nxtTradable === true || item.stockMarket === 'NXT' || priceInfo?.stockMarket === 'NXT');

  return (
    <TableRow hover sx={{ '& .MuiTableCell-root': { py: 0.4 } }}>
      <TableCell padding="checkbox">
        <Checkbox
          checked={isSelected}
          disabled={checkboxDisabled}
          onChange={handleCheckboxChange}
        />
      </TableCell>
      <TableCell align="center" sx={WATCHLIST_STRATEGY_COL_SX}>
        {strategyTypeLabel ? (
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
              fontSize: '0.875rem',
              lineHeight: 1.3,
              display: 'block',
              color: 'text.primary',
            }}
          >
            {strategyTypeLabel}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.875rem' }}>
            -
          </Typography>
        )}
      </TableCell>
      {/* 종목명 및 코드 (세로로 표시) */}
      <TableCell>
        <Box>
          <Box display="flex" alignItems="center" gap={0.5} mb={0.5}>
            {isNXT && <NxtBadge size={16} sx={{ color: 'text.primary' }} />}
            <Typography variant="body2">
              {item.stockName || item.stockCode}
            </Typography>
          </Box>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {item.stockCode}
          </Typography>
        </Box>
      </TableCell>
      {/* 시세: 왼쪽 현재가 · 오른쪽 등락액, 등락률은 다음 줄 우측 */}
      <TableCell align="center" sx={WATCHLIST_PRICE_COL_SX}>
        {isLoading ? (
          <CircularProgress size={20} />
        ) : (
          <Box sx={{ width: '100%', minWidth: 0 }}>
            <Box
              display="flex"
              alignItems="center"
              justifyContent="space-between"
              gap={0.5}
              sx={{ width: '100%' }}
            >
              <Typography
                variant="body2"
                sx={{
                  fontVariantNumeric: 'tabular-nums',
                  minWidth: 0,
                  pr: 0.25,
                  color: riseFallColor,
                }}
              >
                {currencySymbol === '$' ? formatUsMoney(price) : formatNumber(price)}
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  color: riseFallColor,
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                  flexShrink: 0,
                }}
              >
                {changeNum > 0 ? '▲ ' : changeNum < 0 ? '▼ ' : ''}
                {currencySymbol === '$'
                  ? formatUsMoney(Math.abs(changeNum))
                  : formatNumber(Math.abs(changeNum))}
              </Typography>
            </Box>
            <Typography
              variant="body2"
              sx={{
                color: riseFallColor,
                textAlign: 'right',
                width: '100%',
                mt: 0.25,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {changeRateNum > 0 ? '+' : changeRateNum < 0 ? '-' : ''}
              {Math.abs(changeRateNum).toFixed(2)}%
            </Typography>
          </Box>
        )}
      </TableCell>
      <TableCell align="center" sx={WATCHLIST_STAGE_COL_SX}>
        {targetBuy?.infinite ? (
          <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.4 }} aria-label="무한매매">
            진행중
          </Typography>
        ) : targetBuy?.stage != null && Number(targetBuy.stage) > 0 ? (
          <Typography
            variant="body2"
            sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.4 }}
          >
            {targetBuy.stage}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.4 }}>
            -
          </Typography>
        )}
      </TableCell>
      <TableCell align="center" sx={WATCHLIST_TARGET_COL_SX}>
        {targetBuy?.target_price ? (
          <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.4 }}>
            {formatPriceWithCurrency(targetBuy.target_price, currencySymbol)}
            {targetBuy.infinite && (
              <Box component="span" sx={{ fontSize: '0.75rem', color: 'text.secondary', ml: 0.25 }}>
                (진입)
              </Box>
            )}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.4 }}>
            -
          </Typography>
        )}
      </TableCell>
      <TableCell align="center" sx={WATCHLIST_MID_COL_SX}>
        {targetBuy?.target_qty ? (
          <Typography variant="body2">
            {formatNumber(targetBuy.target_qty)}주
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            -
          </Typography>
        )}
      </TableCell>
      <TableCell align="center" sx={WATCHLIST_MID_COL_SX}>
        <IconButton
          size="small"
          onClick={() => onOpenChart?.(item)}
          title="일봉 차트"
          sx={{ '&:hover': { backgroundColor: 'action.hover' } }}
        >
          <CandlestickChartIcon sx={{ fontSize: '1.25rem', color: 'primary.main' }} />
        </IconButton>
      </TableCell>
      <TableCell align="center" sx={WATCHLIST_MID_COL_SX}>
        {autoBuy ? (
          <IconButton
            onClick={() => {
              if (onOpenRepeatAutoTrading) {
                onOpenRepeatAutoTrading(item);
              }
            }}
            size="small"
            sx={{
              '&:hover': {
                backgroundColor: 'action.hover',
              },
            }}
          >
            <PlayArrowIcon
              sx={{
                fontSize: '1.2rem',
                color: 'success.main',
                cursor: 'pointer',
              }}
            />
          </IconButton>
        ) : autoBuyDisabled ? (
          <IconButton
            onClick={() => {
              if (onOpenRepeatAutoTrading) {
                onOpenRepeatAutoTrading(item);
              }
            }}
            size="small"
            sx={{
              '&:hover': {
                backgroundColor: 'action.hover',
              },
            }}
          >
            <PauseIcon
              sx={{
                fontSize: '1.2rem',
                color: 'text.secondary',
                cursor: 'pointer',
              }}
            />
          </IconButton>
        ) : (
          <Typography variant="body2" color="text.secondary">
            -
          </Typography>
        )}
      </TableCell>
      <TableCell align="center" sx={WATCHLIST_ICON_COL_SX}>
        <IconButton
          color="error"
          onClick={handleDelete}
          size="small"
        >
          <DeleteIcon />
        </IconButton>
      </TableCell>
    </TableRow>
  );
}, (prevProps, nextProps) => {
  // 커스텀 비교 함수: 필요한 props만 비교하여 불필요한 리렌더링 방지
  return (
    prevProps.item.stockCode === nextProps.item.stockCode &&
    prevProps.item.stockName === nextProps.item.stockName &&
    prevProps.item.nxtTradable === nextProps.item.nxtTradable &&
    prevProps.item.stockMarket === nextProps.item.stockMarket &&
    prevProps.priceInfo?.stockMarket === nextProps.priceInfo?.stockMarket &&
    prevProps.priceInfo?.price === nextProps.priceInfo?.price &&
    prevProps.priceInfo?.change === nextProps.priceInfo?.change &&
    prevProps.priceInfo?.changeRate === nextProps.priceInfo?.changeRate &&
    prevProps.targetBuy?.target_price === nextProps.targetBuy?.target_price &&
    prevProps.targetBuy?.target_qty === nextProps.targetBuy?.target_qty &&
    prevProps.targetBuy?.auto === nextProps.targetBuy?.auto &&
    prevProps.targetBuy?.auto_buy === nextProps.targetBuy?.auto_buy &&
    prevProps.priceLoading === nextProps.priceLoading &&
    prevProps.selectedStockCode === nextProps.selectedStockCode &&
    prevProps.blinking === nextProps.blinking &&
    prevProps.hideNxtBadge === nextProps.hideNxtBadge &&
    prevProps.currencySymbol === nextProps.currencySymbol &&
    prevProps.strategyTypeLabel === nextProps.strategyTypeLabel &&
    prevProps.targetBuy?.stage === nextProps.targetBuy?.stage &&
    prevProps.targetBuy?.infinite === nextProps.targetBuy?.infinite &&
    prevProps.targetBuy?.alsoInfinite === nextProps.targetBuy?.alsoInfinite &&
    prevProps.onOpenChart === nextProps.onOpenChart
  );
});

WatchlistRow.displayName = 'WatchlistRow';

const Watchlist = ({ noContainer = false, hideActions = false }) => {
  const defaultBuyTotal = 1000000;
  const apiBase = '/watchlist-v2';
  const currencySymbol = '원';
  const { user } = useAuth();
  const [watchlist, setWatchlist] = useState([]);
  const [prices, setPrices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [priceLoading, setPriceLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [searchName, setSearchName] = useState('');
  const [searchingStock, setSearchingStock] = useState(false);
  const [foundStockCode, setFoundStockCode] = useState('');
  const [foundStockName, setFoundStockName] = useState('');
  /** dual 검색 결과 시장 (KRX | US) — 추가·통화 판별용 */
  const [foundStockMarket, setFoundStockMarket] = useState('');
  /** dual: 양시장 검색 후보 (2건 이상일 때 선택 UI) */
  const [searchCandidates, setSearchCandidates] = useState([]);
  const [selectedStockCode, setSelectedStockCode] = useState(null);
  const [chartDialogOpen, setChartDialogOpen] = useState(false);
  const [chartDialogStock, setChartDialogStock] = useState(null);
  const [autoTradingList, setAutoTradingList] = useState([]);
  const [tradingPlans, setTradingPlans] = useState([]);
  const pricesRequestInFlightRef = useRef(false);
  const pricesWsRef = useRef(null);
  const [pricesWsReady, setPricesWsReady] = useState(false);
  /** 폴링으로 `prices`가 바뀔 때마다 불러오기 effect가 돌면 폼이 덮어써지므로, 최신가만 ref로 참조 */
  const pricesRef = useRef(prices);
  pricesRef.current = prices;
  const [isInTradingHours, setIsInTradingHours] = useState(isTradingHours());
  const [isInNXTTradingHours, setIsInNXTTradingHours] = useState(isNXTTradingHours());
  const [targetBuyDialogStock, setTargetBuyDialogStock] = useState(null);
  const [blinking, setBlinking] = useState(false);
  const [repeatAutoTradingDialogOpen, setRepeatAutoTradingDialogOpen] = useState(false);
  const [autoTradingLoadMessage, setAutoTradingLoadMessage] = useState('');
  const [swingResultMessage, setSwingResultMessage] = useState('');
  const [swingFindLoading, setSwingFindLoading] = useState(false);
  const [confirmSaveDialogOpen, setConfirmSaveDialogOpen] = useState(false);
  const [preparedAutoTradingData, setPreparedAutoTradingData] = useState(null);
  /** 관심종목 그룹 탭 1~8 */
  const watchlistGroupCount = 8;
  const watchlistGroupNos = useMemo(
    () => Array.from({ length: watchlistGroupCount }, (_, i) => i + 1),
    [watchlistGroupCount]
  );
  const [watchlistTab, setWatchlistTab] = useState(1);
  const [watchListNames, setWatchListNames] = useState(() => {
    const initial = {};
    for (let n = 1; n <= 8; n += 1) initial[n] = `관심종목${n}`;
    return initial;
  });

  /** 종목별 미국 여부 */
  const isUsMarketItem = useCallback((itemOrCode) => {
    if (itemOrCode && typeof itemOrCode === 'object') {
      return isUsMarket(itemOrCode.stockMarket || itemOrCode.market, itemOrCode.stockCode);
    }
    const code = String(itemOrCode || '');
    const found = watchlist.find(
      (w) =>
        String(w.stockCode) === code ||
        String(w.stockCode).toUpperCase() === code.toUpperCase()
    );
    if (found) return isUsMarket(found.stockMarket || found.market, found.stockCode);
    return looksLikeUsTicker(code);
  }, [watchlist]);

  // 반복자동매매설정 데이터 불러오기
  const loadAutoTradingData = useCallback(async (stockCode) => {
    if (!stockCode || !user?.id) return null;

    try {
      await apiClient.post('/trading-v2/bootstrap').catch(() => null);
      const listRes = await apiClient.get('/trading-v2/plans');
      const plans = (listRes.data?.plans || []).filter((p) =>
        matchTradingPlanSymbol(p, stockCode)
      );
      if (!plans.length) return null;

      const infinitePlan = plans.find((p) => p.strategyType === 'INFINITE_TRADE');
      const splitPlan = plans.find((p) => p.strategyType === 'SPLIT_TRADE');
      const primary =
        infinitePlan ||
        splitPlan ||
        [...plans].sort(
          (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
        )[0];

      const detailRes = await apiClient.get(`/trading-v2/plans/${primary.id}`);
      const detail = detailRes.data?.plan;
      if (!detail) return null;

      let splitDetail = null;
      if (splitPlan && splitPlan.id !== primary.id) {
        const splitRes = await apiClient.get(`/trading-v2/plans/${splitPlan.id}`);
        splitDetail = splitRes.data?.plan || null;
      } else if (primary.strategyType === 'SPLIT_TRADE') {
        splitDetail = detail;
      }

      const stageSource = splitDetail || detail;
      const allStages = stageSource.stages || [];
      const cycleId = stageSource.currentCycleId;
      const stages = cycleId
        ? allStages.filter((s) => s.cycleId === cycleId)
        : allStages;

      const cfg = detail.strategyConfig || {};
      // 무한매매 진행 중 = 현재 사이클에 매수 체결 있음 → 진입가 변경 금지
      let infiniteInProgress = false;
      if (detail.strategyType === 'INFINITE_TRADE') {
        const infCycleId = detail.currentCycleId;
        const buyOrderIds = new Set(
          (detail.orders || [])
            .filter(
              (o) =>
                String(o.side || '').toUpperCase() === 'BUY' &&
                (infCycleId == null || o.cycleId == null || Number(o.cycleId) === Number(infCycleId))
            )
            .map((o) => Number(o.id))
        );
        infiniteInProgress = (detail.fills || []).some(
          (f) => buyOrderIds.has(Number(f.orderId)) && Number(f.fillQty) > 0
        );
      }
      const trailingSrc =
        (infinitePlan && primary.strategyType === 'INFINITE_TRADE' ? cfg : null) ||
        (splitDetail?.strategyConfig || cfg);

      return {
        _source: 'v2',
        strategyType: detail.strategyType,
        status: detail.status,
        auto: detail.status === 'active' ? 'Y' : 'N',
        buy_trailing_percent: trailingSrc.buyTrailingPercent,
        sell_trailing_percent: trailingSrc.sellTrailingPercent,
        infiniteEnabled: detail.strategyType === 'INFINITE_TRADE',
        seedAmount: cfg.seedAmount,
        unitBuyAmount: cfg.unitBuyAmount,
        buyEntry: cfg.buyEntry,
        buyStepPercent: cfg.buyStepPercent,
        buyMultipliers: cfg.buyMultipliers,
        sellTargetPercent: cfg.sellTargetPercent,
        sellTargetPercent2: cfg.sellTargetPercent2,
        stages,
        orders: stageSource.orders || [],
        fills: stageSource.fills || [],
        splitPositions: Array.isArray(stageSource.splitPositions) ? stageSource.splitPositions : null,
        stageSourceStrategy: stageSource.strategyType,
        currentCycleId: cycleId,
        planId: detail.id,
        infiniteInProgress,
        planStatuses: {
          split: splitPlan ? { id: splitPlan.id, status: splitPlan.status } : null,
          infinite: infinitePlan ? { id: infinitePlan.id, status: infinitePlan.status } : null,
        },
      };
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      console.error('[반복자동매매설정] 불러오기 실패:', error);
      return null;
    }
  }, [user?.id]);

  const createDefaultRepeatAutoTradingForm = useCallback(() => ({
    maxStages: 5,
    autoTradingEnabled: true,
    // V2: 분할/무한 플랜별 활성(active) 여부 — 같은 종목 두 전략을 따로 on/off
    splitAutoEnabled: true,
    infiniteAutoEnabled: true,
    v2PlanStatus: { split: null, infinite: null },
    autoBuyEnabled: true,
    autoBuyOrderType: 'market',
    autoSellEnabled: true,
    trailingStopPercent: '0.3',
    buyTrailingStopPercent: '0.3',
                // INFINITE_TRADE (저장: trading_plans)
                infiniteEnabled: false,
    seedAmount: '',
    unitBuyAmount: '',
    buyStepPercent: '2',
    buyMultipliers: [...DEFAULT_INFINITE_BUY_MULTIPLIERS],
    buyEntry: '',
    sellTargetPercent: '10',
    sellTargetPercent2: '10',
    buyStages: Array(5).fill(null).map((_, i) => ({
      stage: i + 1,
      dropRate: i === 0 ? 2 : 5,
      amount: defaultBuyTotal,
      buyPrice: 0,
      buyTotal: defaultBuyTotal,
      buyQty: 0,
      buyOrderNo: null,
      buyEnd: 'N',
    })),
    sellStages: Array(5).fill(null).map((_, i) => ({
      stage: i + 1,
      profitRate: 5,
      sellPrice: 0,
      sellQty: 0,
    })),
  }), [defaultBuyTotal]);

  // 반복자동매매설정 다이얼로그가 열릴 때 기존 데이터 불러오기
  useEffect(() => {
    if (repeatAutoTradingDialogOpen && targetBuyDialogStock) {
      let cancelled = false;
      const loadData = async () => {
        // 종목 전환 시 이전 종목(매수완료 등)이 잠깐이라도 남지 않게 즉시 초기화
        setRepeatAutoTradingForm(createDefaultRepeatAutoTradingForm());
        setAutoTradingLoadMessage('');
        setSwingResultMessage('');

        const savedData = await loadAutoTradingData(targetBuyDialogStock.stockCode);
        if (cancelled) return;
        if (!savedData) {
          // 저장 데이터 없음 = 기본 폼 유지 (이전 종목 상태 잔존 방지)
          setAutoTradingLoadMessage('');
          return;
        }

        // V2 trading_plans 로드
        if (savedData._source === 'v2') {
          const defaults = createDefaultRepeatAutoTradingForm();
          const stages = savedData.stages || [];
          const buyByStage = new Map();
          const sellByStage = new Map();
          stages.forEach((s) => {
            if (s.side === 'BUY') buyByStage.set(Number(s.stage), s);
            if (s.side === 'SELL') sellByStage.set(Number(s.stage), s);
          });

          const cycleIdForFills = savedData.currentCycleId;
          const splitOrders = Array.isArray(savedData.orders) ? savedData.orders : [];
          const splitFills = Array.isArray(savedData.fills) ? savedData.fills : [];
          const qtyFromFills = (side, stageNo = null) => {
            const n = stageNo != null ? Number(stageNo) : null;
            const stageRow = n != null ? (side === 'BUY' ? buyByStage : sellByStage).get(n) : null;
            const ids = new Set(
              splitOrders
                .filter((o) => {
                  if (String(o.side || '').toUpperCase() !== side) return false;
                  if (
                    cycleIdForFills != null &&
                    o.cycleId != null &&
                    Number(o.cycleId) !== Number(cycleIdForFills)
                  ) {
                    return false;
                  }
                  if (n == null) return true;
                  if (stageRow?.id != null && o.stageId != null && Number(o.stageId) === Number(stageRow.id)) {
                    return true;
                  }
                  if (o.stageNo != null && Number(o.stageNo) === n) return true;
                  return false;
                })
                .map((o) => Number(o.id))
            );
            let q = 0;
            for (const f of splitFills) {
              if (!ids.has(Number(f.orderId))) continue;
              q += Number(f.fillQty) || 0;
            }
            return Math.floor(q);
          };
          const planRemQty = Math.max(0, qtyFromFills('BUY') - qtyFromFills('SELL'));
          // 무한매매 주문도 stage_no=1 로 저장되므로 분할 차수 체결로 해석하면 안 됨
          const isInfinitePlan = savedData.stageSourceStrategy === 'INFINITE_TRADE';
          // 서버 체결 로트 기준 차수 잔량 (완료된 매수·매도 짝 제외)
          const splitPosQty = savedData.splitPositions
            ? new Map(savedData.splitPositions.map((p) => [Number(p.stage), Number(p.qty) || 0]))
            : null;

          const newBuyStages = Array(5).fill(null).map((_, i) => {
            const n = i + 1;
            const st = buyByStage.get(n);
            const rem = isInfinitePlan
              ? 0
              : splitPosQty
                ? splitPosQty.get(n) || 0
                : Math.max(0, qtyFromFills('BUY', n) - qtyFromFills('SELL', n));
            const filled = !isInfinitePlan && planRemQty > 0 && rem > 0;
            const rawPct = st?.percent != null ? Number(st.percent) : NaN;
            const dropMag = Number.isFinite(rawPct) ? Math.abs(rawPct) : i === 0 ? 2 : 5;
            return {
              stage: n,
              dropRate: dropMag,
              buyTotal: st?.targetAmount != null ? st.targetAmount : defaultBuyTotal,
              buyPrice: st?.targetPrice != null ? st.targetPrice : 0,
              buyQty: st?.targetQty != null ? st.targetQty : 0,
              buyOrderNo: null,
              buyEnd: filled ? 'Y' : 'N',
            };
          });

          const newSellStages = Array(5).fill(null).map((_, i) => {
            const st = sellByStage.get(i + 1);
            return {
              stage: i + 1,
              profitRate: st?.percent != null ? st.percent : 5,
              sellPrice: st?.targetPrice != null ? st.targetPrice : 0,
              sellQty: st?.targetQty != null ? st.targetQty : 0,
              sellOrderNo: null,
            };
          });

          const mults = Array.isArray(savedData.buyMultipliers)
            ? savedData.buyMultipliers.map((m) => String(m))
            : [...DEFAULT_INFINITE_BUY_MULTIPLIERS];

          if (cancelled) return;
          const planStatuses = savedData.planStatuses || { split: null, infinite: null };
          setRepeatAutoTradingForm({
            ...defaults,
            autoTradingEnabled: savedData.auto === 'Y',
            splitAutoEnabled: planStatuses.split ? planStatuses.split.status === 'active' : true,
            infiniteAutoEnabled: planStatuses.infinite ? planStatuses.infinite.status === 'active' : true,
            v2PlanStatus: planStatuses,
            infiniteInProgress: !!savedData.infiniteInProgress,
            autoBuyEnabled: savedData.auto === 'Y',
            autoSellEnabled: savedData.auto === 'Y',
            buyTrailingStopPercent: trailingToFormString(savedData.buy_trailing_percent),
            trailingStopPercent: trailingToFormString(savedData.sell_trailing_percent),
            infiniteEnabled: !!savedData.infiniteEnabled,
            seedAmount:
              savedData.seedAmount != null && savedData.seedAmount !== ''
                ? String(savedData.seedAmount)
                : '',
            unitBuyAmount:
              savedData.unitBuyAmount != null && savedData.unitBuyAmount !== ''
                ? String(savedData.unitBuyAmount)
                : '',
            buyStepPercent: trailingToFormString(savedData.buyStepPercent, '2'),
            buyMultipliers: mults.length ? mults : [...DEFAULT_INFINITE_BUY_MULTIPLIERS],
            buyEntry:
              savedData.buyEntry != null && savedData.buyEntry !== ''
                ? String(savedData.buyEntry)
                : '',
            sellTargetPercent: trailingToFormString(savedData.sellTargetPercent, '10'),
            sellTargetPercent2: trailingToFormString(savedData.sellTargetPercent2, '10'),
            buyStages: newBuyStages,
            sellStages: newSellStages,
          });
          setAutoTradingLoadMessage(
            `저장한 ${savedData.infiniteEnabled ? '무한매매' : '분할매매'} 플랜을 불러왔습니다.`
          );
        }
      };
      
      loadData();
      return () => {
        cancelled = true;
      };
    }
    setAutoTradingLoadMessage('');
    return undefined;
  }, [repeatAutoTradingDialogOpen, targetBuyDialogStock, loadAutoTradingData, createDefaultRepeatAutoTradingForm, defaultBuyTotal]);
  const [repeatAutoTradingForm, setRepeatAutoTradingForm] = useState(() => ({
    maxStages: 5, // 고정값
    autoTradingEnabled: true, // 자동매매 활성화 여부
    splitAutoEnabled: true,
    infiniteAutoEnabled: true,
    v2PlanStatus: { split: null, infinite: null },
    autoBuyEnabled: true,
    autoBuyOrderType: 'market',
    autoSellEnabled: true,
    trailingStopPercent: '0.3', // Sell Trailing % (문자열로 두어 0.x 입력 유지)
    buyTrailingStopPercent: '0.3', // Buy Trailing %
    infiniteEnabled: false,
    seedAmount: '',
    unitBuyAmount: '',
    buyStepPercent: '2',
    buyMultipliers: [...DEFAULT_INFINITE_BUY_MULTIPLIERS],
    buyEntry: '',
    sellTargetPercent: '10',
    sellTargetPercent2: '10',
    buyStages: Array(5).fill(null).map((_, i) => ({
      stage: i + 1,
      dropRate: i === 0 ? 2 : 5, // 1차: 2%, 2-5차: 5%
      amount: defaultBuyTotal, // 매수총액 디폴트 (KR 1,000,000 / US 1,000)
      buyPrice: 0, // 매수가격 (계산됨)
      buyTotal: defaultBuyTotal, // 매수총액 (입력)
      buyQty: 0, // 매수수량 (계산됨)
      buyOrderNo: null, // 주문번호
      buyEnd: 'N', // 매수 완료 여부 (Y/N)
    })),
    sellStages: Array(5).fill(null).map((_, i) => ({
      stage: i + 1,
      profitRate: 5, // 1-5차 모두 5%
      sellPrice: 0, // 매도가격 (계산됨)
      sellQty: 0, // 매도수량 (계산됨, 해당 차수의 buyQty와 동일)
    })),
  }));

  // 관심종목 목록 조회
  const fetchWatchlist = useCallback(async (targetGroupNo = watchlistTab) => {
    try {
      setLoading(true);
      setErrorMessage(null);
      const response = await apiClient.get(apiBase, {
        params: { groupNo: targetGroupNo },
      });
      setWatchlist(response.data || []);
    } catch (error) {
      console.error('[관심종목] 목록 조회 실패:', error);
      let message = '관심종목 목록을 불러오는 중 오류가 발생했습니다.';
      if (error.response?.status === 401) {
        message = '로그인이 필요합니다.';
      } else if (error.response?.data?.error) {
        message = error.response.data.error;
      }
      setErrorMessage(message);
      setWatchlist([]);
    } finally {
      setLoading(false);
    }
  }, [watchlistTab, apiBase]);

  // 거래시간·주말 (대시보드와 동일: 1분마다 갱신)
  useEffect(() => {
    const checkTradingHours = () => {
      setIsInTradingHours(isTradingHours());
      setIsInNXTTradingHours(isNXTTradingHours());
    };
    checkTradingHours();
    const tradingTimer = setInterval(checkTradingHours, 60000);
    return () => clearInterval(tradingTimer);
  }, []);

  // 현재가 REST 스냅샷 (국내: 장외·휴장만 — 장중은 WebSocket / 미국: REST 시드 + WS)
  const fetchPrices = useCallback(async (showLoading = true) => {
    if (watchlist.length === 0) {
      setPrices([]);
      return;
    }

    if (pricesRequestInFlightRef.current) return;
    pricesRequestInFlightRef.current = true;
    try {
      if (showLoading) setPriceLoading(true);
      const response = await apiClient
        .get(`${apiBase}/prices`, { params: { groupNo: watchlistTab } })
        .catch(() => ({ data: [] }));
      setPrices(response.data || []);
    } catch (error) {
      console.error('[관심종목] 현재가 조회 실패:', error);
    } finally {
      pricesRequestInFlightRef.current = false;
      if (showLoading) setPriceLoading(false);
    }
  }, [watchlist.length, apiBase, watchlistTab]);

  // WebSocket 체결 틱 → prices 병합
  const upsertPriceFromWs = useCallback((data) => {
    if (!data?.stockCode) return;
    const incoming = String(data.stockCode);
    const isUsCode = looksLikeUsTicker(incoming);
    const key = isUsCode ? incoming.toUpperCase() : incoming.substring(0, 6);
    setPrices((prev) => {
      const next = [...prev];
      const idx = next.findIndex((p) => {
        const code = String(p.stockCode || '');
        if (isUsCode) return code.toUpperCase() === key;
        return code.substring(0, 6) === key;
      });
      const merged = {
        ...(idx >= 0 ? next[idx] : {}),
        stockCode: idx >= 0 ? next[idx].stockCode : data.stockCode,
        stockName: data.stockName || (idx >= 0 ? next[idx].stockName : '') || '',
        stockMarket:
          data.stockMarket ||
          (idx >= 0 ? next[idx].stockMarket : isUsCode ? 'US' : 'KRX') ||
          (isUsCode ? 'US' : 'KRX'),
        price: data.price,
        change: data.change,
        changeRate: data.changeRate,
      };
      if (idx >= 0) next[idx] = merged;
      else next.push(merged);
      return next;
    });
  }, []);

  /** 종목 검색 (KRX/US 통합 검색 API) */
  const searchBothMarkets = useCallback(async (rawQuery) => {
    const q = String(rawQuery || '').trim();
    if (!q) return [];

    setSearchingStock(true);
    try {
      const response = await apiClient.post('/market/stocks/search', { query: q });
      return response.data?.results || [];
    } finally {
      setSearchingStock(false);
    }
  }, []);

  const applyFoundStock = useCallback((hit) => {
    if (!hit) {
      setFoundStockCode('');
      setFoundStockName('');
      setFoundStockMarket('');
      return;
    }
    setFoundStockCode(hit.stockCode);
    setFoundStockName(hit.stockName);
    setFoundStockMarket(hit.stockMarket || 'KRX');
  }, []);

  const clearFoundStock = useCallback(() => {
    setFoundStockCode('');
    setFoundStockName('');
    setFoundStockMarket('');
    setSearchCandidates([]);
  }, []);

  // 종목명/티커 변경 시 자동 검색
  useEffect(() => {
    const timer = setTimeout(async () => {
      const q = searchName.trim();
      if (q.length < 1) {
        clearFoundStock();
        return;
      }
      const hits = await searchBothMarkets(q);
      setSearchCandidates(hits);
      if (hits.length === 0) {
        applyFoundStock(null);
      } else {
        // 1건이거나 우선순위 1위를 기본 선택 (통화·시장 자동)
        applyFoundStock(hits[0]);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [searchName, searchBothMarkets, applyFoundStock, clearFoundStock]);

  // 관심종목 추가
  const handleAddStock = useCallback(async () => {
    const raw = searchName.trim();
    if (!raw) {
      setErrorMessage('티커 또는 종목명을 입력하세요.');
      return;
    }

    try {
      setErrorMessage(null);
      let hit = foundStockCode
        ? {
            stockCode: foundStockCode,
            stockName: foundStockName,
            stockMarket: foundStockMarket || 'KRX',
          }
        : null;
      if (!hit) {
        const hits = await searchBothMarkets(raw);
        hit = hits[0] || null;
      }
      if (!hit?.stockCode) {
        setErrorMessage(`종목 "${raw}"을(를) 찾을 수 없습니다. (KRX/US)`);
        return;
      }
      await apiClient.post(apiBase, {
        market: hit.stockMarket === 'US' || hit.market === 'US' ? 'US' : 'KR',
        symbol: hit.stockCode,
        name: hit.stockName || hit.stockCode,
        exchange: hit.exchange || null,
        groupNo: watchlistTab,
      });
      setSearchName('');
      clearFoundStock();
      await fetchWatchlist(watchlistTab);
      setTimeout(() => fetchPrices(false), 500);
    } catch (error) {
      const message =
        error.response?.data?.error ||
        error.response?.data?.suggestion ||
        '관심종목 추가 중 오류가 발생했습니다.';
      setErrorMessage(message);
    }
  }, [
    searchName,
    foundStockCode,
    foundStockName,
    foundStockMarket,
    searchBothMarkets,
    fetchWatchlist,
    fetchPrices,
    watchlistTab,
    apiBase,
    clearFoundStock,
  ]);

  // 관심종목 삭제
  const handleDeleteStock = useCallback(async (stockCode) => {
    if (!window.confirm(`정말 ${stockCode}를 관심종목에서 삭제하시겠습니까?`)) {
      return;
    }

    try {
      const item = watchlist.find(
        (w) =>
          String(w.stockCode) === String(stockCode) ||
          String(w.stockCode).toUpperCase() === String(stockCode).toUpperCase()
      );
      if (item?.id) {
        await apiClient.delete(`${apiBase}/${item.id}`);
      } else {
        await apiClient.delete(apiBase, {
          params: {
            symbol: stockCode,
            market: item?.stockMarket === 'US' ? 'US' : 'KR',
          },
        });
      }
      // 플랜·목표가 표시 갱신 (삭제된 종목 잔상 제거)
      try {
        const res = await apiClient.get('/trading-v2/plans');
        setTradingPlans(res.data?.plans || []);
        const code = String(stockCode || '').trim().toUpperCase();
        setAutoTradingList((prev) =>
          (prev || []).filter((x) => String(x.stockCode || '').trim().toUpperCase() !== code)
        );
      } catch (_) {
        /* ignore refresh errors */
      }
      await fetchWatchlist(watchlistTab);
      setTimeout(() => fetchPrices(false), 500);
    } catch (error) {
      const message = error.response?.data?.error || '관심종목 삭제 중 오류가 발생했습니다.';
      setErrorMessage(message);
      alert(message);
    }
  }, [fetchWatchlist, fetchPrices, watchlistTab, apiBase, watchlist]);

  // 초기 로드 및 가격 조회
  useEffect(() => {
    fetchWatchlist(watchlistTab);
  }, [fetchWatchlist, watchlistTab]);

  // 환경설정의 관심종목 이름 (user_settings.group_name1~8)을 버튼 라벨에 반영
  useEffect(() => {
    let cancelled = false;
    const fetchWatchListNames = async () => {
      try {
        const response = await apiClient.get('/settings/user-settings');
        if (cancelled) return;
        const data = response.data || {};
        const names = {};
        for (let n = 1; n <= watchlistGroupCount; n += 1) {
          names[n] = data[`groupName${n}`] || `관심종목${n}`;
        }
        setWatchListNames(names);
      } catch (error) {
        // 이름 조회 실패 시 기본값 유지
        console.error('[관심종목] 이름 조회 실패:', error);
      }
    };

    fetchWatchListNames();
    return () => {
      cancelled = true;
    };
  }, [watchlistGroupCount]);

  // 관심종목 현재가 조회 (목록 변경 시, 로딩 표시)
  useEffect(() => {
    if (watchlist.length > 0) {
      fetchPrices(true);
    } else {
      setPrices([]);
    }
  }, [watchlist, fetchPrices]);

  // 키움 실시간 WebSocket — 장시간 게이트 없이 연결 (국내·미국 혼합 목록, 프리마켓 대응)
  useEffect(() => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) {
      setPricesWsReady(false);
      return undefined;
    }
    const conn = connectWatchlistPricesWs({
      token,
      onOpen: () => setPricesWsReady(true),
      onClose: () => setPricesWsReady(false),
      onMessage: (msg) => {
        if (msg.type === 'price' && msg.data) {
          upsertPriceFromWs(msg.data);
          setPriceLoading(false);
        } else if (msg.type === 'status' && msg.status === 'connected') {
          setPricesWsReady(true);
        }
      },
    });
    pricesWsRef.current = conn;
    return () => {
      conn.close();
      if (pricesWsRef.current === conn) {
        pricesWsRef.current = null;
      }
      setPricesWsReady(false);
    };
  }, [upsertPriceFromWs]);

  // WS 연결 후·관심종목 변경 시 구독 목록 전송
  useEffect(() => {
    if (!pricesWsReady || !pricesWsRef.current) return;
    pricesWsRef.current.send({
      type: 'set_watchlist',
      items: watchlist.map((w) => ({
        stockCode: w.stockCode,
        stockName: w.stockName,
        stockMarket: w.stockMarket || 'KRX',
        exchange: w.exchange || null,
        stexTp: w.exchange || null,
      })),
    });
  }, [watchlist, pricesWsReady, isInTradingHours, isInNXTTradingHours]);

  // 가격 정보 맵 생성 (O(1) 조회 — 국내 6자리 / 미국 티커)
  const priceMap = useMemo(() => {
    const map = new Map();
    prices.forEach((p) => {
      if (!p?.stockCode) return;
      const code = String(p.stockCode);
      const isUsCode = p.stockMarket === 'US' || looksLikeUsTicker(code);
      if (isUsCode) {
        map.set(code.toUpperCase(), p);
        map.set(code, p);
      } else {
        const code6 = code.substring(0, 6);
        map.set(code6, p);
        map.set(code, p);
      }
    });
    return map;
  }, [prices]);

  // auto_trading 맵 생성 및 매수목표가/수량 계산
  const autoTradingMap = useMemo(() => {
    const map = new Map();
    const setForCode = (stockCode, value) => {
      const code = String(stockCode || '').trim();
      if (!code) return;
      const keys = [code, code.toUpperCase()];
      if (/^\d+$/.test(code) && code.length >= 6) {
        keys.push(code.substring(0, 6));
      }
      keys.forEach((k) => map.set(k, value));
    };
    autoTradingList.forEach(item => {
      // buy_cur 값을 읽어서 해당 차수의 buyX_price와 buyX_qty 표시
      const buyCur = parseInt(item.buy_cur || 0, 10);
      const isInfinite = !!item.infinite;
      const alsoInfinite = !!item.alsoInfinite;
      const stage = isInfinite ? null : buyCur > 0 ? buyCur : null;

      // buyX_end가 'Y'인 경우 매수가 완료된 것이므로 표시하지 않음
      const buyXEnd = buyCur > 0 ? item[`buy${buyCur}_end`] : null;
      if (buyXEnd === 'Y') {
        // 매수가 완료된 차수는 표시하지 않음
        const autoValue = item.auto || 'N';
        setForCode(item.stockCode, {
          auto: autoValue,
          stage,
          infinite: isInfinite,
          alsoInfinite,
        });
        console.log(`[auto_trading 맵] ${item.stockCode}: buy_cur=${buyCur}, buy${buyCur}_end=Y (매수완료), 표시하지 않음, auto=${autoValue}`);
        return; // 다음 항목으로
      }
      
      const buyPrice = buyCur > 0 ? parseFloat(item[`buy${buyCur}_price`] || 0) : 0;
      const buyQty = buyCur > 0 ? parseInt(item[`buy${buyCur}_qty`] || 0, 10) : 0;
      
      // auto 필드도 함께 저장
      const autoValue = item.auto || 'N';
      
      if (buyPrice > 0) {
        setForCode(item.stockCode, {
          target_price: buyPrice,
          target_qty: buyQty,
          auto: autoValue,
          stage,
          infinite: isInfinite,
          alsoInfinite,
        });
        console.log(`[auto_trading 맵] ${item.stockCode}: buy_cur=${buyCur}, 매수목표가=${buyPrice}, 수량=${buyQty}, auto=${autoValue}`);
      } else {
        // 매수가격이 없어도 auto 값은 저장
        setForCode(item.stockCode, {
          auto: autoValue,
          stage,
          infinite: isInfinite,
          alsoInfinite,
        });
        console.log(`[auto_trading 맵] ${item.stockCode}: buy_cur=${buyCur}, 매수가격 없음, auto=${autoValue}`);
      }
    });
    console.log(`[auto_trading 맵] 생성 완료: 총 ${map.size}개 종목`);
    return map;
  }, [autoTradingList]);

  /** V2: stockCode → 전략유형 표시 문자열 (분할매매 / 무한매매) */
  const strategyTypeMap = useMemo(() => {
    const map = new Map();
    const byCode = new Map();
    tradingPlans.forEach((p) => {
      const raw = p.instrument?.symbol || p.symbol || '';
      const code = String(raw).trim();
      if (!code) return;
      const keys = [code, code.toUpperCase()];
      if (/^\d+$/.test(code) && code.length >= 6) {
        keys.push(code.substring(0, 6));
      }
      keys.forEach((k) => {
        if (!byCode.has(k)) byCode.set(k, new Set());
        if (p.strategyType) byCode.get(k).add(p.strategyType);
      });
    });
    byCode.forEach((types, code) => {
      const ordered = [];
      if (types.has('SPLIT_TRADE')) ordered.push('SPLIT_TRADE');
      if (types.has('INFINITE_TRADE')) ordered.push('INFINITE_TRADE');
      types.forEach((t) => {
        if (t !== 'SPLIT_TRADE' && t !== 'INFINITE_TRADE') ordered.push(t);
      });
      map.set(code, formatStrategyTypeLabel(ordered));
    });
    return map;
  }, [tradingPlans]);

  // auto_trading 목록 조회
  const fetchAutoTrading = useCallback(async () => {
    if (!user?.id) {
      console.log('[auto_trading] 사용자 ID 없음, 조회 건너뜀');
      return;
    }
    try {
      await apiClient.post('/trading-v2/bootstrap').catch(() => null);
      const res = await apiClient.get('/trading-v2/plans');
      const plans = res.data?.plans || [];
      setTradingPlans(plans);

      // 종목당 표시용 플랜: 분할 우선(무한만 있으면 무한), 같은 전략이면 active 우선 → 사용자 저장시각
      const bySymbol = new Map();
      const infiniteSymbols = new Set();
      const planRank = (p) =>
        (p.strategyType === 'SPLIT_TRADE' ? 10 : 0) +
        (p.status === 'active' ? 2 : p.status === 'paused' ? 1 : 0);
      const planSaveTime = (p) => {
        const raw = p.strategyConfig?.lastUserSaveAt;
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n;
        return new Date(p.updatedAt || 0).getTime() || 0;
      };
      for (const p of plans) {
        const sym = String(p.instrument?.symbol || '').trim();
        if (!sym) continue;
        if (p.strategyType === 'INFINITE_TRADE') infiniteSymbols.add(sym);
        const prev = bySymbol.get(sym);
        if (!prev) {
          bySymbol.set(sym, p);
          continue;
        }
        const rNew = planRank(p);
        const rOld = planRank(prev);
        if (rNew > rOld) {
          bySymbol.set(sym, p);
        } else if (rNew === rOld) {
          if (planSaveTime(p) >= planSaveTime(prev)) bySymbol.set(sym, p);
        }
      }

      const details = await Promise.all(
        [...bySymbol.values()].map((p) =>
          apiClient
            .get(`/trading-v2/plans/${p.id}`)
            .then((r) => r.data?.plan || null)
            .catch(() => null)
        )
      );

      const list = [];
      for (const detail of details) {
        if (!detail) continue;
        const stockCode = String(detail.instrument?.symbol || '').trim();
        if (!stockCode) continue;

        const auto = detail.status === 'active' ? 'Y' : 'N';

        // 무한매매: strategy_config.buyEntry → 매수목표가
        if (detail.strategyType === 'INFINITE_TRADE') {
          const cfg = detail.strategyConfig || {};
          const buyEntry = Number(cfg.buyEntry);
          const unitAmt = Number(cfg.unitBuyAmount);
          const price = Number.isFinite(buyEntry) && buyEntry > 0 ? buyEntry : 0;
          const qty =
            price > 0 && Number.isFinite(unitAmt) && unitAmt > 0
              ? Math.floor(unitAmt / price)
              : 0;
          list.push({
            stockCode,
            auto,
            infinite: true,
            buy_cur: price > 0 ? 1 : 0,
            buy1_price: price,
            buy1_qty: qty,
            buy1_end: 'N',
          });
          continue;
        }

        const cycleId = detail.currentCycleId;
        const buyStages = (detail.stages || []).filter(
          (s) => s.side === 'BUY' && (!cycleId || s.cycleId === cycleId)
        );
        const sellStages = (detail.stages || []).filter(
          (s) => s.side === 'SELL' && (!cycleId || s.cycleId === cycleId)
        );

        const item = { stockCode, auto, buy_cur: 0, alsoInfinite: infiniteSymbols.has(stockCode) };
        let selectedCur = 0;
        let hasBuyStage = false;
        for (let i = 1; i <= 5; i++) {
          const st = buyStages.find((s) => Number(s.stage) === i);
          const sellSt = sellStages.find((s) => Number(s.stage) === i);
          const price = st?.targetPrice != null ? Number(st.targetPrice) : 0;
          const qty = st?.targetQty != null ? Number(st.targetQty) : 0;
          item[`buy${i}_price`] = Number.isFinite(price) ? price : 0;
          item[`buy${i}_qty`] = Number.isFinite(qty) ? qty : 0;
          // 매수만 filled + 매도 미완 → 보유 중(해당 차수 매수 완료)
          // 매수·매도 둘 다 filled → 왕복 완료 → 다시 매수 대기
          const buyFilled = st?.status === 'filled';
          const sellFilled = sellSt?.status === 'filled';
          item[`buy${i}_end`] = buyFilled && !sellFilled ? 'Y' : 'N';
          if (item[`buy${i}_price`] > 0) hasBuyStage = true;
          if (
            !selectedCur &&
            item[`buy${i}_end`] !== 'Y' &&
            item[`buy${i}_price`] > 0
          ) {
            selectedCur = i;
          }
        }
        item.buy_cur = selectedCur || (hasBuyStage ? 1 : 0);
        list.push(item);
      }
      setAutoTradingList(list);
    } catch (planErr) {
      console.error('[trading_plans] 조회 실패:', planErr);
      setTradingPlans([]);
      setAutoTradingList([]);
    }
  }, [user?.id]);

  const handleOpenChart = useCallback((stock) => {
    setChartDialogStock(stock);
    setChartDialogOpen(true);
  }, []);

  const chartBuyLevels = useMemo(() => {
    if (!chartDialogStock) return [];
    const at = autoTradingList.find((x) => x.stockCode === chartDialogStock.stockCode);
    if (!at) return [];
    const levels = [];
    // 매수 완료(buyN_end=Y)된 차수만 차트 매수라인에 표시
    for (let i = 1; i <= 5; i += 1) {
      const ended = String(at[`buy${i}_end`] || 'N').toUpperCase() === 'Y';
      if (!ended) continue;
      const price = parseFloat(at[`buy${i}_price`] || 0);
      if (price > 0) levels.push({ stage: i, price });
    }
    return levels;
  }, [chartDialogStock, autoTradingList]);

  const chartTradeMarkers = useMemo(() => {
    if (!chartDialogStock) return [];
    const at = autoTradingList.find((x) => x.stockCode === chartDialogStock.stockCode);
    if (!at) return [];
    const markers = [];
    for (let i = 1; i <= 5; i += 1) {
      const buyDate = at[`buy${i}_date`];
      if (buyDate) {
        markers.push({
          stage: i,
          side: 'buy',
          date: String(buyDate).slice(0, 10),
          price: parseFloat(at[`buy${i}_price`] || 0) || undefined,
        });
      }
      const sellDate = at[`sell${i}_date`];
      if (sellDate) {
        markers.push({
          stage: i,
          side: 'sell',
          date: String(sellDate).slice(0, 10),
          price: parseFloat(at[`sell${i}_price`] || 0) || undefined,
        });
      }
    }
    return markers;
  }, [chartDialogStock, autoTradingList]);

  // 초기 로드 시 auto_trading 조회
  useEffect(() => {
    fetchAutoTrading();
  }, [fetchAutoTrading]);

  // 현재가 기반 매수가 계산 (반복자동매매설정)
  const currentPriceForAutoTrading = useMemo(() => {
    if (!targetBuyDialogStock) return 0;
    const code = String(targetBuyDialogStock.stockCode || '');
    if (!code) return 0;
    const rowIsUs = isUsMarket(targetBuyDialogStock.stockMarket, code);
    const info = rowIsUs
      ? priceMap.get(code.toUpperCase()) || priceMap.get(code)
      : priceMap.get(code.substring(0, 6)) || priceMap.get(code);
    return Number(info?.price) || 0;
  }, [targetBuyDialogStock, priceMap]);

  /** 일봉 스윙 저점/고점 → 1~5차 매수%·매도% 자동 설정 (백엔드 API) */
  const handleFindSwingLows = useCallback(async () => {
    if (!targetBuyDialogStock?.stockCode) {
      setErrorMessage('종목 정보가 없습니다.');
      return;
    }
    const currentPrice = currentPriceForAutoTrading;
    if (!(currentPrice > 0)) {
      setErrorMessage('현재가가 없어 스윙 지점을 찾을 수 없습니다.');
      return;
    }

    try {
      setSwingFindLoading(true);
      setErrorMessage(null);
      const stockUs = isUsMarket(
        targetBuyDialogStock.stockMarket || targetBuyDialogStock.market,
        targetBuyDialogStock.stockCode
      );
      const market = stockUs
        ? 'US'
        : targetBuyDialogStock.stockMarket === 'NXT'
          ? 'NXT'
          : 'KRX';
      const payload = {
        stockCode: targetBuyDialogStock.stockCode,
        market,
        days: 240,
        currentPrice,
        buyStages: repeatAutoTradingForm.buyStages,
      };
      if (stockUs && (targetBuyDialogStock.exchange || targetBuyDialogStock.stexTp)) {
        payload.stex_tp = targetBuyDialogStock.exchange || targetBuyDialogStock.stexTp;
      }

      const { data } = await apiClient.post('/market/swing-levels', payload);
      const buyResult = data?.buy;
      const sellResult = data?.sell;

      if (!buyResult?.ok) {
        setErrorMessage(buyResult?.message || '스윙 저점(매수%) 반영에 실패했습니다.');
        return;
      }

      setRepeatAutoTradingForm((prev) => {
        const newBuyStages = prev.buyStages.map((stage, idx) => {
          if (stage.buyEnd === 'Y') return stage;
          const drop = buyResult.dropRates?.[idx];
          if (drop == null || !(drop > 0)) return stage;
          return { ...stage, dropRate: String(drop) };
        });
        const newSellStages = prev.sellStages.map((stage, idx) => {
          const rate = sellResult?.ok ? sellResult.profitRates?.[idx] : null;
          if (rate == null || !(rate > 0)) return stage;
          return { ...stage, profitRate: String(rate) };
        });
        return { ...prev, buyStages: newBuyStages, sellStages: newSellStages };
      });

      const parts = [buyResult.message];
      if (sellResult?.ok) parts.push(sellResult.message);
      else parts.push(sellResult?.message || '매도%는 기본값 유지');
      setSwingResultMessage(parts.filter(Boolean).join(' · '));
      setAutoTradingLoadMessage('');
    } catch (err) {
      console.error('[스윙지점찾기] 실패:', err);
      setErrorMessage(err.response?.data?.error || err.message || '스윙 지점 찾기 실패');
    } finally {
      setSwingFindLoading(false);
    }
  }, [
    targetBuyDialogStock,
    currentPriceForAutoTrading,
    repeatAutoTradingForm.buyStages,
  ]);

  // 매수가 및 매도가 계산 함수 (현재가를 파라미터로 받을 수 있음)
  const calculateBuySellPrices = useCallback((currentPrice = null) => {
    const priceToUse = currentPrice !== null ? currentPrice : currentPriceForAutoTrading;
    if (!priceToUse || priceToUse <= 0) {
      return { buyStages: repeatAutoTradingForm.buyStages, sellStages: repeatAutoTradingForm.sellStages };
    }
    
    const newBuyStages = repeatAutoTradingForm.buyStages.map(stage => ({ ...stage }));
    let basePrice = priceToUse;
    
    // 1차부터 5차까지: 현재가 또는 이전 차수 기준으로 하락률 적용
    // 단, buyEnd가 'Y'인 경우는 저장된 buyPrice와 buyQty를 그대로 유지
    for (let i = 0; i < 5; i++) {
      // buyEnd가 'Y'인 경우는 계산하지 않고 저장된 값 유지
      if (newBuyStages[i]?.buyEnd === 'Y') {
        continue;
      }
      
      if (i === 0) {
        // 1차 매수: 현재가에서 하락률 적용 (하락률이 있으면)
        const drop0 = parseRateValue(newBuyStages[0].dropRate);
        if (drop0 > 0) {
          const dropPercent = drop0 / 100;
          basePrice = basePrice * (1 - dropPercent);
        }
        newBuyStages[0].buyPrice = adjustPriceToTickSize(basePrice, isUsMarketItem(targetBuyDialogStock) ? 'US' : 'KRX');
      } else {
        // 2차부터 5차까지: 이전 차수 기준으로 하락률 적용
        const dropI = parseRateValue(newBuyStages[i]?.dropRate);
        if (newBuyStages[i] && dropI > 0) {
          // 이전 차수가 매수 완료(buyEnd='Y')인 경우, 현재가를 기준으로 계산
          // 그렇지 않으면 이전 차수 가격을 기준으로 계산
          let referencePrice;
          if (newBuyStages[i - 1].buyEnd === 'Y') {
            // 이전 차수가 매수 완료된 경우: 현재가를 기준으로 계산
            referencePrice = priceToUse;
          } else {
            // 이전 차수가 매수 완료되지 않은 경우: 이전 차수 가격을 기준으로 계산
            referencePrice = newBuyStages[i - 1].buyPrice || priceToUse;
          }
          const dropPercent = dropI / 100;
          basePrice = referencePrice * (1 - dropPercent); // 기준 가격에서 하락률 적용
          newBuyStages[i].buyPrice = adjustPriceToTickSize(basePrice, isUsMarketItem(targetBuyDialogStock) ? 'US' : 'KRX');
        }
      }
    }
    
    // 매수수량 계산 (매수총액/매수금액)
    // 단, buyEnd가 'Y'인 경우는 저장된 buyQty를 그대로 유지
    for (let i = 0; i < 5; i++) {
      // buyEnd가 'Y'인 경우는 계산하지 않고 저장된 값 유지
      if (newBuyStages[i]?.buyEnd === 'Y') {
        continue;
      }
      
      if (newBuyStages[i] && newBuyStages[i].buyPrice > 0 && newBuyStages[i].buyTotal > 0) {
        newBuyStages[i].buyQty = Math.floor(newBuyStages[i].buyTotal / newBuyStages[i].buyPrice);
      } else {
        newBuyStages[i].buyQty = 0;
      }
    }
    
    // 매도가 자동 계산 (매수가 기준으로 수익률 적용)
    const newSellStages = repeatAutoTradingForm.sellStages.map(stage => ({ ...stage }));
    for (let i = 0; i < 5; i++) {
      const buyStage = newBuyStages[i];
      const profitR = parseRateValue(newSellStages[i]?.profitRate);
      if (buyStage && buyStage.buyPrice > 0 && newSellStages[i] && profitR > 0) {
        const profitPercent = profitR / 100;
        const sellPrice = buyStage.buyPrice * (1 + profitPercent);
        newSellStages[i].sellPrice = adjustPriceToTickSize(sellPrice, isUsMarketItem(targetBuyDialogStock) ? 'US' : 'KRX');
        // 매도수량은 해당 차수의 매수수량과 동일
        newSellStages[i].sellQty = buyStage.buyQty || 0;
      }
    }
    
    return { buyStages: newBuyStages, sellStages: newSellStages };
  }, [currentPriceForAutoTrading, repeatAutoTradingForm.buyStages, repeatAutoTradingForm.sellStages, isUsMarketItem, targetBuyDialogStock]);

  const computeInfiniteBuyEntryValue = useCallback((priceOverride = null) => {
    const priceToUse = Number(priceOverride) > 0 ? Number(priceOverride) : currentPriceForAutoTrading;
    if (!(priceToUse > 0)) return '';
    const drop0 = parseRateValue(repeatAutoTradingForm.buyStages?.[0]?.dropRate);
    let entry = priceToUse;
    if (drop0 > 0) entry = entry * (1 - drop0 / 100);
    const marketKey = isUsMarketItem(targetBuyDialogStock) ? 'US' : 'KRX';
    const adjusted = adjustPriceToTickSize(entry, marketKey);
    if (!(adjusted > 0)) return '';
    return marketKey === 'US' ? String(adjusted) : String(Math.floor(adjusted));
  }, [
    currentPriceForAutoTrading,
    repeatAutoTradingForm.buyStages,
    isUsMarketItem,
    targetBuyDialogStock,
  ]);

  const setInfiniteEnabled = useCallback((enabled) => {
    const filled = enabled ? computeInfiniteBuyEntryValue() : '';
    setRepeatAutoTradingForm((prev) => ({
      ...prev,
      infiniteEnabled: enabled,
      ...(enabled && !prev.infiniteInProgress ? { buyEntry: filled || prev.buyEntry } : {}),
    }));
  }, [computeInfiniteBuyEntryValue]);

  // 단일 종목의 최신 현재가 조회 함수
  const fetchLatestPrice = useCallback(async (stockCode, stockMarket = 'KRX') => {
    if (isUsMarket(stockMarket, stockCode)) {
      const priceInfo = prices.find((p) => String(p.stockCode || '').toUpperCase() === String(stockCode || '').toUpperCase());
      return priceInfo?.price > 0 ? priceInfo.price : 0;
    }
    try {
      // /market/stock-info/:stockCode API를 사용하여 최신 현재가 조회
      const response = await apiClient.get(`/market/stock-info/${stockCode}`);
      
      if (response.data?.return_code === 0 && response.data?.atn_stk_infr?.length) {
        // extractPriceData와 동일한 로직으로 현재가 추출
        const firstItem = response.data.atn_stk_infr[0];
        // 현재가: cur_prc (예: "+104500" -> 104500)
        const curPrcStr = String(firstItem.cur_prc || '0').replace(/[+-]/g, '');
        const price = parseFloat(curPrcStr) || 0;
        
        if (price > 0) {
          console.log(`[최신 현재가 조회] 성공: ${stockCode} = ${price}원`);
          return price;
        }
      }
      
      console.warn(`[최신 현재가 조회] 응답 데이터 없음: ${stockCode}`);
      // 조회 실패 시 기존 prices에서 찾기
      const priceInfo = prices.find(p => p.stockCode === stockCode);
      if (priceInfo?.price > 0) {
        console.log(`[최신 현재가 조회] 기존 prices 사용: ${stockCode} = ${priceInfo.price}원`);
        return priceInfo.price;
      }
      return 0;
    } catch (error) {
      console.error(`[최신 현재가 조회] 실패: ${stockCode}`, error);
      // 조회 실패 시 기존 prices에서 찾기
      const priceInfo = prices.find(p => p.stockCode === stockCode);
      if (priceInfo?.price > 0) {
        console.log(`[최신 현재가 조회] 기존 prices 사용 (에러 후): ${stockCode} = ${priceInfo.price}원`);
        return priceInfo.price;
      }
      return 0;
    }
  }, [prices]);

  useEffect(() => {
    if (!repeatAutoTradingDialogOpen || !repeatAutoTradingForm.infiniteEnabled) return;
    if (String(repeatAutoTradingForm.buyEntry || '').trim()) return;
    const next = computeInfiniteBuyEntryValue();
    if (!next) return;
    setRepeatAutoTradingForm((prev) => (
      String(prev.buyEntry || '').trim() ? prev : { ...prev, buyEntry: next }
    ));
  }, [
    repeatAutoTradingDialogOpen,
    repeatAutoTradingForm.infiniteEnabled,
    repeatAutoTradingForm.buyEntry,
    currentPriceForAutoTrading,
    computeInfiniteBuyEntryValue,
  ]);

  // 의존성 배열용 값들 추출 (복잡한 표현식 분리)
  const buyStagesDeps = useMemo(() => 
    repeatAutoTradingForm.buyStages.map(s => `${s.dropRate}-${s.buyTotal}`).join(','),
    [repeatAutoTradingForm.buyStages]
  );
  const sellStagesDeps = useMemo(() => 
    repeatAutoTradingForm.sellStages.map(s => s.profitRate).join(','),
    [repeatAutoTradingForm.sellStages]
  );

  // 계산된 매수가/매도가를 상태에 반영 (무한 루프 방지)
  useEffect(() => {
    if (!currentPriceForAutoTrading || currentPriceForAutoTrading <= 0) return;
    
    const { buyStages, sellStages } = calculateBuySellPrices();
    
    // 이전 값과 비교해서 실제로 변경된 경우에만 업데이트
    // 단, buyEnd가 'Y'인 경우는 buyPrice와 buyQty를 업데이트하지 않음
    setRepeatAutoTradingForm(prev => {
      const buyChanged = prev.buyStages.some((stage, idx) => {
        // buyEnd가 'Y'인 경우는 변경 체크에서 제외
        if (stage.buyEnd === 'Y') {
          return false;
        }
        return stage.buyPrice !== buyStages[idx]?.buyPrice || 
               stage.buyQty !== buyStages[idx]?.buyQty;
      });
      const sellChanged = prev.sellStages.some((stage, idx) => 
        stage.sellPrice !== sellStages[idx]?.sellPrice ||
        stage.sellQty !== sellStages[idx]?.sellQty
      );
      
      if (!buyChanged && !sellChanged) {
        return prev;
      }
      
      return {
        ...prev,
        buyStages: buyStages.map((stage, idx) => {
          const prevStage = prev.buyStages[idx];
          // buyEnd가 'Y'인 경우는 저장된 buyPrice와 buyQty를 그대로 유지
          if (prevStage?.buyEnd === 'Y') {
            return {
              ...prevStage,
              // buyPrice와 buyQty는 저장된 값 유지
            };
          }
          return {
            ...prevStage,
            buyPrice: stage.buyPrice,
            buyQty: stage.buyQty
          };
        }),
        sellStages: sellStages.map((stage, idx) => ({
          ...prev.sellStages[idx],
          sellPrice: stage.sellPrice,
          sellQty: stage.sellQty
        }))
      };
    });
  }, [currentPriceForAutoTrading, buyStagesDeps, sellStagesDeps, calculateBuySellPrices]);

  // 깜박임 효과 (auto가 활성화된 종목이 있으면 깜박임)
  const hasAutoBuy = useMemo(() => {
    return autoTradingList.some(t => t.auto === 'Y');
  }, [autoTradingList]);

  // 선택된 종목 정보 메모이제이션
  const selectedStock = useMemo(() => 
    watchlist.find(item => item.stockCode === selectedStockCode) || null,
    [watchlist, selectedStockCode]
  );

  /** 다이얼로그·폼에서 사용할 시장 플래그 (선택 종목 기준) */
  const dialogIsUs = isUsMarketItem(targetBuyDialogStock || selectedStock);
  const dialogCurrencySymbol = dialogIsUs ? '$' : currencySymbol;

  useEffect(() => {
    if (hasAutoBuy) {
      const interval = setInterval(() => {
        setBlinking(prev => !prev);
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setBlinking(false);
    }
  }, [hasAutoBuy]);

  const content = (
    <>

      {/* 관심종목 리스트 */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box
          role="tablist"
          aria-label="관심종목 그룹"
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1,
            mb: 2,
          }}
        >
          {watchlistGroupNos.map((n) => {
            const selected = watchlistTab === n;
            return (
              <Button
                key={n}
                role="tab"
                aria-selected={selected}
                onClick={() => setWatchlistTab(n)}
                disableElevation
                variant="text"
                sx={{
                  flex: 1,
                  minWidth: 0,
                  py: 1.25,
                  px: 0.75,
                  borderRadius: 2.5,
                  border: 'none',
                  outline: 'none',
                  textTransform: 'none',
                  fontWeight: selected ? 700 : 600,
                  fontSize: '0.8125rem',
                  letterSpacing: '-0.01em',
                  boxShadow: 'none',
                  bgcolor: (theme) =>
                    selected ? alpha(theme.palette.primary.main, 0.14) : theme.palette.action.hover,
                  color: selected ? 'primary.main' : 'text.secondary',
                  transition: 'background-color 0.2s ease, color 0.2s ease',
                  '&:hover': {
                    boxShadow: 'none',
                    border: 'none',
                    bgcolor: (theme) =>
                      selected ? alpha(theme.palette.primary.main, 0.22) : theme.palette.action.selected,
                    color: selected ? 'primary.dark' : 'text.primary',
                  },
                  '&:focus-visible': {
                    boxShadow: (theme) => `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 4px ${theme.palette.primary.main}`,
                  },
                }}
              >
                {watchListNames[n] || `관심종목${n}`}
              </Button>
            );
          })}
        </Box>
        <TableContainer>
        <Table sx={{ tableLayout: 'fixed', width: '100%' }}>
          <TableHead>
            <TableRow sx={{ bgcolor: 'action.hover', '& .MuiTableCell-root': { py: 1.5 } }}>
              <TableCell padding="checkbox" sx={{ fontWeight: 'bold', fontSize: '0.875rem' }}></TableCell>
              <TableCell
                align="center"
                sx={{ fontWeight: 'bold', fontSize: '0.875rem', ...WATCHLIST_STRATEGY_COL_SX }}
              >
                전략유형
              </TableCell>
              <TableCell sx={{ fontWeight: 'bold', fontSize: '0.875rem' }}>종목</TableCell>
              <TableCell
                align="center"
                sx={{ fontWeight: 'bold', fontSize: '0.875rem', ...WATCHLIST_PRICE_COL_SX }}
              >
                현재가격
              </TableCell>
              <TableCell
                align="center"
                sx={{ fontWeight: 'bold', fontSize: '0.875rem', ...WATCHLIST_STAGE_COL_SX }}
              >
                Stage
              </TableCell>
              <TableCell
                align="center"
                sx={{ fontWeight: 'bold', fontSize: '0.875rem', ...WATCHLIST_TARGET_COL_SX }}
              >
                매수목표가
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold', fontSize: '0.875rem', ...WATCHLIST_MID_COL_SX }}>
                매수수량
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold', fontSize: '0.875rem', ...WATCHLIST_MID_COL_SX }}>
                차트
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold', fontSize: '0.875rem', ...WATCHLIST_MID_COL_SX }}>
                자동매매
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold', fontSize: '0.875rem', ...WATCHLIST_ICON_COL_SX }}>
                작업
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={10} align="center" sx={{ py: 4 }}>
                  <CircularProgress />
                  <Typography variant="body2" sx={{ mt: 2 }}>
                    관심종목을 불러오는 중...
                  </Typography>
                </TableCell>
              </TableRow>
            ) : watchlist.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} align="center" sx={{ py: 4 }}>
                  <Typography variant="body2" color="text.secondary">
                    추가된 관심종목이 없습니다. 아래 「종목추가 (KRX/US)」에서 종목을 추가해 보세요.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              watchlist.map((item) => {
                const codeKey = String(item.stockCode || '');
                const targetBuy =
                  autoTradingMap.get(codeKey) ||
                  autoTradingMap.get(codeKey.toUpperCase()) ||
                  (/^\d+$/.test(codeKey) && codeKey.length >= 6
                    ? autoTradingMap.get(codeKey.substring(0, 6))
                    : undefined);
                if (targetBuy) {
                  console.log(`[관심종목 렌더링] ${item.stockCode}(${item.stockName}): 매수목표가=${targetBuy.target_price}, 수량=${targetBuy.target_qty}`);
                }
                const rowIsUs = isUsMarket(item.stockMarket, item.stockCode);
                const strategyTypeLabel =
                  strategyTypeMap.get(codeKey) ||
                  strategyTypeMap.get(codeKey.toUpperCase()) ||
                  strategyTypeMap.get(codeKey.substring(0, 6)) ||
                  null;
                return (
                <WatchlistRow
                  key={`${item.stockMarket || (rowIsUs ? 'US' : 'KRX')}-${item.stockCode}`}
                  item={item}
                  priceInfo={
                    rowIsUs
                      ? priceMap.get(String(item.stockCode || '').toUpperCase()) || priceMap.get(item.stockCode)
                      : priceMap.get(String(item.stockCode || '').substring(0, 6)) || priceMap.get(item.stockCode)
                  }
                  targetBuy={targetBuy}
                  priceLoading={priceLoading}
                  selectedStockCode={selectedStockCode}
                  blinking={blinking}
                  onSelectStock={setSelectedStockCode}
                  onDeleteStock={handleDeleteStock}
                  hideNxtBadge={rowIsUs}
                  currencySymbol={rowIsUs ? '$' : '원'}
                  strategyTypeLabel={strategyTypeLabel}
                  onOpenChart={handleOpenChart}
                  onOpenRepeatAutoTrading={(stock) => {
                    setTargetBuyDialogStock(stock);
                    setRepeatAutoTradingDialogOpen(true);
                  }}
                />
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
      </Paper>

      {/* 반복자동매매설정 버튼 */}
      {selectedStockCode && (
        <Box mb={2} display="flex" justifyContent="flex-end">
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              if (selectedStock) {
                setTargetBuyDialogStock(selectedStock);
              }
              setRepeatAutoTradingDialogOpen(true);
            }}
            disabled={!selectedStockCode}
            startIcon={<SettingsIcon sx={{ color: '#000000', fontSize: '1.25rem' }} />}
            sx={{
              '& .MuiButton-startIcon': { color: '#000000' },
              '& .MuiButton-startIcon > *:nth-of-type(1)': { fontSize: '1.25rem' },
            }}
          >
            자동매매 설정
          </Button>
        </Box>
      )}

      {errorMessage && (
        <Alert severity="warning" sx={{ mb: 3 }} onClose={() => setErrorMessage(null)}>
          {errorMessage}
        </Alert>
      )}

      {/* 종목 검색 및 추가 */}
      {!hideActions && (
        <Paper sx={{ p: 3, mb: 3 }}>
        <Typography
          variant="h6"
          gutterBottom
          sx={{
            fontWeight: 'bold',
            display: 'inline-flex',
            alignItems: 'flex-end',
            gap: 0.75,
            flexWrap: 'wrap',
          }}
        >
          <AddCircleOutlineIcon sx={{ fontSize: '1.05rem', mb: 0.35 }} />
          종목추가 (KRX/US)
          <Typography
            component="span"
            variant="caption"
            sx={{
              fontWeight: 400,
              ml: 0.5,
              color: '#81c784',
              lineHeight: 1.4,
              pb: 0.15,
            }}
          >
            입력하면 국내·미국 종목을 함께 검색합니다. 둘 다 나오면 아래에서 선택하세요.
          </Typography>
        </Typography>
        {user?.subscription !== 'Y' && user?.maxWatchlist != null && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            {`일반회원은 관심종목 ${user.maxWatchlist}개 · 자동매매 ON ${user.maxAutoTrading ?? 1}종목까지 사용할 수 있습니다. (프리미엄 구독 시 무제한)`}
          </Typography>
        )}
        <Grid container spacing={2} alignItems="flex-start">
          <Grid item xs={12} sm={8}>
            <TextField
              label="종목명 / 티커"
              fullWidth
              value={searchName}
              onChange={(e) => {
                const v = e.target.value;
                // 한글 포함 시 그대로, 영문·숫자만이면 티커용 대문자
                setSearchName(/[가-힣]/.test(v) ? v : v.toUpperCase());
              }}
              placeholder="예: 삼성전자, AAPL, TSLA"
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleAddStock();
                }
              }}
              InputProps={{
                endAdornment: searchingStock ? (
                  <InputAdornment position="end">
                    <CircularProgress size={20} />
                  </InputAdornment>
                ) : foundStockCode ? (
                  <InputAdornment position="end">
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mr: 0.5 }}>
                      {foundStockMarket && (
                        <Chip
                          size="small"
                          label={foundStockMarket === 'US' ? 'US · $' : 'KRX · 원'}
                          color={foundStockMarket === 'US' ? 'success' : 'primary'}
                          variant="outlined"
                          sx={{ height: 22, fontSize: '0.7rem' }}
                        />
                      )}
                      <Typography variant="body2" color="primary" sx={{ fontWeight: 'bold' }}>
                        {foundStockCode}
                      </Typography>
                    </Box>
                  </InputAdornment>
                ) : null
              }}
              helperText={
                searchingStock
                  ? '종목 정보를 검색하는 중...'
                  : foundStockCode
                    ? `종목명: ${foundStockName || searchName}${
                        foundStockMarket
                          ? ` · ${foundStockMarket === 'US' ? '미국($)' : '국내(원)'}`
                          : ''
                      }`
                    : undefined
              }
            />
            {searchCandidates.length > 1 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
                {searchCandidates.map((c) => {
                  const selected =
                    foundStockCode === c.stockCode && foundStockMarket === c.stockMarket;
                  return (
                    <Chip
                      key={`${c.stockMarket}-${c.stockCode}`}
                      clickable
                      color={selected ? (c.stockMarket === 'US' ? 'success' : 'primary') : 'default'}
                      variant={selected ? 'filled' : 'outlined'}
                      label={`${c.stockName} (${c.stockCode}) · ${c.stockMarket}${
                        c.stockMarket === 'US' ? ' · $' : ' · 원'
                      }`}
                      onClick={() => applyFoundStock(c)}
                    />
                  );
                })}
              </Box>
            )}
          </Grid>
          <Grid item xs={12} sm={4}>
            <Button
              variant="contained"
              startIcon={<SearchIcon />}
              onClick={handleAddStock}
              disabled={loading || !searchName.trim()}
              fullWidth
              sx={{ height: '56px' }}
            >
              추가
            </Button>
          </Grid>
        </Grid>
      </Paper>
      )}

      <StockDailyChartDialog
        open={chartDialogOpen}
        onClose={() => {
          setChartDialogOpen(false);
          setChartDialogStock(null);
        }}
        stockCode={chartDialogStock?.stockCode}
        stockName={chartDialogStock?.stockName}
        stockMarket={chartDialogStock?.stockMarket === 'US' ? 'US' : chartDialogStock?.stockMarket}
        stexTp={chartDialogStock?.exchange || chartDialogStock?.stexTp}
        buyLevels={chartBuyLevels}
        tradeMarkers={chartTradeMarkers}
        enableTradingOverlays
      />

      {/* 반복자동매매설정 다이얼로그 */}
      <Dialog
        open={repeatAutoTradingDialogOpen}
        onClose={() => setRepeatAutoTradingDialogOpen(false)}
        maxWidth="xl"
        fullWidth
        PaperProps={{
          sx: { 
            width: '110%',
            maxWidth: 'calc(1280px * 1.05) !important',
          }
        }}
      >
        <DialogTitle component="div" sx={{ pb: 1 }}>
          <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
            <Typography variant="h6" component="div" sx={{ fontWeight: 700, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: 0.6 }}>
              <SettingsIcon
                sx={{
                  fontSize: '1.25rem',
                  color: '#ff9800',
                }}
                aria-hidden
              />
              반복자동 매매설정 Ver.2
            </Typography>
            {targetBuyDialogStock && (
              <Typography variant="body2" color="text.secondary">
                {targetBuyDialogStock.stockName} ({targetBuyDialogStock.stockCode})
              </Typography>
            )}
          </Box>
        </DialogTitle>
        <DialogContent
          sx={{
            pt: 1.5,
            pb: 2.5,
            '& .MuiInputBase-input': {
              textAlign: 'right',
            },
          }}
        >
          <Box sx={{ mt: 1 }}>
            {/* 저장된 파일 불러오기 메시지 */}
            {autoTradingLoadMessage && (
              <Alert severity="success" sx={{ mb: 2 }} onClose={() => setAutoTradingLoadMessage('')}>
                {autoTradingLoadMessage}
              </Alert>
            )}

            {/* 자동매매 활성화 */}
            <Box sx={{ mb: 0.5 }}>
              <Box display="flex" alignItems="center" flexWrap="wrap" gap={2} sx={{ width: '100%' }}>
                {targetBuyDialogStock && (() => {
                  const dialogCode = String(targetBuyDialogStock.stockCode || '');
                  const dialogIsUs = isUsMarket(targetBuyDialogStock.stockMarket, dialogCode);
                  const priceInfo = prices.find((p) => {
                    const pc = String(p.stockCode || '');
                    if (dialogIsUs) return pc.toUpperCase() === dialogCode.toUpperCase();
                    return pc === dialogCode || pc.substring(0, 6) === dialogCode.substring(0, 6);
                  });
                  const currentPrice = priceInfo?.price || 0;
                  const currentPriceColor = currentPrice > 0
                    ? getRiseFallColor(priceInfo?.change, priceInfo?.changeRate)
                    : 'text.secondary';
                  return (
                    <Box
                      display="flex"
                      alignItems="center"
                      gap={3}
                      flexWrap="wrap"
                      sx={{ flex: 1, minWidth: 280, justifyContent: 'flex-start' }}
                    >
                      <Box>
                        <Typography variant="body1" color="text.secondary" sx={{ mb: 0.5 }}>
                          종목코드
                        </Typography>
                        <Typography variant="body1" sx={{ fontWeight: 'bold', fontSize: '1.1rem' }}>
                          {targetBuyDialogStock.stockCode}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="body1" color="text.secondary" sx={{ mb: 0.5 }}>
                          종목명
                        </Typography>
                        <Typography variant="body1" sx={{ fontWeight: 'bold', fontSize: '1.1rem' }}>
                          {targetBuyDialogStock.stockName}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="body1" color="text.secondary" sx={{ mb: 0.5 }}>
                          현재가
                        </Typography>
                        <Typography variant="body1" sx={{ fontWeight: 'bold', fontSize: '1.1rem', color: currentPriceColor }}>
                          {currentPrice > 0
                            ? dialogCurrencySymbol === '$'
                              ? `$${currentPrice.toLocaleString()}`
                              : `${currentPrice.toLocaleString()}원`
                            : '-'}
                        </Typography>
                      </Box>
                      {/* Buy/Sell Trailing — 오른쪽 정렬 */}
                      <Box
                        display="flex"
                        alignItems="center"
                        gap={2}
                        flexWrap="wrap"
                        sx={{ ml: 'auto', alignSelf: 'flex-end', pb: 0.25 }}
                      >
                        <Box display="flex" alignItems="center" gap={0.75}>
                          <TrendingDownIcon sx={{ color: 'error.main', fontSize: '1.2rem' }} />
                          <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                            Buy Trailing
                          </Typography>
                          <TextField
                            type="text"
                            inputMode="decimal"
                            size="small"
                            value={repeatAutoTradingForm.buyTrailingStopPercent ?? ''}
                            onChange={(e) => {
                              const next = sanitizeDecimalPercentInput(e.target.value);
                              if (next === null) return;
                              setRepeatAutoTradingForm({ ...repeatAutoTradingForm, buyTrailingStopPercent: next });
                            }}
                            sx={{ width: 64, '& input': { fontSize: '0.875rem' } }}
                          />
                        </Box>
                        <Box display="flex" alignItems="center" gap={0.75}>
                          <TrendingUpIcon sx={{ color: 'success.main', fontSize: '1.2rem' }} />
                          <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                            Sell Trailing
                          </Typography>
                          <TextField
                            type="text"
                            inputMode="decimal"
                            size="small"
                            value={repeatAutoTradingForm.trailingStopPercent ?? ''}
                            onChange={(e) => {
                              const next = sanitizeDecimalPercentInput(e.target.value);
                              if (next === null) return;
                              setRepeatAutoTradingForm({ ...repeatAutoTradingForm, trailingStopPercent: next });
                            }}
                            sx={{ width: 64, '& input': { fontSize: '0.875rem' } }}
                          />
                        </Box>
                      </Box>
                    </Box>
                  );
                })()}
              </Box>
              <Box
                sx={{
                  mt: 1.5,
                  pt: 1,
                  borderTop: '1px solid',
                  borderColor: 'divider',
                  display: 'grid',
                  columnGap: 1,
                  gridTemplateColumns: { xs: '1fr', md: '3.5fr 3.2fr 4.3fr' },
                  alignItems: 'center',
                }}
              >
                <FormControlLabel
                  sx={{ justifySelf: 'start' }}
                  control={
                    <Checkbox
                      checked={!!repeatAutoTradingForm.splitAutoEnabled}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        setRepeatAutoTradingForm((prev) => ({ ...prev, splitAutoEnabled: enabled }));
                      }}
                    />
                  }
                  label={<Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>분할 자동매매 활성화</Typography>}
                />
                <FormControlLabel
                  sx={{ gridColumn: { md: 3 }, ml: 0, justifySelf: 'start' }}
                  control={
                    <Checkbox
                      checked={!!repeatAutoTradingForm.infiniteAutoEnabled}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        setRepeatAutoTradingForm((prev) => ({ ...prev, infiniteAutoEnabled: enabled }));
                      }}
                    />
                  }
                  label={<Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>무한 자동매매 활성화</Typography>}
                />
              </Box>
            </Box>

            <Box
              sx={{
                display: 'grid',
                gap: 1,
                columnGap: 1,
                gridTemplateColumns: { xs: '1fr', md: '3.5fr 3.2fr 4.3fr' },
                alignItems: 'stretch',
              }}
            >
              {/* 분할(매수+매도) 묶음 테두리 */}
              <Box
                sx={{
                  gridColumn: { md: 'span 2' },
                  display: 'grid',
                  gap: 1,
                  gridTemplateColumns: { xs: '1fr', md: '3.5fr 3.2fr' },
                  alignItems: 'stretch',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  minWidth: 0,
                }}
              >
              {/* 자동매수 (분할매수) 섹션 */}
              <Box sx={{ minWidth: 0 }}>
                <Paper
                  aria-disabled={!repeatAutoTradingForm.splitAutoEnabled}
                  sx={{
                    p: 2,
                    height: '100%',
                    ...(!repeatAutoTradingForm.splitAutoEnabled ? V2_DISABLED_PANEL_SX : {}),
                  }}
                >
                  <Box display="flex" alignItems="center" gap={0.5} sx={{ minHeight: 42, mb: 0.5 }}>
                    <Checkbox
                      size="small"
                      checked={!repeatAutoTradingForm.infiniteEnabled}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setRepeatAutoTradingForm({
                            ...repeatAutoTradingForm,
                            infiniteEnabled: false,
                          });
                        }
                      }}
                      sx={{ p: 0.5 }}
                    />
                    <Typography
                      variant="subtitle1"
                      component="span"
                      onClick={() =>
                        setRepeatAutoTradingForm({
                          ...repeatAutoTradingForm,
                          infiniteEnabled: false,
                        })
                      }
                      sx={{
                        fontWeight: 'bold',
                        fontSize: '0.95rem',
                        cursor: 'pointer',
                        userSelect: 'none',
                        color: !repeatAutoTradingForm.infiniteEnabled
                          ? 'text.primary'
                          : 'text.disabled',
                      }}
                    >
                      편집·저장
                    </Typography>
                    <Box sx={{ width: 8, flexShrink: 0 }} aria-hidden />
                    <TrendingDownIcon
                      sx={{
                        color: !repeatAutoTradingForm.infiniteEnabled
                          ? 'error.main'
                          : 'text.disabled',
                        fontSize: '1.35rem',
                      }}
                    />
                    <Typography
                      variant="subtitle1"
                      component="span"
                      onClick={() =>
                        setRepeatAutoTradingForm({
                          ...repeatAutoTradingForm,
                          infiniteEnabled: false,
                        })
                      }
                      sx={{
                        fontWeight: 'bold',
                        fontSize: '0.95rem',
                        cursor: 'pointer',
                        userSelect: 'none',
                        color: !repeatAutoTradingForm.infiniteEnabled
                          ? 'text.primary'
                          : 'text.disabled',
                      }}
                    >
                      자동매수 (분할매수)
                    </Typography>
                  </Box>
                  <TableContainer
                    sx={{
                      opacity: !repeatAutoTradingForm.infiniteEnabled ? 1 : 0.55,
                      pointerEvents: !repeatAutoTradingForm.infiniteEnabled ? 'auto' : 'none',
                    }}
                  >
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 'bold', fontSize: '0.875rem', whiteSpace: 'nowrap' }}>차수</TableCell>
                          <TableCell sx={{ fontWeight: 'bold', fontSize: '0.875rem' }}>
                            조건 / 매수총액
                          </TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {repeatAutoTradingForm.buyStages.slice(0, 5).map((stage, idx) => (
                          <TableRow key={stage.stage}>
                            <TableCell sx={{ fontSize: '0.875rem' }}>
                              {`${stage.stage} 차`}
                            </TableCell>
                            <TableCell>
                              {stage.buyEnd === 'Y' ? (
                                <Box display="flex" alignItems="center" gap={1} sx={{ height: '40px' }}>
                                  <Typography variant="body2" sx={{ fontSize: '0.875rem', color: 'success.main', fontWeight: 'bold' }}>
                                    {formatPriceWithCurrency(parseFloat(stage.buyPrice || 0), dialogCurrencySymbol)} / {parseInt(stage.buyQty || 0)}주
                                  </Typography>
                                  <Typography variant="body2" sx={{ fontSize: '0.8rem', color: 'success.main', fontWeight: 'bold' }}>
                                    매수완료
                                  </Typography>
                                </Box>
                              ) : (
                                <Box display="flex" alignItems="center" gap={0.5} flexWrap="nowrap">
                                  <Typography
                                    variant="body2"
                                    sx={{
                                      fontSize: '0.8rem',
                                      whiteSpace: 'nowrap',
                                      flexShrink: 0,
                                    }}
                                  >
                                    {idx === 0 ? '진입' : `${idx} 차`}
                                  </Typography>
                                  <TextField
                                    type="text"
                                    inputMode="decimal"
                                    size="small"
                                    value={
                                      stage.dropRate === 0 || stage.dropRate === ''
                                        ? ''
                                        : `-${String(stage.dropRate).replace(/^[-−﹣]+/, '')}`
                                    }
                                    onChange={(e) => {
                                      // 입력칸의 - 는 표시용 — 숫자만 받아 양수로 보관, 저장 시 음수
                                      const raw = String(e.target.value ?? '').replace(/^[-−﹣]+/, '');
                                      const next = sanitizeDecimalPercentInput(raw);
                                      if (next === null) return;
                                      const newBuyStages = [...repeatAutoTradingForm.buyStages];
                                      newBuyStages[idx].dropRate = next;
                                      setRepeatAutoTradingForm({ ...repeatAutoTradingForm, buyStages: newBuyStages });
                                    }}
                                    sx={{
                                      width: 64,
                                      flexShrink: 0,
                                      '& .MuiInputBase-root': { height: 32 },
                                      '& input': { fontSize: '0.8rem', py: 0.5 },
                                    }}
                                  />
                                  <Typography
                                    variant="body2"
                                    sx={{
                                      fontSize: '0.75rem',
                                      whiteSpace: 'nowrap',
                                      flexShrink: 0,
                                    }}
                                  >
                                    {idx === 0 ? '% 1차매수' : `% ${stage.stage}차매수`}
                                  </Typography>
                                  <TextField
                                    type="text"
                                    size="small"
                                    value={stage.buyTotal ? formatNumber(stage.buyTotal) : ''}
                                    onChange={(e) => {
                                      const rawValue = e.target.value.replace(/,/g, '').replace(/[^0-9]/g, '');
                                      const value = rawValue ? parseInt(rawValue, 10) : 0;
                                      const newBuyStages = [...repeatAutoTradingForm.buyStages];
                                      newBuyStages[idx].buyTotal = value;
                                      setRepeatAutoTradingForm({ ...repeatAutoTradingForm, buyStages: newBuyStages });
                                    }}
                                    InputProps={{
                                      endAdornment: (
                                        <Typography variant="caption" sx={{ mr: 0.5, fontSize: '0.65rem' }}>
                                          {dialogCurrencySymbol}
                                        </Typography>
                                      ),
                                    }}
                                    sx={{
                                      width: 110,
                                      ml: 0.25,
                                      flexShrink: 0,
                                      '& .MuiInputBase-root': { height: 32 },
                                      '& input': { fontSize: '0.8rem', textAlign: 'right', py: 0.5 },
                                    }}
                                  />
                                </Box>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  {swingResultMessage ? (
                    <Box sx={{ mt: 1.25, px: 0.5 }}>
                      {swingResultMessage.split(' · ').map((line, i) => (
                        <Typography
                          key={i}
                          variant="caption"
                          component="div"
                          title={swingResultMessage}
                          sx={{
                            lineHeight: 1.45,
                            color: 'success.light',
                            wordBreak: 'keep-all',
                          }}
                        >
                          {line}
                        </Typography>
                      ))}
                    </Box>
                  ) : null}
                </Paper>
              </Box>

              {/* 자동매도 (이익청산) 섹션 */}
              <Box sx={{ minWidth: 0 }}>
                <Paper
                  aria-disabled={!repeatAutoTradingForm.splitAutoEnabled}
                  sx={{
                    p: 2,
                    height: '100%',
                    ...(!repeatAutoTradingForm.splitAutoEnabled ? V2_DISABLED_PANEL_SX : {}),
                  }}
                >
                  <Box display="flex" alignItems="center" gap={0.5} sx={{ minHeight: 42, mb: 0.5 }}>
                    <TrendingUpIcon
                      sx={{
                        color: !repeatAutoTradingForm.infiniteEnabled
                          ? 'success.main'
                          : 'text.disabled',
                        fontSize: '1.35rem',
                      }}
                    />
                    <Typography
                      variant="subtitle1"
                      component="span"
                      onClick={() =>
                        setRepeatAutoTradingForm({
                          ...repeatAutoTradingForm,
                          infiniteEnabled: false,
                        })
                      }
                      sx={{
                        fontWeight: 'bold',
                        fontSize: '0.95rem',
                        cursor: 'pointer',
                        userSelect: 'none',
                        color: !repeatAutoTradingForm.infiniteEnabled
                          ? 'text.primary'
                          : 'text.disabled',
                      }}
                    >
                      자동매도 (이익청산)
                    </Typography>
                  </Box>
                  <TableContainer
                    sx={{
                      opacity: !repeatAutoTradingForm.infiniteEnabled ? 1 : 0.55,
                      pointerEvents: !repeatAutoTradingForm.infiniteEnabled ? 'auto' : 'none',
                    }}
                  >
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 'bold', fontSize: '0.875rem', whiteSpace: 'nowrap' }}>차수</TableCell>
                          <TableCell sx={{ fontWeight: 'bold', fontSize: '0.875rem' }}>조건</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {repeatAutoTradingForm.sellStages.slice(0, 5).map((stage, idx) => (
                          <TableRow key={stage.stage}>
                            <TableCell sx={{ fontSize: '0.875rem' }}>
                              {`${stage.stage} 차`}
                            </TableCell>
                            <TableCell>
                              <Box
                                display="flex"
                                alignItems="center"
                                gap={0.5}
                                flexWrap="nowrap"
                              >
                                <TextField
                                  type="text"
                                  inputMode="decimal"
                                  size="small"
                                  value={stage.profitRate === 0 || stage.profitRate === '' ? '' : String(stage.profitRate)}
                                  onChange={(e) => {
                                    const next = sanitizeDecimalPercentInput(e.target.value);
                                    if (next === null) return;
                                    const newSellStages = [...repeatAutoTradingForm.sellStages];
                                    newSellStages[idx].profitRate = next;
                                    setRepeatAutoTradingForm({ ...repeatAutoTradingForm, sellStages: newSellStages });
                                  }}
                                  sx={{
                                    width: 64,
                                    flexShrink: 0,
                                    '& .MuiInputBase-root': { height: 32 },
                                    '& input': {
                                      fontSize: '0.8rem',
                                      py: 0.5,
                                    },
                                  }}
                                />
                                <Typography
                                  variant="body2"
                                  sx={{
                                    fontSize: '0.72rem',
                                    whiteSpace: 'nowrap',
                                    flexShrink: 0,
                                  }}
                                >
                                  {`% 수익이면 ${stage.stage}차 매도`}
                                </Typography>
                              </Box>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Paper>
              </Box>
              </Box>

              {/* 무한매수 설정 */}
              <Box sx={{ minWidth: 0 }}>
                <Paper
                  aria-disabled={!repeatAutoTradingForm.infiniteAutoEnabled}
                  sx={{
                    p: 2,
                    height: '100%',
                    border: '1px solid',
                    borderColor: 'divider',
                    ...(!repeatAutoTradingForm.infiniteAutoEnabled ? V2_DISABLED_PANEL_SX : {}),
                  }}
                >
                  <Box display="flex" alignItems="center" gap={0.5} sx={{ minHeight: 42, mb: 0.5, width: '100%' }}>
                    <Checkbox
                      size="small"
                      checked={!!repeatAutoTradingForm.infiniteEnabled}
                      onChange={(e) => setInfiniteEnabled(e.target.checked)}
                      sx={{ p: 0.5 }}
                    />
                    <Typography
                      variant="subtitle1"
                      component="span"
                      onClick={() => setInfiniteEnabled(!repeatAutoTradingForm.infiniteEnabled)}
                      sx={{
                        fontWeight: 'bold',
                        fontSize: '0.95rem',
                        cursor: 'pointer',
                        userSelect: 'none',
                        color: repeatAutoTradingForm.infiniteEnabled ? 'text.primary' : 'text.disabled',
                      }}
                    >
                      편집·저장
                    </Typography>
                    <Box sx={{ width: 8, flexShrink: 0 }} aria-hidden />
                    <AllInclusiveIcon
                      sx={{
                        fontSize: '1.35rem',
                        color: repeatAutoTradingForm.infiniteEnabled ? 'primary.main' : 'text.disabled',
                      }}
                    />
                    <Typography
                      variant="subtitle1"
                      component="span"
                      onClick={() => setInfiniteEnabled(!repeatAutoTradingForm.infiniteEnabled)}
                      sx={{
                        fontWeight: 'bold',
                        fontSize: '0.95rem',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                    >
                      무한매수
                    </Typography>
                    {tradingPlans.some(
                      (p) =>
                        matchTradingPlanSymbol(p, targetBuyDialogStock?.stockCode) &&
                        p.strategyType === 'INFINITE_TRADE' &&
                        p.status === 'active'
                    ) && (
                      <Box
                        component="span"
                        sx={{ ml: 'auto', fontSize: '0.85rem', lineHeight: 1, flexShrink: 0 }}
                        aria-label="무한매매 활성"
                      >
                        🟢
                      </Box>
                    )}
                  </Box>
                  {(() => {
                    const multipliers = repeatAutoTradingForm.buyMultipliers?.length
                      ? repeatAutoTradingForm.buyMultipliers
                      : DEFAULT_INFINITE_BUY_MULTIPLIERS;
                    const handleMultiplierChange = (idx) => (e) => {
                      const prev = repeatAutoTradingForm.buyMultipliers?.length
                        ? [...repeatAutoTradingForm.buyMultipliers]
                        : [...DEFAULT_INFINITE_BUY_MULTIPLIERS];
                      prev[idx] = String(e.target.value);
                      setRepeatAutoTradingForm({
                        ...repeatAutoTradingForm,
                        buyMultipliers: prev,
                      });
                    };
                    return (
                  <Box
                    sx={{
                      opacity: repeatAutoTradingForm.infiniteEnabled ? 1 : 0.55,
                      pointerEvents: repeatAutoTradingForm.infiniteEnabled ? 'auto' : 'none',
                    }}
                  >
                    <Box
                      display="flex"
                      alignItems="center"
                      justifyContent="space-between"
                      gap={1}
                      flexWrap="wrap"
                      sx={{
                        pb: 0.5,
                        mb: 0.5,
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                      }}
                    >
                      <Box display="flex" alignItems="center" gap={0.75} sx={{ minWidth: 0 }}>
                        <Typography
                          variant="body2"
                          sx={{ fontSize: '0.8rem', color: 'text.secondary', whiteSpace: 'nowrap' }}
                        >
                          시드금액
                        </Typography>
                        <TextField
                          type="text"
                          inputMode={dialogIsUs ? 'decimal' : 'numeric'}
                          size="small"
                          value={
                            dialogIsUs
                              ? repeatAutoTradingForm.seedAmount || ''
                              : formatOrderAmountDisplay(
                                  repeatAutoTradingForm.seedAmount,
                                  false
                                )
                          }
                          onChange={(e) => {
                            const rawValue = sanitizeOrderAmountInput(
                              e.target.value,
                              dialogIsUs
                            );
                            setRepeatAutoTradingForm({
                              ...repeatAutoTradingForm,
                              seedAmount: rawValue,
                            });
                          }}
                          onBlur={() => {
                            if (!dialogIsUs) return;
                            const n = parseOrderAmountValue(
                              repeatAutoTradingForm.seedAmount,
                              true
                            );
                            setRepeatAutoTradingForm((prev) => ({
                              ...prev,
                              seedAmount: n > 0 ? n.toFixed(2) : prev.seedAmount,
                            }));
                          }}
                          InputProps={{
                            endAdornment: (
                              <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'text.secondary' }}>
                                {dialogCurrencySymbol}
                              </Typography>
                            ),
                          }}
                          sx={{ width: 108, ...INFINITE_PILL_INPUT_SX }}
                        />
                      </Box>
                      <Box display="flex" alignItems="center" gap={0.75} sx={{ minWidth: 0 }}>
                        <Typography
                          variant="body2"
                          sx={{ fontSize: '0.8rem', color: 'text.secondary', whiteSpace: 'nowrap' }}
                        >
                          1회매수
                        </Typography>
                        <TextField
                          type="text"
                          inputMode={dialogIsUs ? 'decimal' : 'numeric'}
                          size="small"
                          value={
                            dialogIsUs
                              ? repeatAutoTradingForm.unitBuyAmount || ''
                              : formatOrderAmountDisplay(
                                  repeatAutoTradingForm.unitBuyAmount,
                                  false
                                )
                          }
                          onChange={(e) => {
                            const rawValue = sanitizeOrderAmountInput(
                              e.target.value,
                              dialogIsUs
                            );
                            setRepeatAutoTradingForm({
                              ...repeatAutoTradingForm,
                              unitBuyAmount: rawValue,
                            });
                          }}
                          onBlur={() => {
                            if (!dialogIsUs) return;
                            const n = parseOrderAmountValue(
                              repeatAutoTradingForm.unitBuyAmount,
                              true
                            );
                            setRepeatAutoTradingForm((prev) => ({
                              ...prev,
                              unitBuyAmount: n > 0 ? n.toFixed(2) : prev.unitBuyAmount,
                            }));
                          }}
                          InputProps={{
                            endAdornment: (
                              <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'text.secondary' }}>
                                {dialogCurrencySymbol}
                              </Typography>
                            ),
                          }}
                          sx={{ width: 100, ...INFINITE_PILL_INPUT_SX }}
                        />
                      </Box>
                      <Box display="flex" alignItems="center" gap={0.75} sx={{ minWidth: 0 }}>
                        <Typography
                          variant="body2"
                          sx={{ fontSize: '0.8rem', color: 'text.secondary', whiteSpace: 'nowrap' }}
                        >
                          단계간격
                        </Typography>
                        <TextField
                          type="text"
                          inputMode="decimal"
                          size="small"
                          value={repeatAutoTradingForm.buyStepPercent ?? ''}
                          onChange={(e) => {
                            const next = sanitizeDecimalPercentInput(e.target.value);
                            if (next === null) return;
                            setRepeatAutoTradingForm({
                              ...repeatAutoTradingForm,
                              buyStepPercent: next,
                            });
                          }}
                          InputProps={{
                            endAdornment: (
                              <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'text.secondary' }}>
                                %
                              </Typography>
                            ),
                          }}
                          sx={{ width: 72, ...INFINITE_PILL_INPUT_SX }}
                        />
                      </Box>
                    </Box>

                    <Typography
                      variant="body2"
                      sx={{
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        mt: 2.1,
                        pt: 0.5,
                        pb: 0.75,
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                      }}
                    >
                      단계별 배수
                    </Typography>
                    {multipliers.slice(0, 2).map((mult, idx) => (
                      <Box
                        key={`buy-mult-row-${idx}`}
                        display="grid"
                        sx={{
                          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                          columnGap: 2,
                          pl: 2,
                          borderBottom: '1px solid',
                          borderColor: 'divider',
                        }}
                      >
                        <InfiniteBandRow
                          label={infiniteBuyBandLabel(idx, repeatAutoTradingForm.buyStepPercent, multipliers.length)}
                          value={mult}
                          onChange={handleMultiplierChange(idx)}
                          labelColor={infiniteBandLabelColor(idx)}
                        />
                        {multipliers[idx + 2] != null && (
                          <InfiniteBandRow
                            label={infiniteBuyBandLabel(idx + 2, repeatAutoTradingForm.buyStepPercent, multipliers.length)}
                            value={multipliers[idx + 2]}
                            onChange={handleMultiplierChange(idx + 2)}
                            labelColor={infiniteBandLabelColor(idx + 2)}
                          />
                        )}
                      </Box>
                    ))}
                    {multipliers.slice(4).map((mult, sliceIdx) => {
                      const idx = sliceIdx + 4;
                      return (
                        <Box
                          key={`buy-mult-row-${idx}`}
                          display="grid"
                          sx={{
                            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                            columnGap: 2,
                            pl: 2,
                            borderBottom: '1px solid',
                            borderColor: 'divider',
                          }}
                        >
                          <Box />
                          <InfiniteBandRow
                            label={infiniteBuyBandLabel(idx, repeatAutoTradingForm.buyStepPercent, multipliers.length)}
                            value={mult}
                            onChange={handleMultiplierChange(idx)}
                            labelColor={infiniteBandLabelColor(idx)}
                          />
                        </Box>
                      );
                    })}

                    <Box
                      display="flex"
                      alignItems="center"
                      justifyContent="space-between"
                      sx={{
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                        py: 0.7,
                        minHeight: 44,
                      }}
                    >
                      <Typography variant="body2" sx={{ fontSize: '0.8rem', flexShrink: 0 }}>
                        진입가격
                      </Typography>
                      <TextField
                        type="text"
                        inputMode={dialogIsUs ? 'decimal' : 'numeric'}
                        size="small"
                        disabled={!!repeatAutoTradingForm.infiniteInProgress}
                        title={
                          repeatAutoTradingForm.infiniteInProgress
                            ? '무한매매 진행 중에는 진입가격을 변경할 수 없습니다.'
                            : undefined
                        }
                        value={
                          dialogIsUs
                            ? repeatAutoTradingForm.buyEntry || ''
                            : formatOrderAmountDisplay(repeatAutoTradingForm.buyEntry, false)
                        }
                        onChange={(e) => {
                          const rawValue = sanitizeOrderAmountInput(e.target.value, dialogIsUs);
                          setRepeatAutoTradingForm({
                            ...repeatAutoTradingForm,
                            buyEntry: rawValue,
                          });
                        }}
                        onBlur={() => {
                          if (!dialogIsUs) return;
                          const n = parseOrderAmountValue(repeatAutoTradingForm.buyEntry, true);
                          setRepeatAutoTradingForm((prev) => ({
                            ...prev,
                            buyEntry: n > 0 ? n.toFixed(2) : prev.buyEntry,
                          }));
                        }}
                        InputProps={{
                          endAdornment: (
                            <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'text.secondary' }}>
                              {dialogCurrencySymbol}
                            </Typography>
                          ),
                        }}
                        sx={{ width: 120, ...INFINITE_PILL_INPUT_SX }}
                      />
                    </Box>
                    <Box
                      display="flex"
                      alignItems="center"
                      justifyContent="space-between"
                      sx={{
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                        py: 0.7,
                        minHeight: 44,
                      }}
                    >
                      <Typography variant="body2" sx={{ fontSize: '0.8rem', flexShrink: 0 }}>
                        익절
                      </Typography>
                      <TextField
                        type="text"
                        inputMode="decimal"
                        size="small"
                        value={repeatAutoTradingForm.sellTargetPercent ?? ''}
                        onChange={(e) => {
                          const next = sanitizeDecimalPercentInput(e.target.value);
                          if (next === null) return;
                          setRepeatAutoTradingForm({ ...repeatAutoTradingForm, sellTargetPercent: next });
                        }}
                        InputProps={{
                          endAdornment: (
                            <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'text.secondary' }}>
                              %
                            </Typography>
                          ),
                        }}
                        sx={{ width: 100, ...INFINITE_PILL_INPUT_SX }}
                      />
                    </Box>
                  </Box>
                    );
                  })()}
                </Paper>
              </Box>
            </Box>

            {/* 스윙지점 / 취소·저장 */}
            <Box sx={{ mt: 2.5, mb: 0.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2 }}>
              <Button
                variant="outlined"
                onClick={handleFindSwingLows}
                disabled={swingFindLoading || !targetBuyDialogStock}
                startIcon={swingFindLoading ? <CircularProgress size={16} sx={{ color: '#e65100' }} /> : null}
                sx={{
                  color: '#e65100',
                  borderColor: '#e65100',
                  fontWeight: 600,
                  '&:hover': {
                    borderColor: '#bf360c',
                    bgcolor: 'rgba(230, 81, 0, 0.08)',
                    color: '#bf360c',
                  },
                  '&.Mui-disabled': {
                    borderColor: 'rgba(230, 81, 0, 0.35)',
                    color: 'rgba(230, 81, 0, 0.45)',
                  },
                }}
              >
                {swingFindLoading ? '스윙 분석 중…' : '스윙매매 (자동설정)'}
              </Button>
              <Box sx={{ display: 'flex', gap: 2 }}>
                <Button onClick={() => setRepeatAutoTradingDialogOpen(false)}>취소</Button>
                <Button 
                  onClick={async () => {
                  if (!targetBuyDialogStock || !user?.id) {
                    alert('종목 정보 또는 사용자 정보가 없습니다.');
                    return;
                  }

                  // 필수 필드 검증
                  const buyStages = repeatAutoTradingForm.buyStages.slice(0, 5);
                  const sellStages = repeatAutoTradingForm.sellStages.slice(0, 5);
                  const isInfinite = !!repeatAutoTradingForm.infiniteEnabled;

                  if (isInfinite) {
                    const seed = parseOrderAmountValue(
                      repeatAutoTradingForm.seedAmount,
                      dialogIsUs
                    );
                    const unit = parseOrderAmountValue(
                      repeatAutoTradingForm.unitBuyAmount,
                      dialogIsUs
                    );
                    if (!seed || seed <= 0) {
                      alert('무한매수 시드금액을 입력해주세요.');
                      return;
                    }
                    if (!unit || unit <= 0) {
                      alert('무한매수 1회 매수금을 입력해주세요.');
                      return;
                    }
                    if (parseRateValue(repeatAutoTradingForm.buyStepPercent) <= 0) {
                      alert('무한매수 단계 간격(buyStep)을 입력해주세요.');
                      return;
                    }
                  } else {
                    // 자동매수 활성화 시 검증 (분할)
                    if (repeatAutoTradingForm.autoBuyEnabled) {
                      for (let i = 0; i < 5; i++) {
                        const stage = buyStages[i];
                        if (parseRateValue(stage.dropRate) <= 0) {
                          alert(`${i + 1}차 자동매수 조건(%)을 입력해주세요.`);
                          return;
                        }
                      }
                      for (let i = 0; i < 5; i++) {
                        const stage = buyStages[i];
                        if (!stage.buyTotal || stage.buyTotal === 0) {
                          alert(`${i + 1}차 매수총액을 입력해주세요.`);
                          return;
                        }
                      }
                    }
                    if (repeatAutoTradingForm.autoSellEnabled) {
                      for (let i = 0; i < 5; i++) {
                        const stage = sellStages[i];
                        if (parseRateValue(stage.profitRate) <= 0) {
                          alert(`${i + 1}차 자동매도 조건(%)을 입력해주세요.`);
                          return;
                        }
                      }
                    }
                  }

                  try {
                    setErrorMessage(null);

                    // 저장 시점에 최신 현재가 조회
                    const stockMarket = targetBuyDialogStock.stockMarket || 'KRX';
                    const latestPrice = await fetchLatestPrice(targetBuyDialogStock.stockCode, stockMarket);

                    if (!latestPrice || latestPrice <= 0) {
                      alert('종목의 현재가를 가져올 수 없습니다. 잠시 후 다시 시도해주세요.');
                      return;
                    }

                    console.log(`[반복자동매매설정] 저장 시점 최신 현재가: ${latestPrice}원 (종목: ${targetBuyDialogStock.stockCode})`);

                    // ===== V2 → trading_plans =====
                    const { market, exchange, currency } = resolveV2MarketExchange(targetBuyDialogStock);
                    const buyTrailing = parsePercentFieldForSave(repeatAutoTradingForm.buyTrailingStopPercent, 0);
                    const sellTrailing = parsePercentFieldForSave(repeatAutoTradingForm.trailingStopPercent, 0);
                    const strategyType = isInfinite ? 'INFINITE_TRADE' : 'SPLIT_TRADE';
                    const editedEnabled = isInfinite
                      ? repeatAutoTradingForm.infiniteAutoEnabled
                      : repeatAutoTradingForm.splitAutoEnabled;
                    const status = editedEnabled ? 'active' : 'paused';
                    // 편집하지 않는 다른 전략 플랜: 체크 상태가 바뀐 경우만 status 반영
                    const otherCur = isInfinite
                      ? repeatAutoTradingForm.v2PlanStatus?.split
                      : repeatAutoTradingForm.v2PlanStatus?.infinite;
                    const otherEnabled = isInfinite
                      ? repeatAutoTradingForm.splitAutoEnabled
                      : repeatAutoTradingForm.infiniteAutoEnabled;
                    const otherPlanStatus =
                      otherCur && !!otherEnabled !== (otherCur.status === 'active')
                        ? { id: otherCur.id, status: otherEnabled ? 'active' : 'paused' }
                        : null;

                    const strategyConfig = {
                      buyTrailingPercent: buyTrailing,
                      sellTrailingPercent: sellTrailing,
                      maxStages: 5,
                      lastUserSaveAt: Date.now(),
                    };

                    let stages = [];
                    if (isInfinite) {
                      const marketKey = isUsMarketItem(targetBuyDialogStock) ? 'US' : 'KRX';
                      const { buyStages: calculatedBuyStages } =
                        calculateBuySellPrices(latestPrice);
                      const buyEntryRaw = parseOrderAmountValue(
                        repeatAutoTradingForm.buyEntry,
                        marketKey === 'US'
                      );
                      const buyEntry = buyEntryRaw > 0
                        ? adjustPriceToTickSize(buyEntryRaw, marketKey)
                        : adjustPriceToTickSize(calculatedBuyStages[0]?.buyPrice || 0, marketKey);
                      if (!buyEntry || buyEntry <= 0) {
                        alert(
                          '진입가(buyEntry)를 계산할 수 없습니다. 1차 매수%를 확인해주세요.'
                        );
                        return;
                      }
                      strategyConfig.buyEntry = buyEntry;
                      strategyConfig.seedAmount = parseOrderAmountValue(
                        repeatAutoTradingForm.seedAmount,
                        marketKey === 'US'
                      );
                      strategyConfig.unitBuyAmount = parseOrderAmountValue(
                        repeatAutoTradingForm.unitBuyAmount,
                        marketKey === 'US'
                      );
                      strategyConfig.buyStepPercent = parsePercentFieldForSave(repeatAutoTradingForm.buyStepPercent, 2);
                      strategyConfig.buyMultipliers = (
                        repeatAutoTradingForm.buyMultipliers?.length
                          ? repeatAutoTradingForm.buyMultipliers
                          : DEFAULT_INFINITE_BUY_MULTIPLIERS
                      ).map((m) => {
                        const n = parseFloat(String(m).replace(',', '.'));
                        return Number.isFinite(n) ? n : 0;
                      });
                      strategyConfig.sellTargetPercent = parsePercentFieldForSave(repeatAutoTradingForm.sellTargetPercent, 10);
                      strategyConfig.sellTargetPercent2 = parsePercentFieldForSave(repeatAutoTradingForm.sellTargetPercent2, 10);
                    } else {
                      const { buyStages: calculatedBuyStages, sellStages: calculatedSellStages } =
                        calculateBuySellPrices(latestPrice);
                      strategyConfig.defaultBuyTotal = buyStages[0]?.buyTotal || defaultBuyTotal;
                      for (let i = 0; i < 5; i++) {
                        const b = buyStages[i];
                        const calcB = calculatedBuyStages[i];
                        const s = sellStages[i];
                        const calcS = calculatedSellStages[i];
                        const buyFilled = b?.buyEnd === 'Y';
                        stages.push({
                          side: 'BUY',
                          stage: i + 1,
                          // 하락률은 DB에 음수로 저장 (입력칸 - 자동 표시와 동일)
                          percent: -Math.abs(parseRateValue(b?.dropRate) || 0),
                          targetPrice: buyFilled ? (b?.buyPrice || 0) : (calcB?.buyPrice || 0),
                          targetAmount: b?.buyTotal || 0,
                          targetQty: buyFilled ? (b?.buyQty || 0) : (calcB?.buyQty || 0),
                          status: buyFilled ? 'filled' : 'pending',
                        });
                        stages.push({
                          side: 'SELL',
                          stage: i + 1,
                          percent: parseRateValue(s?.profitRate),
                          targetPrice: calcS?.sellPrice || 0,
                          targetAmount: null,
                          targetQty: calcS?.sellQty || 0,
                          status: 'pending',
                        });
                      }
                    }

                    const v2Payload = {
                      _source: 'v2',
                      market,
                      exchange,
                      currency,
                      symbol: String(targetBuyDialogStock.stockCode || '').trim(),
                      name: targetBuyDialogStock.stockName || null,
                      strategyType,
                      status,
                      strategyConfig,
                      stages,
                      otherPlanStatus,
                    };

                    setPreparedAutoTradingData(v2Payload);
                    setConfirmSaveDialogOpen(true);
                  } catch (error) {
                    console.error('[반복자동매매설정] 저장 실패:', error);
                    const message = error.response?.data?.error || '반복자동매매설정 저장 중 오류가 발생했습니다.';
                    setErrorMessage(message);
                  }
                }} 
                variant="contained" 
                color="primary"
              >
                확인
              </Button>
              </Box>
            </Box>
          </Box>
        </DialogContent>
      </Dialog>

      {/* 매매설정 내역 확인 다이얼로그 */}
      <Dialog
        open={confirmSaveDialogOpen}
        onClose={() => setConfirmSaveDialogOpen(false)}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: {
            width: '70%',
            maxWidth: '840px',
          },
        }}
      >
        <DialogTitle component="div" sx={{ pb: 1 }}>
          <Typography variant="h6" component="div" sx={{ fontWeight: 700, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: 0.6 }}>
            <SettingsIcon sx={{ fontSize: '1.25rem', color: '#ff9800' }} aria-hidden />
            매매설정 내역
          </Typography>
        </DialogTitle>
        <DialogContent sx={{ pt: 2, pb: 1 }}>
          {preparedAutoTradingData ? (
            <>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 2 }}>
                {targetBuyDialogStock && (
                  <Typography variant="body2" color="text.secondary">
                    {targetBuyDialogStock.stockName} ({targetBuyDialogStock.stockCode})
                  </Typography>
                )}
                <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                  {preparedAutoTradingData.strategyType === 'INFINITE_TRADE' ? '무한매매' : '분할매매'}
                  {' · '}
                  {preparedAutoTradingData.status}
                  {preparedAutoTradingData.otherPlanStatus && (
                    <>
                      {' / '}
                      {preparedAutoTradingData.strategyType === 'INFINITE_TRADE' ? '분할매매' : '무한매매'}
                      {' · '}
                      {preparedAutoTradingData.otherPlanStatus.status}
                    </>
                  )}
                </Typography>
              </Box>
              <Box display="flex" gap={3} flexWrap="wrap" mb={2}>
                <Typography variant="body2">
                  Buy Trailing: {preparedAutoTradingData.strategyConfig?.buyTrailingPercent ?? 0}
                </Typography>
                <Typography variant="body2">
                  Sell Trailing: {preparedAutoTradingData.strategyConfig?.sellTrailingPercent ?? 0}
                </Typography>
              </Box>
              {preparedAutoTradingData.strategyType === 'INFINITE_TRADE' ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Typography variant="body2">
                    진입가(buyEntry):{' '}
                    {formatPriceWithCurrency(
                      preparedAutoTradingData.strategyConfig?.buyEntry,
                      dialogCurrencySymbol
                    )}
                  </Typography>
                  <Typography variant="body2">
                    시드금액:{' '}
                    {formatOrderAmountDisplay(
                      preparedAutoTradingData.strategyConfig?.seedAmount,
                      dialogIsUs
                    )}
                    {dialogCurrencySymbol}
                  </Typography>
                  <Typography variant="body2">
                    1회매수:{' '}
                    {formatOrderAmountDisplay(
                      preparedAutoTradingData.strategyConfig?.unitBuyAmount,
                      dialogIsUs
                    )}
                    {dialogCurrencySymbol}
                  </Typography>
                  <Typography variant="body2">단계 간격: {preparedAutoTradingData.strategyConfig?.buyStepPercent}</Typography>
                  <Typography variant="body2">
                    배수: {(preparedAutoTradingData.strategyConfig?.buyMultipliers || []).join(' / ')}
                  </Typography>
                  <Typography variant="body2">익절: {preparedAutoTradingData.strategyConfig?.sellTargetPercent}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
                    저장 위치: trading_plans (INFINITE_TRADE)
                  </Typography>
                </Box>
              ) : (
                <>
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow sx={{ bgcolor: 'action.hover' }}>
                          <TableCell align="center" sx={{ fontWeight: 'bold' }}>차수</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold' }}>매수%</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold' }}>매수가</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold' }}>매수총액</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold' }}>매도%</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold' }}>목표가</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {[1, 2, 3, 4, 5].map((n) => {
                          const buy = (preparedAutoTradingData.stages || []).find(
                            (s) => s.side === 'BUY' && s.stage === n
                          );
                          const sell = (preparedAutoTradingData.stages || []).find(
                            (s) => s.side === 'SELL' && s.stage === n
                          );
                          const buyPrice = Number(buy?.targetPrice) || 0;
                          const sellPct = Number(sell?.percent);
                          const storedTarget = Number(sell?.targetPrice) || 0;
                          const marketKey = dialogIsUs ? 'US' : 'KRX';
                          const sellTarget =
                            storedTarget > 0
                              ? storedTarget
                              : buyPrice > 0 && Number.isFinite(sellPct)
                                ? adjustPriceToTickSize(buyPrice * (1 + sellPct / 100), marketKey)
                                : 0;
                          return (
                            <TableRow key={n}>
                              <TableCell align="center">{n}차</TableCell>
                              <TableCell align="center">{buy?.percent ?? '-'}</TableCell>
                              <TableCell align="center">{buy?.targetPrice ?? '-'}</TableCell>
                              <TableCell align="center">{buy?.targetAmount ?? '-'}</TableCell>
                              <TableCell align="center">{sell?.percent ?? '-'}</TableCell>
                              <TableCell align="center">{sellTarget > 0 ? sellTarget : '-'}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                    저장 위치: trading_plans + trading_stages (SPLIT_TRADE)
                  </Typography>
                </>
              )}
            </>
          ) : (
            <Typography variant="body2" color="text.secondary" align="center" py={3}>
              데이터를 불러오는 중...
            </Typography>
          )}
        </DialogContent>
        <DialogActions
          sx={{
            px: 3,
            py: 1,
            pb: 2,
            mt: -0.5,
            justifyContent: 'flex-end',
            gap: 1
          }}
        >
          <Button onClick={() => setConfirmSaveDialogOpen(false)}>취소</Button>
           <Button 
             onClick={async () => {
               try {
                 const buyTrailing = parsePercentFieldForSave(repeatAutoTradingForm.buyTrailingStopPercent, 0);
                 const sellTrailing = parsePercentFieldForSave(repeatAutoTradingForm.trailingStopPercent, 0);
                 const payload = {
                   market: preparedAutoTradingData.market,
                   symbol: preparedAutoTradingData.symbol,
                   name: preparedAutoTradingData.name,
                   exchange: preparedAutoTradingData.exchange,
                   currency: preparedAutoTradingData.currency,
                   strategyType: preparedAutoTradingData.strategyType,
                   status: preparedAutoTradingData.status,
                   strategyConfig: {
                     ...preparedAutoTradingData.strategyConfig,
                     buyTrailingPercent: buyTrailing,
                     sellTrailingPercent: sellTrailing,
                   },
                   stages: preparedAutoTradingData.stages || [],
                 };

                 await apiClient.post('/trading-v2/bootstrap').catch(() => null);
                 const res = await apiClient.post('/trading-v2/plans', payload);

                 // 같은 종목의 다른 전략 플랜에도 trailing 동기화 (+ 활성 체크가 바뀌었으면 status)
                 const otherPlanStatus = preparedAutoTradingData.otherPlanStatus;
                 let otherStatusError = null;
                 try {
                   const listRes = await apiClient.get('/trading-v2/plans');
                   const others = (listRes.data?.plans || []).filter(
                     (p) =>
                       matchTradingPlanSymbol(p, preparedAutoTradingData.symbol) &&
                       p.strategyType !== preparedAutoTradingData.strategyType
                   );
                   await Promise.all(
                     others.map((p) =>
                       apiClient
                         .put(`/trading-v2/plans/${p.id}`, {
                           strategyConfig: {
                             buyTrailingPercent: buyTrailing,
                             sellTrailingPercent: sellTrailing,
                           },
                           ...(otherPlanStatus && Number(otherPlanStatus.id) === Number(p.id)
                             ? { status: otherPlanStatus.status }
                             : {}),
                         })
                         .catch((err) => {
                           if (otherPlanStatus && Number(otherPlanStatus.id) === Number(p.id)) {
                             otherStatusError = err.response?.data?.error || err.message;
                           }
                           throw err;
                         })
                     )
                   );
                 } catch (syncErr) {
                   console.warn('[trading_plans] trailing 동기화 실패:', syncErr);
                 }
                 if (otherStatusError) {
                   alert(
                     `${preparedAutoTradingData.strategyType === 'INFINITE_TRADE' ? '분할' : '무한'}매매 활성 상태 변경 실패: ${otherStatusError}`
                   );
                 }

                 await fetchAutoTrading();
                 alert(
                   `자동매매 Ver.2 저장 완료 (#${res.data?.plan?.id || '-'} · ${
                     preparedAutoTradingData.strategyType === 'INFINITE_TRADE' ? '무한매매' : '분할매매'
                   })`
                 );
                 setConfirmSaveDialogOpen(false);
                 setRepeatAutoTradingDialogOpen(false);
                 setSelectedStockCode(null);
                 window.dispatchEvent(new CustomEvent('refreshHoldings'));
              } catch (error) {
                console.error('[반복자동매매설정] 저장 실패:', error);
                const message =
                  error.response?.data?.error ||
                  error.message ||
                  '반복자동매매설정 저장 중 오류가 발생했습니다.';
                setErrorMessage(message);
                alert(message);
                setConfirmSaveDialogOpen(false);
              }
            }}
            variant="contained"
            color="primary"
          >
            저장
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );

  if (noContainer) {
    return content;
  }

  return (
    <Container maxWidth="xl">
      {content}
    </Container>
  );
};

export default Watchlist;

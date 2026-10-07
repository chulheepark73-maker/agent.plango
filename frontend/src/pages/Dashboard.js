import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import {
  Grid,
  Typography,
  Box,
  Paper,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  IconButton,
  Chip,
  Fade,
  Tooltip,
} from '@mui/material';
import NoteAltOutlinedIcon from '@mui/icons-material/NoteAltOutlined';
import SettingsIcon from '@mui/icons-material/Settings';
import CandlestickChartIcon from '@mui/icons-material/CandlestickChart';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DateRangeIcon from '@mui/icons-material/DateRange';
import CalendarViewMonthIcon from '@mui/icons-material/CalendarViewMonth';
import InsightsIcon from '@mui/icons-material/Insights';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import DashboardIcon from '@mui/icons-material/Dashboard';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import ShieldIcon from '@mui/icons-material/Shield';
import DescriptionIcon from '@mui/icons-material/Description';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import { alpha } from '@mui/material/styles';
import apiClient from '../utils/axios';
import { formatNumber, formatChangeRate, formatUsMoney } from '../utils/formatUtils';
import { useAuth } from '../contexts/AuthContext';
import { calculateProfit, DEFAULT_FEE_RATES } from '../utils/profitUtils';
import { isTradingHours, isNXTTradingHours, isKRXAfterMarketHours, isKRXExtendedCloseHours, isKRXSessionOpen, isWeekend, isHolidaySync } from '../utils/tradingHours';
import { connectPricesWs } from '../utils/watchlistPricesWs';
import StockDailyChartDialog from '../components/StockDailyChartDialog';
import NxtBadge from '../components/NxtBadge';
import StockLogo from '../components/StockLogo';
import FlagIcon from '../components/FlagIcon';
import LiquidateDialog from '../components/LiquidateDialog';
import MarketSessionStatusBar from '../components/MarketSessionStatusBar';
import PageFrame from '../components/PageFrame';
import { isUsMarket } from '../utils/marketUtils';

/** Trading V2 plan → 차트 매수라인 / B·S 마커 (분할매매만) */
const buildChartOverlaysFromV2Plan = (plan) => {
  if (!plan) return { buyLevels: [], tradeMarkers: [] };
  if (String(plan.strategyType || '').toUpperCase() !== 'SPLIT_TRADE') {
    return { buyLevels: [], tradeMarkers: [] };
  }
  const buyLevels = [];
  const tradeMarkers = [];
  const cycleId = plan.currentCycleId != null ? Number(plan.currentCycleId) : null;
  const stages = (plan.stages || []).filter(
    (s) => cycleId == null || Number(s.cycleId) === cycleId
  );
  for (const s of stages) {
    const side = String(s.side || '').toUpperCase();
    const stage = Number(s.stage) || 0;
    const price = parseFloat(s.targetPrice || 0);
    if (side === 'BUY' && String(s.status) === 'filled' && price > 0) {
      buyLevels.push({ stage, price });
    }
  }
  const orders = plan.orders || [];
  const fills = plan.fills || [];
  for (const f of fills) {
    const ord = orders.find((o) => Number(o.id) === Number(f.orderId));
    if (!ord) continue;
    const side = String(ord.side || '').toUpperCase() === 'SELL' ? 'sell' : 'buy';
    const st = stages.find((s) => Number(s.id) === Number(ord.stageId));
    const stageNo =
      ord.stageNo != null
        ? Number(ord.stageNo)
        : st
          ? Number(st.stage)
          : 1;
    const date = String(f.filledAt || f.createdAt || '').slice(0, 10);
    if (!date) continue;
    tradeMarkers.push({
      stage: stageNo || 1,
      side,
      date,
      price: parseFloat(f.fillPrice || 0) || undefined,
    });
  }
  return { buyLevels, tradeMarkers };
};

/** ISO 시각 → KST YYYY-MM-DD (UTC slice 시 09시 이전 체결이 전날로 보이는 문제 방지) */
const formatKstDate = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '').slice(0, 10) || '-';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
};

const strategyTypeLabel = (strategyType) => {
  const t = String(strategyType || '').toUpperCase();
  if (t === 'INFINITE_TRADE') return '무한';
  if (t === 'SPLIT_TRADE') return '분할';
  return t || 'V2';
};

/** V2 stage status 표시용 */
const formatTradingV2StageStatus = (status) => {
  const s = String(status || '').toLowerCase();
  if (s === 'filled') return '체결';
  if (s === 'pending') return '대기';
  if (s === 'ordered') return '주문중';
  if (s === 'skipped') return '건너뜀';
  if (s === 'cancelled') return '취소';
  return status || '-';
};

/** 무한매매 시드 사용·잔액 (BUY fills 합산, 없으면 submitted 주문) */
const calcInfiniteSeedRemaining = (plan) => {
  const cfg = plan?.strategyConfig || {};
  const seed = Number(cfg.seedAmount);
  const cycleId = plan?.currentCycleId != null ? Number(plan.currentCycleId) : null;
  const ordersAll = plan?.orders || [];
  const orders =
    cycleId != null
      ? ordersAll.filter((o) => {
          if (o.cycleId != null) return Number(o.cycleId) === cycleId;
          if (o.stageId != null) {
            const st = (plan.stages || []).find((s) => Number(s.id) === Number(o.stageId));
            return st && Number(st.cycleId) === cycleId;
          }
          return false;
        })
      : ordersAll;
  const orderById = new Map(orders.map((o) => [Number(o.id), o]));
  let spent = 0;
  for (const f of plan?.fills || []) {
    const ord = orderById.get(Number(f.orderId));
    if (!ord || String(ord.side).toUpperCase() !== 'BUY') continue;
    const q = Number(f.fillQty) || 0;
    const p = Number(f.fillPrice) || 0;
    if (q > 0 && p > 0) spent += p * q;
  }
  if (!(spent > 0)) {
    for (const o of orders) {
      const st = String(o.status || '').toLowerCase();
      if (!['submitted', 'partial', 'filled'].includes(st)) continue;
      if (String(o.side).toUpperCase() !== 'BUY') continue;
      const q = Number(o.requestedQty) || 0;
      const p = Number(o.requestedPrice) || 0;
      if (q > 0 && p > 0) spent += p * q;
    }
  }
  if (!(seed > 0)) {
    return { seed: null, spent, remaining: null };
  }
  return { seed, spent, remaining: Math.max(0, seed - spent) };
};
/** 종목명이 코드와 같거나 비어 있으면 유효하지 않음 */
const isCodeLikeStockName = (name, stockCode) => {
  if (name == null || name === '') return true;
  const n = String(name).trim();
  const code = String(stockCode || '').trim();
  const code6 = code.substring(0, 6);
  return n === code || n === code6 || n === code.toUpperCase();
};

const isUsHoldingCode = (stockCode, stockMarket) => isUsMarket(stockMarket, stockCode);

const holdingCodeKey = (stockCode, stockMarket) => {
  const raw = String(stockCode || '').trim();
  if (!raw) return '';
  if (isUsHoldingCode(raw, stockMarket)) return raw.toUpperCase();
  return raw.substring(0, 6);
};

/** 관심종목 맵·후보에서 실제 종목명 선택 */
const resolveStockDisplayName = (stockCode, nameMap, ...candidates) => {
  const code = String(stockCode || '').trim();
  const codeKey = holdingCodeKey(code);
  const code6 = code.substring(0, 6);
  for (const cand of candidates) {
    if (cand && !isCodeLikeStockName(cand, code)) return String(cand).trim();
  }
  if (nameMap instanceof Map) {
    const fromMap =
      nameMap.get(code) ||
      nameMap.get(codeKey) ||
      nameMap.get(code.toUpperCase()) ||
      nameMap.get(code6);
    if (fromMap && !isCodeLikeStockName(fromMap, code)) return fromMap;
  }
  return codeKey || code6 || code;
};

/** 매수종목 카드·섹션 텍스트·강조색 — MUI palette 경로 (light/dark 공통) */
const HOLDINGS_DASH = {
  border: 'divider',
  text: 'text.primary',
  muted: 'text.secondary',
  red: 'error.main',
  blue: 'primary.main',
  dotKrx: 'error.main',
  dotNxt: 'error.main',
  dotClosed: 'text.disabled',
};

const HOLDINGS_PAGE_SIZE = 3;
const HOLDINGS_ROTATE_MS = 10000;

const dashInnerCardBg = (theme) =>
  theme.palette.mode === 'dark' ? '#122239' : theme.palette.action.hover;

const DashStatusCard = ({ icon: Icon, iconColor, title, subtitle, action, children }) => (
  <Box
    sx={(theme) => ({
      height: '100%',
      border: '1px solid',
      borderColor: 'divider',
      borderLeft: `3px solid ${theme.palette.divider}`,
      borderRadius: 2,
      p: 2,
      bgcolor: dashInnerCardBg(theme),
    })}
  >
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.25 }}>
      <Box
        sx={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          bgcolor: (theme) => iconColor || alpha(theme.palette.text.primary, 0.12),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon sx={{ fontSize: '1.2rem', color: iconColor ? '#fff' : 'text.primary' }} />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '1rem', color: HOLDINGS_DASH.text, lineHeight: 1.3 }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {action && <Box sx={{ ml: 'auto', flexShrink: 0 }}>{action}</Box>}
    </Box>
    {children}
  </Box>
);

const dashDarkPaperSx = {
  bgcolor: 'background.paper',
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 2,
  boxShadow: 'none',
};

/** 매도완료(50% - 6px) 옆 KR/US Plan Status — 남은 폭을 반씩 */
const planStatusGridSx = {
  flexBasis: { md: 'calc(25% + 3px)' },
  maxWidth: { md: 'calc(25% + 3px)' },
};

const dashTableHeadCellSx = {
  fontWeight: 600,
  fontSize: '0.72rem',
  color: HOLDINGS_DASH.muted,
  borderColor: HOLDINGS_DASH.border,
  py: 1,
  borderBottom: '1px solid',
};

const dashTableBodyCellSx = {
  color: HOLDINGS_DASH.text,
  borderColor: HOLDINGS_DASH.border,
  fontSize: '0.8125rem',
};

const EMPTY_PLAN_PROGRESS = {
  goals: { week: 0, month: 0, year: 0 },
  profits: { week: 0, month: 0, year: 0 },
  progress: { week: 0, month: 0, year: 0 },
  investable: { amount: 0, total: 0, percent: 0 },
};

const renderPlanProgressRows = (planProgress, loading) => {
  if (loading) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <CircularProgress sx={{ color: HOLDINGS_DASH.muted, width: 20, height: 20 }} />
        <Typography variant="body2" sx={{ mt: 1.25, color: HOLDINGS_DASH.muted }}>
          Plan 진행상황 계산 중...
        </Typography>
      </Box>
    );
  }

  return [
    {
      key: 'week',
      label: '주간수익',
      Icon: DateRangeIcon,
      percent: Number(planProgress.progress?.week || 0),
    },
    {
      key: 'month',
      label: '월간수익',
      Icon: CalendarViewMonthIcon,
      percent: Number(planProgress.progress?.month || 0),
    },
    {
      key: 'year',
      label: '년간수익',
      Icon: InsightsIcon,
      percent: Number(planProgress.progress?.year || 0),
    },
    {
      key: 'investable',
      label: '현금비중',
      Icon: AccountBalanceWalletIcon,
      percent: Number(planProgress.investable?.percent || 0),
      pending: planProgress.investable == null,
    },
  ].map(({ key, label, Icon, percent, pending }) => {
    const barPercent = Math.min(100, Math.max(0, percent));
    const barColor = key === 'investable' ? '#d29922' : '#3fb950';
    const labelColor = HOLDINGS_DASH.muted;
    return (
      <Box
        key={key}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          width: '100%',
        }}
      >
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.6, minWidth: 88, flexShrink: 0 }}>
          <Icon sx={{ fontSize: '0.95rem', color: labelColor }} />
          <Typography variant="body2" sx={{ color: labelColor }}>
            {label}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 120, ml: 0.5 }}>
          <Box
            sx={{
              width: '100%',
              height: 12,
              borderRadius: 999,
              bgcolor: 'action.selected',
              overflow: 'hidden',
            }}
          >
            <Box
              sx={{
                width: `${barPercent}%`,
                height: '100%',
                borderRadius: 999,
                bgcolor: barColor,
                transition: 'width 0.3s ease',
              }}
            />
          </Box>
          <Typography variant="caption" sx={{ color: HOLDINGS_DASH.muted, minWidth: 44, textAlign: 'right' }}>
            {pending ? '조회중' : `${percent.toFixed(2)}%`}
          </Typography>
        </Box>
      </Box>
    );
  });
};

// 매수종목 카드 컴포넌트 (Holdings에서 가져옴)
const StockCard = memo(({ 
  stockCode, 
  stockName, 
  priceInfo, 
  buyItems, 
  priceLoading,
  onOpenAutoTradingDialog,
  onOpenChart,
  onOpenLiquidate,
  feeRates,
}) => {
  const [liquidateOnLeft] = useState(() => Math.random() < 0.5);
  const isLoading = priceLoading && !priceInfo;
  const price = priceInfo?.price || 0;
  const change = priceInfo?.change || 0;
  const changeRate = priceInfo?.changeRate || 0;
  const isPositive = change >= 0;
  const riseFallColor = price > 0 ? (isPositive ? HOLDINGS_DASH.red : HOLDINGS_DASH.blue) : HOLDINGS_DASH.text;
  const isNXT = priceInfo?.stockMarket === 'NXT';
  const isUs = priceInfo?.stockMarket === 'US' || isUsHoldingCode(stockCode, priceInfo?.stockMarket);
  const stockMarket = isUs ? 'US' : buyItems?.[0]?.stockMarket || priceInfo?.stockMarket || 'KRX';
  const splitPlanId = useMemo(() => {
    const row = (buyItems || []).find(
      (b) => String(b.strategyType || '').toUpperCase() === 'SPLIT_TRADE' && b.planId != null
    );
    return row?.planId ?? null;
  }, [buyItems]);
  const infinitePlanId = useMemo(() => {
    const row = (buyItems || []).find(
      (b) => String(b.strategyType || '').toUpperCase() === 'INFINITE_TRADE' && b.planId != null
    );
    return row?.planId ?? null;
  }, [buyItems]);
  const chartPlanIds = useMemo(
    () => [...new Set((buyItems || []).map((b) => b.planId).filter(Boolean))],
    [buyItems]
  );

  // 매수일 → 유형(분할/무한) → 차수
  const sortedBuyItems = useMemo(() => {
    const typeRank = (t) =>
      String(t || '').toUpperCase() === 'INFINITE_TRADE' ? 1 : 0;
    return [...buyItems].sort((a, b) => {
      const da = String(a.buyDate || a.dateTime || '');
      const db = String(b.buyDate || b.dateTime || '');
      if (da !== db) return da < db ? -1 : 1;
      const tr = typeRank(a.strategyType) - typeRank(b.strategyType);
      if (tr !== 0) return tr;
      return (a.stage || 0) - (b.stage || 0);
    });
  }, [buyItems]);

  // 계획(분할/무한)별 마지막 차수 1행만 표시
  const displayBuyItems = useMemo(() => {
    const groupKey = (it) => `${it.planId ?? 'x'}_${String(it.strategyType || '').toUpperCase()}`;
    const lastByGroup = new Map();
    for (const it of sortedBuyItems) {
      const key = groupKey(it);
      const prev = lastByGroup.get(key);
      if (!prev || (Number(it.stage) || 0) >= (Number(prev.stage) || 0)) lastByGroup.set(key, it);
    }
    const keep = new Set(lastByGroup.values());
    return sortedBuyItems.filter((it) => keep.has(it));
  }, [sortedBuyItems]);

  const stockTitleColor = isUs ? '#C9A227' : HOLDINGS_DASH.text;
  const strategyChipSx = {
    height: 20,
    fontWeight: 700,
    fontSize: '0.65rem',
    cursor: 'pointer',
    color: stockTitleColor,
    borderColor: stockTitleColor,
    '& .MuiChip-label': { px: 0.75 },
    '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.08)', borderColor: stockTitleColor },
  };

  return (
    <Box
      sx={{
        mb: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        bgcolor: dashInnerCardBg,
      }}
    >
      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', pt: 2, px: 2, pb: 2 }}>
        <Box textAlign="center" mb={0} sx={{ position: 'relative' }}>
          <Box
            display="flex"
            alignItems="center"
            justifyContent="center"
            gap={0.5}
            flexWrap="wrap"
            sx={{ px: splitPlanId != null || infinitePlanId != null ? 3 : 0 }}
          >
            <StockLogo stockCode={stockCode} isUs={isUs} size={18} sx={{ mr: 0.25 }} />
            {isNXT && <NxtBadge size={18} sx={{ color: stockTitleColor }} />}
            <Typography
              variant="body1"
              sx={{ fontWeight: 700, color: stockTitleColor }}
            >
              {stockName || stockCode} ({stockCode})
            </Typography>
            <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, ml: 0.25 }}>
              {splitPlanId != null && (
                <Chip
                  size="small"
                  label="분할"
                  variant="outlined"
                  onClick={() =>
                    onOpenAutoTradingDialog &&
                    onOpenAutoTradingDialog(stockCode, stockName, stockMarket, splitPlanId)
                  }
                  sx={strategyChipSx}
                />
              )}
              {infinitePlanId != null && (
                <Chip
                  size="small"
                  label="무한"
                  variant="outlined"
                  onClick={() =>
                    onOpenAutoTradingDialog &&
                    onOpenAutoTradingDialog(stockCode, stockName, stockMarket, infinitePlanId)
                  }
                  sx={strategyChipSx}
                />
              )}
              <IconButton
                size="small"
                onClick={() =>
                  onOpenChart &&
                  onOpenChart({
                    stockCode,
                    stockName: stockName || stockCode,
                    stockMarket,
                    stexTp: priceInfo?.exchange || priceInfo?.stexTp || null,
                    planId: splitPlanId || infinitePlanId,
                    planIds: chartPlanIds,
                  })
                }
                sx={{
                  p: 0.2,
                  color: stockTitleColor,
                  '&:hover': { color: stockTitleColor, bgcolor: 'action.hover' },
                }}
                aria-label="일봉 차트"
                title="일봉 차트"
              >
                <CandlestickChartIcon sx={{ fontSize: '1.15rem' }} />
              </IconButton>
            </Box>
          </Box>
          {(splitPlanId != null || infinitePlanId != null) && (
                <IconButton
                  size="small"
                  onClick={() =>
                    onOpenLiquidate &&
                    onOpenLiquidate({
                      stockCode,
                      stockName: stockName || stockCode,
                      isUs,
                      price,
                      plans: [
                        ...(splitPlanId != null ? [{ planId: splitPlanId, strategyType: 'SPLIT_TRADE' }] : []),
                        ...(infinitePlanId != null ? [{ planId: infinitePlanId, strategyType: 'INFINITE_TRADE' }] : []),
                      ],
                    })
                  }
                  sx={{
                    position: 'absolute',
                    top: 0,
                    ...(liquidateOnLeft ? { left: 0 } : { right: 0 }),
                    height: 24,
                    display: 'flex',
                    alignItems: 'center',
                    py: 0,
                    px: 0.2,
                    color: stockTitleColor,
                    '&:hover': { color: stockTitleColor, bgcolor: 'action.hover' },
                  }}
                  aria-label="일괄청산"
                  title="일괄청산"
                >
                  <Box
                    component="span"
                    sx={{
                      display: 'block',
                      width: 10,
                      height: 10,
                      bgcolor: '#fff',
                      borderRadius: '2px',
                    }}
                  />
                </IconButton>
          )}
          <Box mt={0.2} minHeight={26} display="flex" alignItems="center" justifyContent="center">
            {isLoading ? (
              <CircularProgress size={22} sx={{ color: HOLDINGS_DASH.muted }} />
            ) : price > 0 ? (
              <Typography
                component="div"
                sx={{
                  fontSize: '1.35rem',
                  fontWeight: 700,
                  color: riseFallColor,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {isUs ? `$${formatUsMoney(price)}` : formatNumber(price)}{' '}
                <Typography component="span" sx={{ fontSize: '1.35rem', fontWeight: 700, color: riseFallColor }}>
                  ({formatChangeRate(changeRate)})
                </Typography>
              </Typography>
            ) : (
              <Typography variant="body2" sx={{ color: HOLDINGS_DASH.muted }}>
                시세 없음
              </Typography>
            )}
          </Box>
        </Box>

        <TableContainer
          sx={{
            flexGrow: 1,
            bgcolor: 'transparent',
            overflowX: 'hidden',
            mt: -0.25,
          }}
        >
          <Table
            size="small"
            sx={{
              borderCollapse: 'separate',
              tableLayout: 'fixed',
              width: '100%',
            }}
          >
            <TableHead>
              <TableRow>
                <TableCell
                  align="center"
                  sx={{
                    fontWeight: 600,
                    fontSize: '0.72rem',
                    color: HOLDINGS_DASH.muted,
                    borderColor: HOLDINGS_DASH.border,
                    py: 0.45,
                    px: 0.5,
                    borderBottom: '1px solid',
                    width: '24%',
                  }}
                >
                  매수일
                </TableCell>
                <TableCell
                  align="center"
                  sx={{
                    fontWeight: 600,
                    fontSize: '0.72rem',
                    color: HOLDINGS_DASH.muted,
                    borderColor: HOLDINGS_DASH.border,
                    py: 0.45,
                    px: 0.25,
                    borderBottom: '1px solid',
                    width: 28,
                    maxWidth: 28,
                  }}
                >
                  No
                </TableCell>
                <TableCell
                  align="center"
                  sx={{
                    fontWeight: 600,
                    fontSize: '0.72rem',
                    color: HOLDINGS_DASH.muted,
                    borderColor: HOLDINGS_DASH.border,
                    py: 0.45,
                    px: 0.5,
                    borderBottom: '1px solid',
                  }}
                >
                  매수가
                </TableCell>
                <TableCell
                  align="center"
                  sx={{
                    fontWeight: 600,
                    fontSize: '0.72rem',
                    color: HOLDINGS_DASH.muted,
                    borderColor: HOLDINGS_DASH.border,
                    py: 0.45,
                    px: 0.5,
                    borderBottom: '1px solid',
                  }}
                >
                  목표가
                </TableCell>
                <TableCell
                  align="center"
                  sx={{
                    fontWeight: 600,
                    fontSize: '0.72rem',
                    color: HOLDINGS_DASH.muted,
                    borderColor: HOLDINGS_DASH.border,
                    py: 0.45,
                    px: 0.5,
                    borderBottom: '1px solid',
                    width: '10%',
                  }}
                >
                  Qty
                </TableCell>
                <TableCell
                  align="center"
                  sx={{
                    fontWeight: 600,
                    fontSize: '0.72rem',
                    color: HOLDINGS_DASH.muted,
                    borderColor: HOLDINGS_DASH.border,
                    py: 0.45,
                    px: 0.5,
                    borderBottom: '1px solid',
                  }}
                >
                  수익/평단
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {displayBuyItems.map((item) => {
                const boughtPrice = parseFloat(item.buy_price || 0);
                const qty = parseInt(item.buy_qty || 0);
                const targetPrice = parseFloat(item.sell_price || 0);
                const buyDate =
                  item.buyDate ||
                  (item.dateTime ? String(item.dateTime).slice(0, 10) : null) ||
                  '-';
                const rowIsInfinite =
                  String(item.strategyType || '').toUpperCase() === 'INFINITE_TRADE';
                const showAvgCost =
                  rowIsInfinite &&
                  (item.showAvgCostInProfit === true ||
                    (item.avgCost != null && Number(item.avgCost) > 0));
                const expectedProfitResult =
                  !showAvgCost && targetPrice > 0
                    ? calculateProfit({
                        buyPrice: boughtPrice,
                        sellPrice: targetPrice,
                        qty,
                        stockMarket: item.stockMarket,
                        feeRates,
                      })
                    : null;
                // 수익/평단: 상승·하락 색 없이 목록 본문과 동일
                const profitColor = HOLDINGS_DASH.text;

                return (
                  <TableRow key={`${stockCode}_${item.planId || 0}_${item.strategyType}_${item.stage}_${item.dateTime}`}>
                    <TableCell
                      align="left"
                      sx={{
                        color: HOLDINGS_DASH.text,
                        borderColor: HOLDINGS_DASH.border,
                        fontSize: '0.75rem',
                        whiteSpace: 'nowrap',
                        px: 0.5,
                      }}
                    >
                      <Box
                        component="span"
                        sx={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'flex-start',
                          gap: 0.4,
                        }}
                      >
                        <Box component="span">{buyDate}</Box>
                        {rowIsInfinite && (
                          <CheckCircleOutlineIcon
                            titleAccess="무한매매"
                            sx={{ fontSize: '0.9rem', color: HOLDINGS_DASH.text }}
                          />
                        )}
                      </Box>
                    </TableCell>
                    <TableCell
                      align="center"
                      sx={{
                        color: HOLDINGS_DASH.text,
                        borderColor: HOLDINGS_DASH.border,
                        fontSize: '0.8125rem',
                        px: 0.25,
                        width: 28,
                        maxWidth: 28,
                      }}
                    >
                      {item.stage || '-'}
                    </TableCell>
                    <TableCell
                      align="center"
                      sx={{ color: HOLDINGS_DASH.text, borderColor: HOLDINGS_DASH.border, fontSize: '0.8125rem', px: 0.5 }}
                    >
                      {isUs ? `$${formatUsMoney(boughtPrice)}` : formatNumber(boughtPrice)}
                    </TableCell>
                    <TableCell
                      align="center"
                      sx={{ color: HOLDINGS_DASH.text, borderColor: HOLDINGS_DASH.border, fontSize: '0.8125rem', px: 0.5 }}
                    >
                      {targetPrice > 0
                        ? isUs
                          ? `$${formatUsMoney(targetPrice)}`
                          : formatNumber(targetPrice)
                        : '-'}
                    </TableCell>
                    <TableCell
                      align="center"
                      sx={{ color: HOLDINGS_DASH.text, borderColor: HOLDINGS_DASH.border, fontSize: '0.8125rem', px: 0.5 }}
                    >
                      {formatNumber(qty)}
                    </TableCell>
                    <TableCell
                      align="center"
                      sx={{
                        color: profitColor,
                        borderColor: HOLDINGS_DASH.border,
                        fontSize: '0.8125rem',
                        px: 0.5,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                        {showAvgCost
                          ? (isUs
                            ? `$${formatUsMoney(item.avgCost)}`
                            : formatNumber(item.avgCost))
                          : expectedProfitResult
                            ? (isUs
                              ? `$${formatUsMoney(expectedProfitResult.profitAmount)}`
                              : formatNumber(expectedProfitResult.profitAmount))
                            : '-'
                        }
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    </Box>
  );
});

StockCard.displayName = 'StockCard';

const Dashboard = () => {
  const { user } = useAuth();
  // 매수종목 관련 상태
  const [holdings, setHoldings] = useState([]);
  const [holdingsPrices, setHoldingsPrices] = useState([]);
  const [orderStatuses, setOrderStatuses] = useState([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [holdingsPriceLoading, setHoldingsPriceLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [trailingLogNotice, setTrailingLogNotice] = useState(null);
  const [trailingLogExporting, setTrailingLogExporting] = useState(null);
  // 매도완료 내역 관련 상태
  const [tradeHistory, setTradeHistory] = useState([]);
  const [tradeHistoryLoading, setTradeHistoryLoading] = useState(false);
  const [brokerFeeRates, setBrokerFeeRates] = useState(DEFAULT_FEE_RATES);
  const [planProgressLoading, setPlanProgressLoading] = useState(false);
  const [krPlanProgress, setKrPlanProgress] = useState(EMPTY_PLAN_PROGRESS);
  const [usPlanProgress, setUsPlanProgress] = useState(EMPTY_PLAN_PROGRESS);
  const [planProgressDate, setPlanProgressDate] = useState(() => {
    const n = new Date();
    return { year: n.getFullYear(), month: n.getMonth() + 1, day: n.getDate() };
  });
  const [trailingBuyStatuses, setTrailingBuyStatuses] = useState([]);
  const [trailingSellStatuses, setTrailingSellStatuses] = useState([]);
  const [trailingStatusLoading, setTrailingStatusLoading] = useState(false);
  const trailingStatusRequestInFlightRef = useRef(false);
  const wasActiveMarketRef = useRef(false);
  const holdingsPriceRequestInFlightRef = useRef(false);
  const wasActiveMarketForPricesRef = useRef(false);
  const pricesWsRef = useRef(null);
  const [pricesWsReady, setPricesWsReady] = useState(false);
  const orderStatusRequestInFlightRef = useRef(false);
  // 종목명 매핑 (종목코드 -> 종목명)
  const [stockNameMap, setStockNameMap] = useState(new Map());
  const stockNameMapRef = useRef(stockNameMap);
  stockNameMapRef.current = stockNameMap;
  // 반복매매설정 내역 다이얼로그 관련 상태
  const [autoTradingDialogOpen, setAutoTradingDialogOpen] = useState(false);
  const [selectedStockCode, setSelectedStockCode] = useState(null);
  const [selectedStockName, setSelectedStockName] = useState(null);
  const [autoTradingData, setAutoTradingData] = useState(null);
  const [autoTradingLoading, setAutoTradingLoading] = useState(false);
  // 일봉 차트 다이얼로그
  const [chartDialogOpen, setChartDialogOpen] = useState(false);
  const [chartDialogStock, setChartDialogStock] = useState(null);
  const [chartBuyLevels, setChartBuyLevels] = useState([]);
  const [chartTradeMarkers, setChartTradeMarkers] = useState([]);
  const [liquidateTarget, setLiquidateTarget] = useState(null);

  // 거래시간 상태 추적 (WS/REST 게이트용)
  const [isInTradingHours, setIsInTradingHours] = useState(isTradingHours());
  const [isInNXTTradingHours, setIsInNXTTradingHours] = useState(isNXTTradingHours());
  const [isInKRXAfterMarket, setIsInKRXAfterMarket] = useState(isKRXAfterMarketHours());
  const [isInKRXExtendedClose, setIsInKRXExtendedClose] = useState(isKRXExtendedCloseHours());
  const [isWeekendDay, setIsWeekendDay] = useState(isWeekend());
  const [isHolidayDay, setIsHolidayDay] = useState(isHolidaySync());

  // 거래시간 변경 감지 (1분마다 확인)
  useEffect(() => {
    const checkTradingHours = () => {
      setIsInTradingHours(isTradingHours());
      setIsInNXTTradingHours(isNXTTradingHours());
      setIsInKRXAfterMarket(isKRXAfterMarketHours());
      setIsInKRXExtendedClose(isKRXExtendedCloseHours());
      setIsWeekendDay(isWeekend());
      setIsHolidayDay(isHolidaySync());
    };

    checkTradingHours();
    const tradingTimer = setInterval(checkTradingHours, 60000);
    return () => clearInterval(tradingTimer);
  }, []);

  // Dashboard 초기 스냅샷 조회 (holdings + prices + trailing)
  const fetchDashboardSnapshot = useCallback(async () => {
    try {
      setHoldingsLoading(true);
      setErrorMessage(null);
      setTrailingStatusLoading(true);

      const response = await apiClient.get('/holdings/dashboard-snapshot');
      setHoldings(response.data?.holdings || []);
      setOrderStatuses(response.data?.orderStatuses || []);
      setHoldingsPrices(response.data?.prices || []);
      setTrailingBuyStatuses(response.data?.trailingStatus?.buyStatuses || []);
      setTrailingSellStatuses(response.data?.trailingStatus?.sellStatuses || []);
    } catch (error) {
      console.error('[대시보드] Dashboard Snapshot 조회 실패:', error);
      let message = '대시보드 데이터를 불러오는 중 오류가 발생했습니다.';
      if (error.response?.status === 401) {
        message = '로그인이 필요합니다.';
      } else if (error.response?.data?.error) {
        message = error.response.data.error;
      }
      setErrorMessage(message);
      setHoldings([]);
      setOrderStatuses([]);
      setHoldingsPrices([]);
      setTrailingBuyStatuses([]);
      setTrailingSellStatuses([]);
    } finally {
      setHoldingsLoading(false);
      setTrailingStatusLoading(false);
    }
  }, []);

  // 매수종목 현재가 REST 스냅샷 (장외만 — 장중은 WebSocket)
  const fetchHoldingsPrices = useCallback(async (showLoading = true) => {
    if (holdings.length === 0) {
      setHoldingsPrices([]);
      return;
    }

    const inMarket =
      !isWeekend() &&
      !isHolidaySync() &&
      (isKRXSessionOpen() || isNXTTradingHours());
    if (inMarket) {
      if (showLoading) setHoldingsPriceLoading(false);
      return;
    }

    if (holdingsPriceRequestInFlightRef.current) {
      return;
    }

    holdingsPriceRequestInFlightRef.current = true;
    try {
      if (showLoading) {
        setHoldingsPriceLoading(true);
      }
      const response = await apiClient.get('/holdings/prices');
      setHoldingsPrices(response.data || []);
    } catch (error) {
      console.error('[대시보드] 매수종목 현재가 조회 실패:', error);
    } finally {
      holdingsPriceRequestInFlightRef.current = false;
      if (showLoading) {
        setHoldingsPriceLoading(false);
      }
    }
  }, [holdings.length]);

  const upsertHoldingsPriceFromWs = useCallback((data) => {
    if (!data?.stockCode) return;
    const codeKey = holdingCodeKey(data.stockCode, data.stockMarket);
    const nameMap = stockNameMapRef.current;
    setHoldingsPrices((prev) => {
      const next = [...prev];
      const idx = next.findIndex(
        (p) => holdingCodeKey(p.stockCode, p.stockMarket) === codeKey
      );
      const prevName = idx >= 0 ? next[idx].stockName : '';
      const incomingName = data.stockName;
      // WS가 코드 문자열을 stockName으로 보내면 기존/맵 이름을 유지
      const stockName = resolveStockDisplayName(
        codeKey,
        nameMap,
        !isCodeLikeStockName(incomingName, codeKey) ? incomingName : null,
        prevName
      );
      const merged = {
        ...(idx >= 0 ? next[idx] : {}),
        stockCode: idx >= 0 ? next[idx].stockCode : codeKey,
        stockName,
        stockMarket: data.stockMarket || (idx >= 0 ? next[idx].stockMarket : 'KRX') || 'KRX',
        price: data.price,
        change: data.change,
        changeRate: data.changeRate,
      };
      if (idx >= 0) next[idx] = merged;
      else next.push(merged);
      return next;
    });
  }, []);

  // 매수종목 가격 조회 (페이지 로딩 시에만 REST)
  useEffect(() => {
    if (holdings.length > 0) {
      fetchHoldingsPrices(true);
    }
  }, [holdings, fetchHoldingsPrices]);

  const fetchHoldingsPricesRef = useRef(fetchHoldingsPrices);
  fetchHoldingsPricesRef.current = fetchHoldingsPrices;
  const hasUsHoldings = useMemo(
    () => holdings.some((h) => isUsHoldingCode(h.stockCode, h.stockMarket)),
    [holdings]
  );

  // 장중: WebSocket 시세, 장외 전환 시 REST 1회 (US 보유 있으면 장시간 게이트 없이 연결)
  // holdings 갱신마다 재연결하면 서버 REG 해제/재등록이 반복돼 키움 REG 한도 초과 → 연결은 세션 조건에만 반응
  useEffect(() => {
    const isActiveMarket =
      hasUsHoldings ||
      (!isWeekendDay && !isHolidayDay && (isInTradingHours || isInNXTTradingHours || isInKRXAfterMarket || isInKRXExtendedClose));
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;

    if (!isActiveMarket || !token) {
      if (pricesWsRef.current) {
        pricesWsRef.current.close();
        pricesWsRef.current = null;
      }
      setPricesWsReady(false);
      if (wasActiveMarketForPricesRef.current) {
        fetchHoldingsPricesRef.current(false);
      }
      wasActiveMarketForPricesRef.current = false;
      return undefined;
    }

    wasActiveMarketForPricesRef.current = true;

    const conn = connectPricesWs({
      token,
      onOpen: () => {
        setPricesWsReady(true);
        setTrailingStatusLoading(true);
      },
      onClose: () => setPricesWsReady(false),
      onMessage: (msg) => {
        if (msg.type === 'price' && msg.data) {
          upsertHoldingsPriceFromWs(msg.data);
          setHoldingsPriceLoading(false);
        } else if (msg.type === 'dashboard_status') {
          setTrailingBuyStatuses(msg.trailingStatus?.buyStatuses || []);
          setTrailingSellStatuses(msg.trailingStatus?.sellStatuses || []);
          setOrderStatuses(msg.orderStatuses || []);
          setTrailingStatusLoading(false);
        } else if (msg.type === 'status' && msg.status === 'connected') {
          setPricesWsReady(true);
        }
      },
    });
    pricesWsRef.current = conn;

    return () => {
      try {
        conn.send({ type: 'unsubscribe_dashboard' });
      } catch {
        /* ignore */
      }
      conn.close();
      if (pricesWsRef.current === conn) {
        pricesWsRef.current = null;
      }
      setPricesWsReady(false);
    };
  }, [
    hasUsHoldings,
    upsertHoldingsPriceFromWs,
    isWeekendDay,
    isHolidayDay,
    isInTradingHours,
    isInNXTTradingHours,
    isInKRXAfterMarket,
    isInKRXExtendedClose,
  ]);

  // 보유 종목 구독 + Dashboard Trailing/주문번호 Status 구독
  useEffect(() => {
    if (!pricesWsReady || !pricesWsRef.current) return;
    const seen = new Set();
    const items = [];
    for (const h of holdings) {
      const code = holdingCodeKey(h.stockCode, h.stockMarket);
      if (!code || seen.has(code)) continue;
      seen.add(code);
      items.push({
        stockCode: code,
        stockName: resolveStockDisplayName(code, stockNameMap, h.stockName),
        stockMarket: isUsHoldingCode(code, h.stockMarket) ? 'US' : h.stockMarket || 'KRX',
      });
    }
    pricesWsRef.current.send({ type: 'set_holdings', items });
    pricesWsRef.current.send({ type: 'subscribe_dashboard' });
  }, [holdings, pricesWsReady, stockNameMap, isInTradingHours, isInNXTTradingHours, isInKRXAfterMarket, isInKRXExtendedClose]);

  // holdings 없이도 Dashboard Status만 구독
  useEffect(() => {
    if (!pricesWsReady || !pricesWsRef.current) return;
    pricesWsRef.current.send({ type: 'subscribe_dashboard' });
  }, [pricesWsReady]);

  // 관심종목명 로드 후, 코드로만 되어 있던 시세 이름 보정
  useEffect(() => {
    if (stockNameMap.size === 0) return;
    setHoldingsPrices((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        const resolved = resolveStockDisplayName(p.stockCode, stockNameMap, p.stockName);
        if (resolved && resolved !== p.stockName) {
          changed = true;
          return { ...p, stockName: resolved };
        }
        return p;
      });
      return changed ? next : prev;
    });
  }, [stockNameMap]);

  const holdingsPriceMap = useMemo(() => {
    const map = new Map();
    holdingsPrices.forEach((p) => {
      const key = holdingCodeKey(p.stockCode, p.stockMarket);
      if (key) map.set(key, p);
      if (p.stockCode) map.set(String(p.stockCode), p);
    });
    return map;
  }, [holdingsPrices]);

  // 종목별로 그룹화 (분할·무한 행을 한 카드에)
  const groupedHoldings = useMemo(() => {
    const grouped = new Map();

    holdings.forEach((item) => {
      const stockCode = holdingCodeKey(item.stockCode, item.stockMarket) || item.stockCode;
      if (!grouped.has(stockCode)) {
        grouped.set(stockCode, {
          key: stockCode,
          stockCode,
          stockName: item.stockName || null,
          stockMarket: item.stockMarket || (isUsHoldingCode(stockCode) ? 'US' : 'KRX'),
          buyItems: [],
        });
      }
      const g = grouped.get(stockCode);
      if (!g.stockName && item.stockName) g.stockName = item.stockName;
      g.buyItems.push(item);
    });

    return Array.from(grouped.values());
  }, [holdings]);

  const holdingsByRecent = useMemo(() => {
    const lastAt = (g) =>
      (g.buyItems || []).reduce((max, b) => {
        const t = String(b.dateTime || b.buyDate || '');
        return t > max ? t : max;
      }, '');
    return groupedHoldings
      .map((g) => ({ g, at: lastAt(g) }))
      .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1))
      .map(({ g }) => g);
  }, [groupedHoldings]);

  const [holdingsPage, setHoldingsPage] = useState(0);
  const [holdingsHover, setHoldingsHover] = useState(false);
  const holdingsPageCount = Math.max(1, Math.ceil(holdingsByRecent.length / HOLDINGS_PAGE_SIZE));
  const holdingsRotatePaused =
    holdingsHover || autoTradingDialogOpen || chartDialogOpen || !!liquidateTarget;

  useEffect(() => {
    if (holdingsPage >= holdingsPageCount) setHoldingsPage(0);
  }, [holdingsPage, holdingsPageCount]);

  useEffect(() => {
    if (holdingsPageCount <= 1 || holdingsRotatePaused) return undefined;
    const t = setInterval(
      () => setHoldingsPage((p) => (p + 1) % holdingsPageCount),
      HOLDINGS_ROTATE_MS
    );
    return () => clearInterval(t);
  }, [holdingsPageCount, holdingsRotatePaused, holdingsPage]);

  const visibleHoldings = useMemo(
    () =>
      holdingsByRecent.slice(
        holdingsPage * HOLDINGS_PAGE_SIZE,
        holdingsPage * HOLDINGS_PAGE_SIZE + HOLDINGS_PAGE_SIZE
      ),
    [holdingsByRecent, holdingsPage]
  );

  const holdingOrderNumbers = useMemo(() => {
    return orderStatuses;
  }, [orderStatuses]);

  const todayNow = new Date();
  const todayKey = `${todayNow.getFullYear()}-${String(todayNow.getMonth() + 1).padStart(2, '0')}-${String(
    todayNow.getDate()
  ).padStart(2, '0')}`;
  const todaySellTitle = `${todayNow.getFullYear()}년 ${String(todayNow.getMonth() + 1).padStart(2, '0')}월 ${String(
    todayNow.getDate()
  ).padStart(2, '0')}일 ${['일', '월', '화', '수', '목', '금', '토'][todayNow.getDay()]}요일 매도완료`;
  const todayTradeHistory = useMemo(
    () => tradeHistory.filter((item) => String(item.createdAt || '').slice(0, 10) === todayKey),
    [tradeHistory, todayKey]
  );

  // 관심종목 목록 조회 (종목명 매핑용 — 국내 + 미국)
  const fetchWatchlist = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/watchlist-v2');
      const nameMap = new Map();
      (data || []).forEach((item) => {
        const code = String(item.stockCode || '').trim();
        if (!code) return;
        const key = holdingCodeKey(code, item.stockMarket);
        const name = item.stockName || code;
        nameMap.set(code, name);
        if (key) nameMap.set(key, name);
      });
      setStockNameMap(nameMap);
    } catch (error) {
      console.error('[대시보드] 관심종목 조회 실패:', error);
    }
  }, []);

  // 매도완료 내역 조회
  const fetchTradeHistory = useCallback(async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // getMonth() is 0-indexed

    try {
      setTradeHistoryLoading(true);
      const [historyRes, settingsRes] = await Promise.all([
        apiClient.get('/holdings/trade-history', { params: { year, month } }),
        apiClient.get('/settings').catch(() => null),
      ]);
      setTradeHistory(historyRes.data || []);
      if (settingsRes?.data) {
        setBrokerFeeRates({
          buyFeeRate: Number(settingsRes.data.buyFeeRate) || DEFAULT_FEE_RATES.buyFeeRate,
          sellFeeRate: Number(settingsRes.data.sellFeeRate) || DEFAULT_FEE_RATES.sellFeeRate,
          sellTaxRate: Number(settingsRes.data.sellTaxRate) || DEFAULT_FEE_RATES.sellTaxRate,
          usBuyFeeRate:
            settingsRes.data.usBuyFeeRate != null &&
            Number.isFinite(Number(settingsRes.data.usBuyFeeRate))
              ? Number(settingsRes.data.usBuyFeeRate)
              : DEFAULT_FEE_RATES.usBuyFeeRate,
          usSellFeeRate:
            settingsRes.data.usSellFeeRate != null &&
            Number.isFinite(Number(settingsRes.data.usSellFeeRate))
              ? Number(settingsRes.data.usSellFeeRate)
              : DEFAULT_FEE_RATES.usSellFeeRate,
          usSellTaxRate:
            settingsRes.data.usSellTaxRate != null &&
            Number.isFinite(Number(settingsRes.data.usSellTaxRate))
              ? Number(settingsRes.data.usSellTaxRate)
              : DEFAULT_FEE_RATES.usSellTaxRate,
        });
      }
    } catch (error) {
      console.error('[대시보드] 매도완료 내역 조회 실패:', error);
    } finally {
      setTradeHistoryLoading(false);
    }
  }, []);

  const fetchPlanProgress = useCallback(async () => {
    try {
      setPlanProgressLoading(true);
      const response = await apiClient.get('/holdings/plan-progress');
      // investable 이 null 이면(서버 캐시 없음) 직전 값 유지, 아래 plan-investable 로 채움
      const keepInvestable = (next) => (prev) => ({
        ...EMPTY_PLAN_PROGRESS,
        ...next,
        investable: next?.investable ?? (prev.investable === EMPTY_PLAN_PROGRESS.investable ? null : prev.investable),
      });
      setKrPlanProgress(keepInvestable(response.data?.kr));
      setUsPlanProgress(keepInvestable(response.data?.us));
      if (response.data?.date) {
        setPlanProgressDate(response.data.date);
      }
      if (response.data?.kr?.investable && response.data?.us?.investable) return;
    } catch (error) {
      console.error('[대시보드] Plan 진행사항 조회 실패:', error);
      setKrPlanProgress(EMPTY_PLAN_PROGRESS);
      setUsPlanProgress(EMPTY_PLAN_PROGRESS);
      return;
    } finally {
      setPlanProgressLoading(false);
    }

    try {
      const { data } = await apiClient.get('/holdings/plan-investable');
      setKrPlanProgress((prev) => ({ ...prev, investable: data?.kr || EMPTY_PLAN_PROGRESS.investable }));
      setUsPlanProgress((prev) => ({ ...prev, investable: data?.us || EMPTY_PLAN_PROGRESS.investable }));
    } catch (error) {
      console.error('[대시보드] 투자가능금액 조회 실패:', error);
      setKrPlanProgress((prev) => ({ ...prev, investable: prev.investable || EMPTY_PLAN_PROGRESS.investable }));
      setUsPlanProgress((prev) => ({ ...prev, investable: prev.investable || EMPTY_PLAN_PROGRESS.investable }));
    }
  }, []);

  const exportTrailingLog = useCallback(async (side) => {
    setTrailingLogExporting(side);
    try {
      const { data } = await apiClient.post('/holdings/trailing-log-export', { side });
      if (typeof data.content === 'string') {
        // Windows 메모장 한글 깨짐 방지용 BOM
        const blob = new Blob(['\uFEFF', data.content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = data.fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setTrailingLogNotice({
        type: 'success',
        text: `${data.fileName} 저장·다운로드 완료 (${data.count}건) — 서버 backend/data 에도 저장됨`,
      });
    } catch (error) {
      setTrailingLogNotice({
        type: 'error',
        text: error.response?.data?.error || '로그 추출에 실패했습니다.',
      });
    } finally {
      setTrailingLogExporting(null);
    }
  }, []);

  const renderTrailingLogAction = (side, label) => (
    <Tooltip title={`오늘 ${label} 로그 저장·다운로드`}>
      <span>
        <IconButton
          size="small"
          onClick={() => exportTrailingLog(side)}
          disabled={trailingLogExporting !== null}
          sx={{ color: HOLDINGS_DASH.muted }}
        >
          {trailingLogExporting === side ? (
            <CircularProgress size={18} sx={{ color: HOLDINGS_DASH.muted }} />
          ) : (
            <NoteAltOutlinedIcon fontSize="small" />
          )}
        </IconButton>
      </span>
    </Tooltip>
  );

  const fetchTrailingStatus = useCallback(async (showLoading = true) => {
    // REST는 장외 동기화·스냅샷용 폴백. 장중은 WebSocket dashboard_status 사용.
    if (trailingStatusRequestInFlightRef.current) {
      return;
    }

    trailingStatusRequestInFlightRef.current = true;
    try {
      if (showLoading) {
        setTrailingStatusLoading(true);
      }
      const response = await apiClient.get('/holdings/trailing-status');
      setTrailingBuyStatuses(response.data?.buyStatuses || []);
      setTrailingSellStatuses(response.data?.sellStatuses || []);
    } catch (error) {
      console.error('[대시보드] Trailing Status 조회 실패:', error);
      setTrailingBuyStatuses([]);
      setTrailingSellStatuses([]);
    } finally {
      trailingStatusRequestInFlightRef.current = false;
      if (showLoading) {
        setTrailingStatusLoading(false);
      }
    }
  }, []);

  const fetchOrderStatuses = useCallback(async () => {
    if (orderStatusRequestInFlightRef.current) {
      return;
    }

    orderStatusRequestInFlightRef.current = true;
    try {
      const response = await apiClient.get('/holdings/order-status');
      setOrderStatuses(response.data || []);
    } catch (error) {
      console.error('[대시보드] 주문상태 조회 실패:', error);
    } finally {
      orderStatusRequestInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchDashboardSnapshot();
    fetchTradeHistory();
    fetchPlanProgress();
    fetchWatchlist();
  }, [fetchDashboardSnapshot, fetchTradeHistory, fetchPlanProgress, fetchWatchlist]);

  // 장외 전환 시에만 Trailing/주문상태 REST 1회 동기화 (장중은 WS)
  useEffect(() => {
    const isActiveMarket = !isWeekendDay && !isHolidayDay && (isInTradingHours || isInNXTTradingHours || isInKRXAfterMarket || isInKRXExtendedClose);
    if (!isActiveMarket) {
      if (wasActiveMarketRef.current) {
        fetchTrailingStatus(false);
        fetchOrderStatuses();
      }
      wasActiveMarketRef.current = false;
      return;
    }
    wasActiveMarketRef.current = true;
  }, [
    fetchTrailingStatus,
    fetchOrderStatuses,
    isWeekendDay,
    isHolidayDay,
    isInTradingHours,
    isInNXTTradingHours,
    isInKRXAfterMarket,
    isInKRXExtendedClose,
  ]);

  // 반복자동매매설정 저장 후 매수종목 및 매도완료 내역 리프레시
  useEffect(() => {
    const handleRefreshHoldings = () => {
      console.log('[Dashboard] 반복자동매매설정 저장으로 인한 매수종목 및 매도완료 내역 리프레시');
      fetchDashboardSnapshot();
      fetchTradeHistory();
      fetchPlanProgress();
    };

    window.addEventListener('refreshHoldings', handleRefreshHoldings);
    return () => {
      window.removeEventListener('refreshHoldings', handleRefreshHoldings);
    };
  }, [fetchDashboardSnapshot, fetchTradeHistory, fetchPlanProgress]);

  // 자동매매 Ver.2 플랜 조회
  const fetchAutoTradingData = useCallback(async (stockCode, stockMarket = 'KRX', planId = null) => {
    try {
      setAutoTradingLoading(true);
      if (planId) {
        const response = await apiClient.get(`/trading-v2/plans/${planId}`);
        setAutoTradingData({
          source: 'v2',
          plan: response.data?.plan || null,
          stockCode,
          stockMarket,
        });
        return;
      }
      setAutoTradingData(null);
    } catch (error) {
      console.error('[Dashboard] 자동매매 설정 조회 실패:', error);
      if (error.response?.status === 404) {
        setAutoTradingData(null);
      } else {
        setErrorMessage('자동매매 설정 조회 중 오류가 발생했습니다.');
      }
    } finally {
      setAutoTradingLoading(false);
    }
  }, []);

  // 자동매매 설정 다이얼로그 열기
  const handleOpenAutoTradingDialog = useCallback((stockCode, stockName, stockMarket = 'KRX', planId = null) => {
    setSelectedStockCode(stockCode);
    setSelectedStockName(stockName);
    setAutoTradingDialogOpen(true);
    fetchAutoTradingData(stockCode, stockMarket, planId);
  }, [fetchAutoTradingData]);

  // 반복매매설정 다이얼로그 닫기
  const handleCloseAutoTradingDialog = useCallback(() => {
    setAutoTradingDialogOpen(false);
    setSelectedStockCode(null);
    setSelectedStockName(null);
    setAutoTradingData(null);
  }, []);

  // 매수종목 일봉 차트
  const handleOpenChart = useCallback(async (stock) => {
    if (!stock?.stockCode) return;
    setChartDialogStock(stock);
    setChartBuyLevels([]);
    setChartTradeMarkers([]);
    setChartDialogOpen(true);
    try {
      const planIds = [
        ...new Set(
          (stock.planIds || []).concat(stock.planId != null ? [stock.planId] : []).filter(Boolean)
        ),
      ];
      if (planIds.length > 0) {
        const buyLevels = [];
        const tradeMarkers = [];
        for (const pid of planIds) {
          const { data } = await apiClient.get(`/trading-v2/plans/${pid}`);
          const overlays = buildChartOverlaysFromV2Plan(data?.plan);
          buyLevels.push(...overlays.buyLevels);
          tradeMarkers.push(...overlays.tradeMarkers);
        }
        setChartBuyLevels(buyLevels);
        setChartTradeMarkers(tradeMarkers);
      }
    } catch (error) {
      if (error.response?.status !== 404) {
        console.error('[Dashboard] 차트용 자동매매 조회 실패:', error);
      }
      setChartBuyLevels([]);
      setChartTradeMarkers([]);
    }
  }, []);

  const handleCloseChart = useCallback(() => {
    setChartDialogOpen(false);
    setChartDialogStock(null);
    setChartBuyLevels([]);
    setChartTradeMarkers([]);
  }, []);

  const formatPercent = (value) => {
    if (!value && value !== 0) return '-';
    return `${parseFloat(value || 0).toFixed(2)}%`;
  };

  const renderTrailingStatusTable = (items, type) => {
    const isBuy = type === 'buy';
    const rateKey = isBuy ? 'risePercent' : 'dropPercent';
    const basePriceKey = isBuy ? 'lowPrice' : 'highPrice';

    return (
      <TableContainer
        sx={{
          bgcolor: 'transparent',
        }}
      >
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell align="center" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>종목</TableCell>
              <TableCell align="center" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>차수</TableCell>
              <TableCell align="center" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>
                {isBuy ? 'Low' : 'High'}
              </TableCell>
              <TableCell align="center" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>Cur</TableCell>
              <TableCell align="center" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>
                {isBuy ? '상승률' : '하락률'}
              </TableCell>
              <TableCell align="center" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>기준</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((item) => {
              const displayName = resolveStockDisplayName(
                item.stockCode,
                stockNameMap,
                item.stockName
              );
              const isUs = isUsHoldingCode(item.stockCode, item.stockMarket);
              return (
              <TableRow key={item.checkKey || `${type}_${item.stockCode}_${item.stage}_${item.planId || 'v1'}`}>
                <TableCell
                  align="center"
                  sx={{
                    ...dashTableBodyCellSx,
                    px: 0.5,
                    color: isUs ? '#C9A227' : undefined,
                    fontWeight: isUs ? 700 : undefined,
                  }}
                >
                  {displayName ? `${displayName} (${item.stockCode})` : item.stockCode}
                </TableCell>
                <TableCell align="center" sx={{ ...dashTableBodyCellSx, px: 0.5 }}>{item.stage}차</TableCell>
                <TableCell align="center" sx={{ ...dashTableBodyCellSx, px: 0.5 }}>
                  {isUs ? `$${formatUsMoney(item[basePriceKey])}` : formatNumber(item[basePriceKey])}
                </TableCell>
                <TableCell align="center" sx={{ ...dashTableBodyCellSx, px: 0.5 }}>
                  {isUs ? `$${formatUsMoney(item.curPrice)}` : formatNumber(item.curPrice)}
                </TableCell>
                <TableCell align="center" sx={{ ...dashTableBodyCellSx, px: 0.5 }}>
                  <Typography
                    variant="body2"
                    sx={{
                      color: isBuy ? HOLDINGS_DASH.red : HOLDINGS_DASH.blue,
                      fontWeight: 700,
                    }}
                  >
                    {Number(item[rateKey] || 0).toFixed(2)}%
                  </Typography>
                </TableCell>
                <TableCell align="center" sx={{ ...dashTableBodyCellSx, px: 0.5 }}>{formatPercent(item.trailingPercent)}</TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    );
  };

  return (
    <PageFrame>
      <Paper sx={{ px: 2, py: 1.25, mb: 2 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            flexWrap: 'wrap',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <DashboardIcon sx={{ fontSize: '1.05rem', color: '#80cbc4' }} />
            <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
              {user && (
                <Box component="span" sx={{ fontWeight: 'normal', mr: 0.75 }}>
                  {user.username || user.email}
                </Box>
              )}
              대시보드
            </Typography>
          </Box>
          <MarketSessionStatusBar />
        </Box>
      </Paper>

      {errorMessage && (
        <Alert
          severity="warning"
          sx={{
            mb: 3,
            bgcolor: (theme) =>
              theme.palette.mode === 'dark' ? 'rgba(187, 128, 9, 0.12)' : 'rgba(154, 103, 0, 0.1)',
            color: (theme) => (theme.palette.mode === 'dark' ? '#e3b341' : '#9a6700'),
            border: '1px solid',
            borderColor: (theme) =>
              theme.palette.mode === 'dark' ? 'rgba(187, 128, 9, 0.35)' : 'rgba(154, 103, 0, 0.35)',
            '& .MuiAlert-icon': {
              color: (theme) => (theme.palette.mode === 'dark' ? '#e3b341' : '#9a6700'),
            },
          }}
          onClose={() => setErrorMessage(null)}
        >
          {errorMessage}
        </Alert>
      )}

      {/* 매수종목만 표시 */}
      <Paper
        elevation={0}
        sx={{
          p: 1,
          ...dashDarkPaperSx,
        }}
      >
        {holdingsLoading ? (
          <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
            <CircularProgress size={28} sx={{ color: HOLDINGS_DASH.muted }} />
            <Typography variant="body2" sx={{ ml: 2, color: HOLDINGS_DASH.muted }}>
              보유종목을 불러오는 중...
            </Typography>
          </Box>
        ) : groupedHoldings.length === 0 ? (
          <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
            <Typography variant="body2" sx={{ color: HOLDINGS_DASH.muted }}>
              보유종목이 없습니다.
            </Typography>
          </Box>
        ) : (
          <Box
            onMouseEnter={() => setHoldingsHover(true)}
            onMouseLeave={() => setHoldingsHover(false)}
          >
            <Fade in key={holdingsPage} timeout={300}>
            <Grid container rowSpacing={2} columnSpacing={1.5} alignItems="stretch">
              {visibleHoldings.map((group) => {
                const priceInfo =
                  holdingsPriceMap.get(group.stockCode) ||
                  holdingsPriceMap.get(holdingCodeKey(group.stockCode, group.stockMarket));
                const stockName = resolveStockDisplayName(
                  group.stockCode,
                  stockNameMap,
                  group.stockName,
                  priceInfo?.stockName
                );

                return (
                  <Grid item xs={12} sm={6} md={4} key={group.key || group.stockCode}>
                    <StockCard
                      stockCode={group.stockCode}
                      stockName={stockName}
                      priceInfo={priceInfo || { stockMarket: group.stockMarket }}
                      buyItems={group.buyItems}
                      priceLoading={holdingsPriceLoading}
                      onOpenAutoTradingDialog={handleOpenAutoTradingDialog}
                      onOpenChart={handleOpenChart}
                      onOpenLiquidate={setLiquidateTarget}
                      feeRates={brokerFeeRates}
                    />
                  </Grid>
                );
              })}
            </Grid>
            </Fade>
            {holdingsPageCount > 1 && (
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: 0.75,
                  mt: 1,
                }}
              >
                {Array.from({ length: holdingsPageCount }, (_, i) => (
                  <Box
                    key={i}
                    component="button"
                    type="button"
                    onClick={() => setHoldingsPage(i)}
                    aria-label={`보유종목 ${i + 1}페이지`}
                    sx={{
                      width: i === holdingsPage ? 18 : 8,
                      height: 8,
                      p: 0,
                      border: 0,
                      borderRadius: 999,
                      cursor: 'pointer',
                      bgcolor: i === holdingsPage ? 'primary.main' : 'action.selected',
                      transition: 'width 0.2s ease, background-color 0.2s ease',
                    }}
                  />
                ))}
                <Typography
                  variant="caption"
                  sx={{ ml: 0.5, color: HOLDINGS_DASH.muted, fontVariantNumeric: 'tabular-nums' }}
                >
                  {holdingsPage + 1}/{holdingsPageCount}
                  {holdingsRotatePaused ? ' · 일시정지' : ''}
                </Typography>
              </Box>
            )}
          </Box>
        )}
      </Paper>

      {/* Trailing Buy / Sell / 주문번호 — 보유종목처럼 한 Paper 안 섹션 */}
      <Box sx={{ mt: 2 }}>
        {trailingLogNotice && (
          <Alert
            severity={trailingLogNotice.type}
            sx={{ mb: 1.5 }}
            onClose={() => setTrailingLogNotice(null)}
          >
            {trailingLogNotice.text}
          </Alert>
        )}
        <Grid container rowSpacing={2} columnSpacing={1.5} alignItems="stretch">
          <Grid item xs={12} md={4}>
            <DashStatusCard
              icon={TrendingUpIcon}
              iconColor="#2e9e6b"
              title="Trailing Buy Status"
              action={renderTrailingLogAction('buy', 'Trailing Buy')}
            >
              {trailingStatusLoading ? (
                <Typography variant="body2" sx={{ color: HOLDINGS_DASH.muted, pl: 6 }}>
                  trailingstop 진행중 상태를 불러오는 중...
                </Typography>
              ) : trailingBuyStatuses.length === 0 ? (
                <Typography variant="body2" sx={{ color: HOLDINGS_DASH.muted, pl: 6 }}>
                  진행중인 Trailing Buy가 없습니다.
                </Typography>
              ) : (
                renderTrailingStatusTable(trailingBuyStatuses, 'buy')
              )}
            </DashStatusCard>
          </Grid>

          <Grid item xs={12} md={4}>
            <DashStatusCard
              icon={ShieldIcon}
              iconColor="#1f6feb"
              title="Trailing Sell Status"
              action={renderTrailingLogAction('sell', 'Trailing Sell')}
            >
              {trailingStatusLoading ? (
                <Typography variant="body2" sx={{ color: HOLDINGS_DASH.muted, pl: 6 }}>
                  trailingstop 진행중 상태를 불러오는 중...
                </Typography>
              ) : trailingSellStatuses.length === 0 ? (
                <Typography variant="body2" sx={{ color: HOLDINGS_DASH.muted, pl: 6 }}>
                  진행중인 Trailing Sell이 없습니다.
                </Typography>
              ) : (
                renderTrailingStatusTable(trailingSellStatuses, 'sell')
              )}
            </DashStatusCard>
          </Grid>

          <Grid item xs={12} md={4}>
            <DashStatusCard
              icon={DescriptionIcon}
              iconColor="#8957e5"
              title="주문번호"
              subtitle="실제 지정가 주문가격을 표시합니다."
            >
              {holdingsLoading ? (
                <Box display="flex" justifyContent="center" alignItems="center" minHeight="44px">
                  <CircularProgress size={20} sx={{ color: HOLDINGS_DASH.muted }} />
                  <Typography variant="body2" sx={{ ml: 1, color: HOLDINGS_DASH.muted }}>
                    불러오는 중...
                  </Typography>
                </Box>
              ) : holdingOrderNumbers.length === 0 ? (
                <Typography variant="body2" sx={{ color: HOLDINGS_DASH.muted, pl: 6 }}>
                  표시할 주문번호가 없습니다.
                </Typography>
              ) : (
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                    columnGap: 2,
                    rowGap: 1.5,
                  }}
                >
                  {holdingOrderNumbers.map((item) => {
                    const isUs = isUsHoldingCode(item.stockCode, item.stockMarket);
                    const orderPriceStr = formatNumber(item.orderPrice);
                    const orderPriceDisplay =
                      orderPriceStr === '-' ? '-' : isUs ? `$${orderPriceStr}` : `${orderPriceStr}원`;
                    const displayName = resolveStockDisplayName(
                      item.stockCode,
                      stockNameMap,
                      item.stockName
                    );
                    const statusColor = item.status === '체결완료' ? '#3fb950' : '#d29922';
                    return (
                      <Box
                        key={`${item.source || 'v1'}_${item.planId || 0}_${item.stockCode}_${item.stage}_${item.orderNo}`}
                        sx={{ py: 0.5 }}
                      >
                        <Typography
                          variant="body2"
                          sx={{ color: isUs ? '#C9A227' : HOLDINGS_DASH.muted, wordBreak: 'break-word' }}
                        >
                          {displayName} ({item.stockCode}) ({item.stage}차)
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap' }}>
                          <Typography variant="body1" sx={{ fontWeight: 700, color: HOLDINGS_DASH.text }}>
                            {item.orderNo}
                          </Typography>
                          <Typography
                            variant="caption"
                            sx={{ fontWeight: 700, color: statusColor, whiteSpace: 'nowrap' }}
                          >
                            {item.status || '주문접수'}
                          </Typography>
                        </Box>
                        <Typography
                          variant="body2"
                          sx={{ fontWeight: 700, color: statusColor, wordBreak: 'break-word' }}
                        >
                          주문가격 : {orderPriceDisplay}
                        </Typography>
                      </Box>
                    );
                  })}
                </Box>
              )}
            </DashStatusCard>
          </Grid>
        </Grid>
      </Box>

      {/* 매도완료 / Plan 진행사항 분할 섹션 */}
      <Grid container rowSpacing={3} columnSpacing={1.5} sx={{ mt: -0.5 }} alignItems="stretch">
        <Grid
          item
          xs={12}
          md={6}
          sx={{ flexBasis: { md: 'calc(50% - 6px)' }, maxWidth: { md: 'calc(50% - 6px)' } }}
        >
          <Paper elevation={0} sx={{ p: 2.5, ...dashDarkPaperSx, height: '100%' }}>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={0.25}>
              <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '1rem', color: HOLDINGS_DASH.text }}>
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                  <CalendarMonthIcon sx={{ fontSize: '1.4rem', color: '#4c9aff' }} />
                  {todaySellTitle}
                </Box>
              </Typography>
            </Box>

            <TableContainer
              sx={{
                bgcolor: 'transparent',
              }}
            >
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ '& .MuiTableCell-root': { pt: 0.25 } }}>
                    <TableCell
                      align="center"
                      sx={{ ...dashTableHeadCellSx, px: 0.25, width: 72, whiteSpace: 'nowrap' }}
                    >
                      Date
                    </TableCell>
                    <TableCell align="center" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>종목명</TableCell>
                    <TableCell align="center" sx={{ ...dashTableHeadCellSx, px: 0.25, width: 40, whiteSpace: 'nowrap' }}>
                      차수
                    </TableCell>
                    <TableCell align="right" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>Buy Price</TableCell>
                    <TableCell align="right" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>Sell Price</TableCell>
                    <TableCell align="right" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>Sell Qty</TableCell>
                    <TableCell align="right" sx={{ ...dashTableHeadCellSx, px: 0.5 }}>Profit</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tradeHistoryLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} align="center" sx={{ py: 4, borderColor: HOLDINGS_DASH.border }}>
                        <CircularProgress sx={{ color: HOLDINGS_DASH.muted }} />
                        <Typography variant="body2" sx={{ mt: 2, color: HOLDINGS_DASH.muted }}>
                          매도완료 History를 불러오는 중...
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : todayTradeHistory.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} align="center" sx={{ py: 3, borderColor: HOLDINGS_DASH.border }}>
                        <DescriptionOutlinedIcon sx={{ fontSize: '1.9rem', color: HOLDINGS_DASH.text, mb: 0.75 }} />
                        <Typography variant="body2" sx={{ color: HOLDINGS_DASH.text }}>
                          거래 내역이 없습니다.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    todayTradeHistory.map((item, index) => {
                      const buyPrice = parseFloat(item.buy_price || 0);
                      const sellPrice = parseFloat(item.sell_price || 0);
                      const sellQty = parseInt(item.sell_qty || 0);
                      const profitResult = calculateProfit({
                        buyPrice,
                        sellPrice,
                        qty: sellQty,
                        stockMarket: item.stockMarket,
                        feeRates: brokerFeeRates,
                      });
                      const profit = profitResult.profitAmount;
                      const date = item.createdAt || '-';
                      const isUs = isUsHoldingCode(item.stockCode, item.stockMarket);
                      const stageLabel =
                        String(item.strategyType || '').toUpperCase() === 'INFINITE_TRADE'
                          ? '무한'
                          : item.sell_cur != null && Number(item.sell_cur) > 0
                            ? `${Number(item.sell_cur)}차`
                            : '-';

                      const stockName = item.stockName || stockNameMap.get(item.stockCode) || item.stockCode;

                      return (
                        <TableRow key={`${item.stockCode}_${item.createdAt}_${index}`}>
                          <TableCell
                            align="center"
                            sx={{ ...dashTableBodyCellSx, px: 0.25, width: 72, whiteSpace: 'nowrap' }}
                          >
                            {date}
                          </TableCell>
                          <TableCell
                            align="center"
                            sx={{
                              ...dashTableBodyCellSx,
                              px: 0.5,
                              color: isUs ? '#C9A227' : undefined,
                              fontWeight: isUs ? 700 : undefined,
                            }}
                          >
                            {stockName}
                            {isUs ? ` (${String(item.stockCode).toUpperCase()})` : ''}
                            {item.orderReason === 'LIQUIDATE' && (
                              <Chip
                                size="small"
                                label="청산"
                                variant="outlined"
                                color="warning"
                                sx={{
                                  ml: 0.5,
                                  height: 16,
                                  fontSize: '0.58rem',
                                  color: '#fff',
                                  borderColor: '#fff',
                                  fontWeight: 700,
                                  verticalAlign: 'middle',
                                  '& .MuiChip-label': { px: 0.6 },
                                }}
                              />
                            )}
                          </TableCell>
                          <TableCell
                            align="center"
                            sx={{ ...dashTableBodyCellSx, px: 0.25, width: 40, whiteSpace: 'nowrap' }}
                          >
                            {stageLabel}
                          </TableCell>
                          <TableCell align="right" sx={{ ...dashTableBodyCellSx, px: 0.5, fontVariantNumeric: 'tabular-nums' }}>
                            {isUs ? `$${formatNumber(buyPrice)}` : formatNumber(buyPrice)}
                          </TableCell>
                          <TableCell align="right" sx={{ ...dashTableBodyCellSx, px: 0.5, fontVariantNumeric: 'tabular-nums' }}>
                            {isUs ? `$${formatNumber(sellPrice)}` : formatNumber(sellPrice)}
                          </TableCell>
                          <TableCell align="right" sx={{ ...dashTableBodyCellSx, px: 0.5, fontVariantNumeric: 'tabular-nums' }}>
                            {formatNumber(sellQty)}
                          </TableCell>
                          <TableCell align="right" sx={{ ...dashTableBodyCellSx, px: 0.5, fontVariantNumeric: 'tabular-nums' }}>
                            {isUs ? `$${formatNumber(profit)}` : formatNumber(profit)}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </Grid>

        <Grid item xs={12} md={3} sx={planStatusGridSx}>
          <Paper elevation={0} sx={{ p: 2.5, ...dashDarkPaperSx, height: '100%' }}>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
              <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '1rem', color: HOLDINGS_DASH.text }}>
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                  <FlagIcon country="KR" size={22} />
                  <Box component="span">KR Plan</Box>
                </Box>
              </Typography>
            </Box>
            <Box sx={{ borderBottom: '1px solid', borderColor: HOLDINGS_DASH.border, mb: 1.5 }} />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.1 }}>
              {renderPlanProgressRows(krPlanProgress, planProgressLoading)}
            </Box>
          </Paper>
        </Grid>

        <Grid item xs={12} md={3} sx={planStatusGridSx}>
          <Paper elevation={0} sx={{ p: 2.5, ...dashDarkPaperSx, height: '100%' }}>
            <Box display="flex" justifyContent="space-between" alignItems="flex-end" mb={1} gap={1}>
              <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '1rem', color: HOLDINGS_DASH.text }}>
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                  <FlagIcon country="US" size={22} />
                  <Box component="span">US Plan</Box>
                </Box>
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  color: (theme) => (theme.palette.mode === 'dark' ? '#9ec400' : '#6a8f00'),
                  whiteSpace: 'nowrap',
                  ml: 'auto',
                  textAlign: 'right',
                }}
              >
                {planProgressDate.year}년 {planProgressDate.month}월 {planProgressDate.day}일
              </Typography>
            </Box>
            <Box sx={{ borderBottom: '1px solid', borderColor: HOLDINGS_DASH.border, mb: 1.5 }} />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.1 }}>
              {renderPlanProgressRows(usPlanProgress, planProgressLoading)}
            </Box>
          </Paper>
        </Grid>
      </Grid>

      {/* 자동매매 설정 내역 다이얼로그 */}
      <Dialog
        open={autoTradingDialogOpen}
        onClose={handleCloseAutoTradingDialog}
        maxWidth="md"
        fullWidth
        PaperProps={{
          elevation: 0,
          sx: {
            ...dashDarkPaperSx,
            backgroundImage: 'none',
            border: 'none',
            maxWidth: '720px !important',
          },
        }}
      >
        <DialogTitle
          component="div"
          sx={{
            pb: 1,
            color: HOLDINGS_DASH.text,
            fontWeight: 700,
            fontSize: '1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1.5,
          }}
        >
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}>
            <SettingsIcon sx={{ fontSize: '1.25rem', color: '#ff9800' }} aria-hidden />
            자동매매 Ver.2 플랜
          </Box>
          {selectedStockName && (
            <Typography
              component="span"
              sx={{
                color: HOLDINGS_DASH.text,
                fontSize: '0.9375rem',
                fontWeight: 600,
                textAlign: 'right',
                lineHeight: 1.3,
              }}
            >
              {selectedStockName} ({selectedStockCode})
              {autoTradingData?.plan && (
                <> · {strategyTypeLabel(autoTradingData.plan.strategyType)} · #{autoTradingData.plan.id}</>
              )}
            </Typography>
          )}
        </DialogTitle>
        <DialogContent sx={{ pt: 2, pb: 1 }}>
          {autoTradingLoading ? (
            <Box display="flex" justifyContent="center" alignItems="center" py={4}>
              <CircularProgress sx={{ color: HOLDINGS_DASH.muted }} />
            </Box>
          ) : !autoTradingData?.plan ? (
            <Typography variant="body2" align="center" py={3} sx={{ color: HOLDINGS_DASH.muted }}>
              설정 내역이 없습니다.
            </Typography>
          ) : (
            <TableContainer sx={{ mt: 0, bgcolor: 'transparent' }}>
              {(() => {
                const plan = autoTradingData.plan;
                const cycleId = plan.currentCycleId != null ? Number(plan.currentCycleId) : null;
                const stages = (plan.stages || []).filter(
                  (s) => cycleId == null || Number(s.cycleId) === cycleId
                );
                const dialogIsUs = isUsHoldingCode(
                  selectedStockCode,
                  autoTradingData.stockMarket || plan.instrument?.market
                );
                const fmtPrice = (v) =>
                  dialogIsUs ? `$${formatUsMoney(v)}` : formatNumber(v);

                if (String(plan.strategyType).toUpperCase() === 'INFINITE_TRADE') {
                  const cfg = plan.strategyConfig || {};
                  const seedBudget = calcInfiniteSeedRemaining(plan);
                  const fmtAmt = (v) =>
                    v == null
                      ? '-'
                      : dialogIsUs
                        ? `$${formatUsMoney(v)}`
                        : formatNumber(v);
                  const seedLabel = fmtAmt(seedBudget.seed);
                  const remainingLabel = fmtAmt(seedBudget.remaining);
                  const unitLabel =
                    cfg.unitBuyAmount != null && cfg.unitBuyAmount !== ''
                      ? fmtAmt(cfg.unitBuyAmount)
                      : '-';

                  const orders = plan.orders || [];
                  const orderById = new Map(orders.map((o) => [Number(o.id), o]));
                  // 부분체결(fills 여러 건)은 주문 1건 = 1행으로 합산
                  const buyByOrder = new Map();
                  for (const f of plan.fills || []) {
                    const ord = orderById.get(Number(f.orderId));
                    if (!ord || String(ord.side || '').toUpperCase() !== 'BUY') continue;
                    if (cycleId != null && ord.cycleId != null && Number(ord.cycleId) !== cycleId) {
                      continue;
                    }
                    const q = Number(f.fillQty) || 0;
                    if (q <= 0) continue;
                    const p = Number(f.fillPrice) || 0;
                    const at = f.filledAt || f.createdAt || '';
                    const key = Number(f.orderId);
                    const prev = buyByOrder.get(key);
                    if (prev) {
                      prev.qty += q;
                      prev.amt += p * q;
                      if (at && (!prev.sortKey || String(at) < String(prev.sortKey))) prev.sortKey = at;
                    } else {
                      buyByOrder.set(key, { id: key, qty: q, amt: p * q, sortKey: at });
                    }
                  }
                  const buyRows = [...buyByOrder.values()]
                    .map((r) => ({
                      id: r.id,
                      date: r.sortKey ? formatKstDate(r.sortKey) : '-',
                      price: r.qty > 0 ? r.amt / r.qty : 0,
                      qty: r.qty,
                      sortKey: r.sortKey,
                    }))
                    .sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));

                  const infCellSx = {
                    ...dashTableBodyCellSx,
                    px: 0.5,
                    py: 0.55,
                    fontSize: '0.8125rem',
                    color: HOLDINGS_DASH.text,
                    whiteSpace: 'nowrap',
                  };
                  const infHeadSx = {
                    ...dashTableHeadCellSx,
                    px: 0.5,
                    py: 0.5,
                    fontSize: '0.75rem',
                    whiteSpace: 'nowrap',
                  };

                  return (
                    <>
                      <Box
                        sx={{
                          mb: 1.5,
                          color: HOLDINGS_DASH.text,
                          fontSize: '0.8125rem',
                          lineHeight: 1.6,
                          textAlign: 'left',
                        }}
                      >
                        무한매매 · 시드금액 {seedLabel} · 시드잔액 {remainingLabel} · 진입{' '}
                        {cfg.buyEntry != null ? fmtPrice(cfg.buyEntry) : '-'} · 단위금액 {unitLabel}{' '}
                        · 익절{' '}
                        {cfg.sellTargetPercent != null ? `${cfg.sellTargetPercent}%` : '10%'} · 상태{' '}
                        {plan.status}
                      </Box>
                      <Table size="small" sx={{ tableLayout: 'fixed', width: '100%' }}>
                        <TableHead>
                          <TableRow>
                            <TableCell align="left" sx={infHeadSx}>NO</TableCell>
                            <TableCell align="center" sx={infHeadSx}>매수일자</TableCell>
                            <TableCell align="center" sx={infHeadSx}>매수가</TableCell>
                            <TableCell align="center" sx={infHeadSx}>수량</TableCell>
                            <TableCell align="center" sx={infHeadSx}>평균단가</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {buyRows.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={5} align="center" sx={{ ...infCellSx, py: 3 }}>
                                매수 체결 내역이 없습니다.
                              </TableCell>
                            </TableRow>
                          ) : (
                            buyRows.map((row, idx) => {
                              let amtSum = 0;
                              let qtySum = 0;
                              for (let i = 0; i <= idx; i += 1) {
                                const r = buyRows[i];
                                if (r.price > 0 && r.qty > 0) {
                                  amtSum += r.price * r.qty;
                                  qtySum += r.qty;
                                }
                              }
                              const avg = qtySum > 0 ? amtSum / qtySum : 0;
                              return (
                                <TableRow key={`inf-buy-${row.id}`}>
                                  <TableCell align="left" sx={infCellSx}>{idx + 1}</TableCell>
                                  <TableCell align="center" sx={infCellSx}>{row.date}</TableCell>
                                  <TableCell align="center" sx={infCellSx}>
                                    {row.price > 0 ? fmtPrice(row.price) : '-'}
                                  </TableCell>
                                  <TableCell align="center" sx={infCellSx}>
                                    {row.qty > 0 ? formatNumber(row.qty) : '-'}
                                  </TableCell>
                                  <TableCell align="center" sx={infCellSx}>
                                    {avg > 0
                                      ? dialogIsUs
                                        ? fmtPrice(avg)
                                        : formatNumber(Math.round(avg))
                                      : '-'}
                                  </TableCell>
                                </TableRow>
                              );
                            })
                          )}
                        </TableBody>
                      </Table>
                    </>
                  );
                }

                const buyByStage = new Map();
                const sellByStage = new Map();
                stages.forEach((s) => {
                  const n = Number(s.stage);
                  if (!Number.isFinite(n)) return;
                  if (String(s.side).toUpperCase() === 'SELL') sellByStage.set(n, s);
                  else buyByStage.set(n, s);
                });
                const stageNos = [...new Set([...buyByStage.keys(), ...sellByStage.keys()])].sort(
                  (a, b) => a - b
                );
                const buyCols = ['차수', '%', '매수가', '수량', '상태'];
                const sellCols = ['%', '목표가', '수량', '상태'];
                const splitCellSx = {
                  ...dashTableBodyCellSx,
                  px: 0.4,
                  py: 0.55,
                  fontSize: '0.8125rem',
                  whiteSpace: 'nowrap',
                };
                const splitHeadSx = {
                  ...dashTableHeadCellSx,
                  px: 0.4,
                  py: 0.5,
                  fontSize: '0.75rem',
                  whiteSpace: 'nowrap',
                };
                const renderSplitSide = (s, { isBuy }) => {
                  const filled = isBuy && s && String(s.status) === 'filled';
                  // 매수 완료: 녹색 / 미완료·매도: 칼럼라벨과 같은 연한 회색
                  const tone = filled
                    ? { color: '#3fb950', fontWeight: 700 }
                    : { color: HOLDINGS_DASH.muted };
                  return (
                    <>
                      {isBuy && (
                        <TableCell align="center" sx={{ ...splitCellSx, ...tone }}>
                          {s?.stage ?? '-'}
                        </TableCell>
                      )}
                      <TableCell align="center" sx={{ ...splitCellSx, ...tone }}>
                        {s?.percent != null ? formatPercent(s.percent) : '-'}
                      </TableCell>
                      <TableCell align="center" sx={{ ...splitCellSx, ...tone }}>
                        {s?.targetPrice != null ? fmtPrice(s.targetPrice) : '-'}
                      </TableCell>
                      <TableCell align="center" sx={{ ...splitCellSx, ...tone }}>
                        {s?.targetQty != null ? formatNumber(s.targetQty) : '-'}
                      </TableCell>
                      <TableCell align="center" sx={{ ...splitCellSx, ...tone }}>
                        {formatTradingV2StageStatus(s?.status)}
                      </TableCell>
                    </>
                  );
                };

                return (
                  <Table size="small" sx={{ tableLayout: 'fixed', width: '100%' }}>
                    <TableHead>
                      <TableRow>
                        {buyCols.map((label) => (
                          <TableCell key={`buy-h-${label}`} align="center" sx={splitHeadSx}>
                            {label}
                          </TableCell>
                        ))}
                        {sellCols.map((label) => (
                          <TableCell key={`sell-h-${label}`} align="center" sx={splitHeadSx}>
                            {label}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {stageNos.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={buyCols.length + sellCols.length} align="center" sx={{ py: 3, borderColor: HOLDINGS_DASH.border }}>
                            <Typography variant="body2" sx={{ color: HOLDINGS_DASH.muted }}>
                              표시할 차수가 없습니다.
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ) : (
                        stageNos.map((n) => (
                          <TableRow key={`v2-split-${n}`}>
                            {renderSplitSide(buyByStage.get(n), { isBuy: true })}
                            {renderSplitSide(sellByStage.get(n), { isBuy: false })}
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                );
              })()}
              {String(autoTradingData.plan.strategyType || '').toUpperCase() === 'SPLIT_TRADE' && (
                <Typography
                  variant="caption"
                  sx={{
                    display: 'block',
                    mt: 1.25,
                    color: HOLDINGS_DASH.muted,
                    fontSize: '0.75rem',
                    textAlign: 'left',
                  }}
                >
                  매수가는 실제 매수체결가와 다를 수 있습니다
                </Typography>
              )}
            </TableContainer>
          )}
        </DialogContent>
        <DialogActions
          sx={{
            px: 3,
            py: 1,
            pb: 2,
            mt: -1,
            justifyContent: 'flex-end',
            gap: 1,
            // 전체 폭 구분선 제거 — 테이블 행 border와 맞춤
          }}
        >
          <Button
            onClick={handleCloseAutoTradingDialog}
            variant="outlined"
            sx={{
              borderColor: HOLDINGS_DASH.border,
              color: HOLDINGS_DASH.text,
              '&:hover': { borderColor: HOLDINGS_DASH.muted, bgcolor: 'action.hover' },
            }}
          >
            닫기
          </Button>
        </DialogActions>
      </Dialog>

      <StockDailyChartDialog
        open={chartDialogOpen}
        onClose={handleCloseChart}
        stockCode={chartDialogStock?.stockCode}
        stockName={chartDialogStock?.stockName}
        stockMarket={chartDialogStock?.stockMarket}
        stexTp={chartDialogStock?.stexTp}
        buyLevels={chartBuyLevels}
        tradeMarkers={chartTradeMarkers}
        enableTradingOverlays
      />

      <LiquidateDialog
        open={!!liquidateTarget}
        target={liquidateTarget}
        livePrice={
          liquidateTarget
            ? Number(
                (
                  holdingsPriceMap.get(liquidateTarget.stockCode) ||
                  holdingsPriceMap.get(
                    holdingCodeKey(liquidateTarget.stockCode, liquidateTarget.isUs ? 'US' : 'KRX')
                  )
                )?.price
              ) || liquidateTarget.price || 0
            : 0
        }
        onClose={() => setLiquidateTarget(null)}
        onDone={() => fetchDashboardSnapshot()}
      />
    </PageFrame>
  );
};

export default Dashboard;

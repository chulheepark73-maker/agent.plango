import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Typography,
  TextField,
  Button,
  Box,
  Alert,
  Paper,
  Tabs,
  Tab,
  FormControlLabel,
  Switch,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  CircularProgress,
  InputAdornment,
  Grid,
  IconButton,
  Tooltip,
} from '@mui/material';
import TuneIcon from '@mui/icons-material/Tune';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import ShieldIcon from '@mui/icons-material/Shield';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import SearchIcon from '@mui/icons-material/Search';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import apiClient from '../utils/axios';
import PageFrame, { pageHeaderSx } from '../components/PageFrame';
import { useAuth } from '../contexts/AuthContext';
import { formatNumber, formatKstDateTime } from '../utils/formatUtils';

const defaultSettings = {
  buyAmountKrw: 1000000,
  buyCondition: '',
  buyTimeStart: '15:00',
  buyTimeEnd: '15:20',
  useSplitBuy: false,
  buyEndMarketFill: false,
  buyLimitTickOffset: 2,
  sellLimitTickOffset: 2,
  useTakeProfit: true,
  takeProfitPercent: 1.5,
  useStopLoss: true,
  stopLossPercent: -1,
  useTrailingStop: false,
  trailingStopOnPercent: 2,
  trailingStopFromHighPercent: -1,
  useDailyMaSell: false,
  dailySellMa: 20,
  useMinuteMaSell: false,
  minuteChartSetting: 3,
  minuteSellMa: 20,
  maxTrackingStocks: 90,
  maxHoldingStocks: 5,
  maxUsageAmountKrw: 10000000,
};

function TabPanel({ children, value, index }) {
  if (value !== index) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 2 }}>
      {children}
    </Box>
  );
}

const cardFieldSx = { minWidth: 140, flex: '1 1 140px' };
const compactFieldSx = { width: 140, flex: '0 0 auto' };

const indicatorTabTitleFont = '1rem';
const indicatorTabBodyFont = '0.8125rem';
/** 달력 아이콘 (네이티브 date picker indicator 대체) */
const tradeDateCalendarIcon = (fill) => `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="${fill}"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 16H5V10h14v10ZM9 14H7v-2h2v2Zm4 0h-2v-2h2v2Zm4 0h-2v-2h2v2Zm-8 4H7v-2h2v2Zm4 0h-2v-2h2v2Zm4 0h-2v-2h2v2Z"/></svg>`
)}")`;
const tradeDateFieldSx = (theme) => {
  const textColor = theme.palette.mode === 'dark' ? '#e6edf3' : theme.palette.text.primary;
  const iconColor = theme.palette.mode === 'dark' ? '#e6edf3' : theme.palette.text.secondary;
  return {
    width: 160,
    colorScheme: 'light',
    '& .MuiOutlinedInput-root': {
      colorScheme: 'light',
    },
    '& .MuiInputBase-input': {
      fontSize: indicatorTabBodyFont,
      color: textColor,
      colorScheme: 'light',
      '&::-webkit-calendar-picker-indicator': {
        WebkitAppearance: 'none',
        appearance: 'none',
        backgroundColor: 'transparent',
        backgroundImage: tradeDateCalendarIcon(iconColor),
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center',
        backgroundSize: '18px 18px',
        width: '22px',
        height: '22px',
        cursor: 'pointer',
        filter: 'none',
        opacity: 1,
      },
      '&::-webkit-datetime-edit': { color: textColor },
      '&::-webkit-datetime-edit-fields-wrapper': { color: textColor },
      '&::-webkit-datetime-edit-text': { color: textColor },
      '&::-webkit-datetime-edit-month-field': { color: textColor },
      '&::-webkit-datetime-edit-day-field': { color: textColor },
      '&::-webkit-datetime-edit-year-field': { color: textColor },
    },
    '& .MuiInputLabel-root': { fontSize: indicatorTabBodyFont },
  };
};
const indicatorTabTableSx = {
  '& .MuiTableCell-root': { fontSize: indicatorTabBodyFont },
};

const getDefaultTradeRange = () => {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const fmt = (dt) => {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  const today = fmt(kst);
  return {
    startDate: today,
    endDate: today,
  };
};

const InlineFields = ({ children }) => (
  <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>{children}</Box>
);

const SectionCard = ({ title, icon: Icon, children }) => (
  <Paper sx={{ p: 3 }}>
    {title && (
      <Typography
        variant="h6"
        sx={{
          fontWeight: 'bold',
          mb: 2,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
        }}
      >
        {Icon && <Icon sx={{ fontSize: '1.05rem' }} />}
        {title}
      </Typography>
    )}
    {children}
  </Paper>
);

const IndicatorTrading = () => {
  const { user } = useAuth();
  const isFreeMember = user?.subscription !== 'Y';
  const [tab, setTab] = useState(0);
  const [settings, setSettings] = useState(defaultSettings);
  const [autoTradingEnabled, setAutoTradingEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [confirmAction, setConfirmAction] = useState(null); // 'start' | 'stop' | null
  const [confirming, setConfirming] = useState(false);
  const [buyConditions, setBuyConditions] = useState([]);
  const [conditionsLoading, setConditionsLoading] = useState(false);
  const [trackingStocks, setTrackingStocks] = useState([]);
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [tradeHistory, setTradeHistory] = useState([]);
  const [tradeLoading, setTradeLoading] = useState(false);
  const [tradeStartDate, setTradeStartDate] = useState(() => getDefaultTradeRange().startDate);
  const [tradeEndDate, setTradeEndDate] = useState(() => getDefaultTradeRange().endDate);
  const trackingRefreshLock = useRef(false);
  const [searchName, setSearchName] = useState('');
  const [searchingStock, setSearchingStock] = useState(false);
  const [foundStockCode, setFoundStockCode] = useState('');
  const [foundStockName, setFoundStockName] = useState('');
  const [manualAdding, setManualAdding] = useState(false);
  const [deleteManualTarget, setDeleteManualTarget] = useState(null);
  const [manualRemoving, setManualRemoving] = useState(false);

  // 거래 내역 합계 — 이익금액 합, 매수원금 대비 수익률
  const tradeTotals = useMemo(() => {
    let profitAmount = 0;
    let buyAmount = 0;
    let count = 0;
    for (const row of tradeHistory) {
      const profit = Number(row.profitAmount);
      if (Number.isFinite(profit)) profitAmount += profit;
      const price = Number(row.buyPrice);
      const qty = Number(row.buyQty);
      if (Number.isFinite(price) && Number.isFinite(qty)) buyAmount += price * qty;
      count += 1;
    }
    const profitRate = buyAmount > 0 ? (profitAmount / buyAmount) * 100 : null;
    return { profitAmount, buyAmount, profitRate, count };
  }, [tradeHistory]);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await apiClient.get('/indicator-trading/status');
      setSettings({ ...defaultSettings, ...data.settings });
      setAutoTradingEnabled(!!data.autoTradingEnabled);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '상태를 불러오지 못했습니다.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchConditions = useCallback(async () => {
    try {
      setConditionsLoading(true);
      const { data } = await apiClient.get('/indicator-trading/conditions');
      const list = Array.isArray(data.conditions) ? data.conditions : [];
      setBuyConditions(
        list.map((c) => ({
          value: String(c.seq ?? ''),
          label: c.name
            ? `${c.seq != null ? `${c.seq}. ` : ''}${c.name}`
            : String(c.seq ?? ''),
        })).filter((c) => c.value)
      );
    } catch (error) {
      setBuyConditions([]);
      setMessage({
        type: 'warning',
        text: error.response?.data?.error || '영웅문 조건식을 불러오지 못했습니다.',
      });
    } finally {
      setConditionsLoading(false);
    }
  }, []);

  const fetchTracking = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/indicator-trading/tracking');
      setTrackingStocks(Array.isArray(data.stocks) ? data.stocks : []);
    } catch (error) {
      console.error('[지표기반매매] 트래킹 조회 실패:', error);
    }
  }, []);

  const searchStockByName = useCallback(async (stockName) => {
    if (!stockName || stockName.length < 2) {
      return null;
    }
    try {
      setSearchingStock(true);
      const response = await apiClient.post('/watchlist-v2/search', {
        stockName: stockName.trim(),
      });
      if (response.data?.stockCode && response.data?.stockName) {
        return {
          stockCode: response.data.stockCode,
          stockName: response.data.stockName,
        };
      }
      return null;
    } catch (error) {
      if (error.response?.status !== 404) {
        console.error('[지표기반매매] 종목 검색 실패:', error.message);
      }
      return null;
    } finally {
      setSearchingStock(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (searchName.trim().length >= 2) {
        const result = await searchStockByName(searchName.trim());
        if (result) {
          setFoundStockCode(result.stockCode);
          setFoundStockName(result.stockName);
        } else {
          setFoundStockCode('');
          setFoundStockName('');
        }
      } else {
        setFoundStockCode('');
        setFoundStockName('');
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [searchName, searchStockByName]);

  const handleAddManualStock = useCallback(async () => {
    const trimmedName = searchName.trim();
    if (!trimmedName) {
      setMessage({ type: 'error', text: '종목명을 입력하세요.' });
      return;
    }

    let code = foundStockCode;
    let name = foundStockName || trimmedName;
    if (!code) {
      const result = await searchStockByName(trimmedName);
      if (!result?.stockCode) {
        setMessage({
          type: 'error',
          text: `종목명 "${trimmedName}"에 대한 종목 정보를 찾을 수 없습니다. 올바른 종목명을 입력해주세요.`,
        });
        return;
      }
      code = result.stockCode;
      name = result.stockName;
    }

    try {
      setManualAdding(true);
      setMessage({ type: '', text: '' });
      const { data } = await apiClient.post('/indicator-trading/tracking/manual', {
        stockCode: code,
        stockName: name,
      });
      setMessage({
        type: 'success',
        text:
          data.message +
          (data.buyLog ? ` · ${data.buyLog}` : autoTradingEnabled ? '' : ' (자동매매 OFF — 목록만 추가)'),
      });
      setSearchName('');
      setFoundStockCode('');
      setFoundStockName('');
      await fetchTracking();
      if (tab !== 0) setTab(0);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '종목 추가에 실패했습니다.',
      });
    } finally {
      setManualAdding(false);
    }
  }, [
    searchName,
    foundStockCode,
    foundStockName,
    searchStockByName,
    autoTradingEnabled,
    fetchTracking,
    tab,
  ]);

  const handleConfirmRemoveManual = useCallback(async () => {
    if (!deleteManualTarget?.stockCode) return;
    try {
      setManualRemoving(true);
      setMessage({ type: '', text: '' });
      const { data } = await apiClient.delete(
        `/indicator-trading/tracking/manual/${deleteManualTarget.stockCode}`
      );
      if (Array.isArray(data.stocks)) {
        setTrackingStocks(data.stocks);
      } else {
        await fetchTracking();
      }
      setMessage({
        type: 'success',
        text: data.message || `삭제됨: ${deleteManualTarget.stockName || deleteManualTarget.stockCode}`,
      });
      setDeleteManualTarget(null);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '종목 삭제에 실패했습니다.',
      });
    } finally {
      setManualRemoving(false);
    }
  }, [deleteManualTarget, fetchTracking]);

  const refreshTracking = useCallback(
    async (placeOrders = false) => {
      if (trackingRefreshLock.current) return;
      trackingRefreshLock.current = true;
      try {
        setTrackingLoading(true);
        setMessage({ type: '', text: '' });
        const { data } = await apiClient.post('/indicator-trading/tracking/refresh', {
          placeOrders,
        });
        setTrackingStocks(Array.isArray(data.stocks) ? data.stocks : []);
        setMessage({
          type: data.needsCondition ? 'info' : data.keptPrevious ? 'warning' : 'success',
          text:
            data.message ||
            (data.keptPrevious
              ? data.logs?.[0] || '조건검색 0건 — 이전 목록 유지'
              : `조건식 종목 ${data.stocks?.length || 0}개 불러옴`),
        });
      } catch (error) {
        setMessage({
          type: 'error',
          text: error.response?.data?.error || '조건식 종목 불러오기에 실패했습니다.',
        });
      } finally {
        setTrackingLoading(false);
        trackingRefreshLock.current = false;
      }
    },
    []
  );

  const fetchTradeHistory = useCallback(async () => {
    if (!tradeStartDate || !tradeEndDate) {
      setMessage({ type: 'warning', text: '조회 기간을 선택해 주세요.' });
      return;
    }
    if (tradeStartDate > tradeEndDate) {
      setMessage({ type: 'warning', text: '시작일이 종료일보다 늦을 수 없습니다.' });
      return;
    }
    try {
      setTradeLoading(true);
      setMessage({ type: '', text: '' });
      const { data } = await apiClient.get('/indicator-trading/trades', {
        params: { startDate: tradeStartDate, endDate: tradeEndDate },
      });
      setTradeHistory(Array.isArray(data.trades) ? data.trades : []);
    } catch (error) {
      setTradeHistory([]);
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '거래 내역 조회에 실패했습니다.',
      });
    } finally {
      setTradeLoading(false);
    }
  }, [tradeStartDate, tradeEndDate]);

  useEffect(() => {
    fetchStatus();
    fetchConditions();
  }, [fetchStatus, fetchConditions]);

  // 기본 탭(0)=실시간 트래킹 — 진입 시 바로 조건식 종목 로드
  useEffect(() => {
    if (tab !== 0) return undefined;
    fetchTracking();
    refreshTracking(false);
    return undefined;
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // 자동매매 ON — 서버 조건검색 실시간 편입 반영 (폴링)
  useEffect(() => {
    if (tab !== 0 || !autoTradingEnabled) return undefined;
    const id = setInterval(() => {
      fetchTracking();
    }, 20000);
    return () => clearInterval(id);
  }, [tab, autoTradingEnabled, fetchTracking]);

  useEffect(() => {
    if (tab !== 1) return undefined;
    fetchTradeHistory();
    return undefined;
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchSetting = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveSettings = async () => {
    try {
      setMessage({ type: '', text: '' });
      const { data } = await apiClient.post('/indicator-trading/settings', settings);
      const nextSettings = { ...defaultSettings, ...data.settings };
      setSettings(nextSettings);
      setMessage({ type: 'success', text: data.message || '설정이 저장되었습니다.' });
      // 매수조건 포함 설정 저장 후 트래킹을 새 조건으로 다시 조회
      if (String(nextSettings.buyCondition ?? '') !== '') {
        setTrackingStocks([]);
        await refreshTracking(false);
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '설정 저장에 실패했습니다.',
      });
    }
  };

  const handleBuyConditionChange = async (value) => {
    const next = String(value ?? '');
    patchSetting('buyCondition', next);
    try {
      setMessage({ type: '', text: '' });
      const payload = { ...settings, buyCondition: next };
      const { data } = await apiClient.post('/indicator-trading/settings', payload);
      setSettings({ ...defaultSettings, ...data.settings });
      setTrackingStocks([]);
      setMessage({
        type: 'success',
        text: `매수조건(seq=${next})이 저장되었습니다. 조건식 종목을 불러옵니다.`,
      });
      if (next !== '') {
        await refreshTracking(false);
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '매수조건 저장에 실패했습니다.',
      });
    }
  };

  const handleStart = async () => {
    try {
      setConfirming(true);
      setMessage({ type: '', text: '' });
      const { data } = await apiClient.post('/indicator-trading/start');
      setMessage({ type: 'success', text: data.message });
      setConfirmAction(null);
      await fetchStatus();
      if (data.tracking?.stocks) {
        setTrackingStocks(data.tracking.stocks);
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '자동매매 시작에 실패했습니다.',
      });
      setConfirmAction(null);
    } finally {
      setConfirming(false);
    }
  };

  const handleStop = async () => {
    try {
      setConfirming(true);
      setMessage({ type: '', text: '' });
      const { data } = await apiClient.post('/indicator-trading/stop');
      setMessage({ type: 'warning', text: data.message });
      setConfirmAction(null);
      await fetchStatus();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '자동매매 중지에 실패했습니다.',
      });
      setConfirmAction(null);
    } finally {
      setConfirming(false);
    }
  };

  const handleConfirmClose = () => {
    if (confirming) return;
    setConfirmAction(null);
  };

  const handleConfirmOk = () => {
    if (confirmAction === 'start') handleStart();
    else if (confirmAction === 'stop') handleStop();
  };

  return (
    <PageFrame>
      <Paper sx={pageHeaderSx}>
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
          <TuneIcon sx={{ fontSize: '1.05rem', color: '#ffeb3b' }} />
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            지표기반매매
          </Typography>
          <Chip
            label={autoTradingEnabled ? '자동매매 ON' : '자동매매 OFF'}
            size="small"
            variant={autoTradingEnabled ? 'filled' : 'outlined'}
            sx={{
              ml: 1,
              ...(autoTradingEnabled
                ? {
                    bgcolor: '#c5e1a5',
                    color: '#33691e',
                    fontWeight: 700,
                  }
                : {}),
            }}
          />
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, ml: 'auto', alignItems: 'center' }}>
            <Tooltip
              title={
                isFreeMember
                  ? '일반회원은 지표기반 자동매매를 사용할 수 없습니다. 프리미엄 구독 시 이용 가능합니다.'
                  : ''
              }
            >
              <span>
                <Button
                  variant="contained"
                  color="success"
                  size="small"
                  onClick={() => setConfirmAction('start')}
                  disabled={loading || autoTradingEnabled || isFreeMember}
                >
                  자동매매 ON
                </Button>
              </span>
            </Tooltip>
            <Button
              variant="contained"
              color="error"
              size="small"
              onClick={() => setConfirmAction('stop')}
              disabled={loading || !autoTradingEnabled}
            >
              자동매매 OFF
            </Button>
            <Button
              variant="outlined"
              size="small"
              onClick={handleSaveSettings}
              disabled={loading || tab !== 2}
            >
              설정 저장
            </Button>
          </Box>
        </Box>
        {isFreeMember && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
            일반회원은 지표기반 자동매매 ON을 사용할 수 없습니다. (프리미엄 구독 시 이용 가능)
          </Typography>
        )}
      </Paper>

      {message.text && (
        <Alert severity={message.type || 'info'} sx={{ mb: 2 }} onClose={() => setMessage({ type: '', text: '' })}>
          {message.text}
        </Alert>
      )}

      <Dialog
        open={!!confirmAction}
        onClose={handleConfirmClose}
        aria-labelledby="auto-trading-confirm-title"
        aria-describedby="auto-trading-confirm-description"
      >
        <DialogTitle id="auto-trading-confirm-title">
          {confirmAction === 'start' ? '자동매매 ON 확인' : '자동매매 OFF 확인'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="auto-trading-confirm-description">
            {confirmAction === 'start'
              ? '지표기반매매 자동매매를 시작하시겠습니까?'
              : '지표기반매매 자동매매를 중지하시겠습니까?'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleConfirmClose} disabled={confirming}>
            취소
          </Button>
          <Button
            onClick={handleConfirmOk}
            color={confirmAction === 'start' ? 'success' : 'error'}
            variant="contained"
            disabled={confirming}
            autoFocus
          >
            확인
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={!!deleteManualTarget}
        onClose={() => !manualRemoving && setDeleteManualTarget(null)}
        aria-labelledby="manual-delete-confirm-title"
      >
        <DialogTitle id="manual-delete-confirm-title">수동 종목 삭제</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {deleteManualTarget
              ? `${deleteManualTarget.stockName || ''} (${deleteManualTarget.stockCode})을(를) 트래킹에서 삭제할까요? 미체결 매수 주문이 있으면 취소합니다. 체결·보유 종목은 삭제할 수 없습니다.`
              : ''}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteManualTarget(null)} disabled={manualRemoving}>
            취소
          </Button>
          <Button
            onClick={handleConfirmRemoveManual}
            color="error"
            variant="contained"
            disabled={manualRemoving}
            autoFocus
          >
            {manualRemoving ? '삭제 중…' : '삭제'}
          </Button>
        </DialogActions>
      </Dialog>

      <Box>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ borderBottom: 1, borderColor: 'divider', mb: 0 }}
        >
          <Tab label="실시간 트래킹" />
          <Tab label="거래 내역" />
          <Tab label="주문설정" />
        </Tabs>

        <TabPanel value={tab} index={2}>
          <SectionCard>
            <InlineFields>
              <TextField
                size="small"
                label="매수 금액 (KRW)"
                value={settings.buyAmountKrw ? formatNumber(settings.buyAmountKrw) : ''}
                onChange={(e) => {
                  const rawValue = e.target.value.replace(/,/g, '').replace(/[^0-9]/g, '');
                  patchSetting('buyAmountKrw', rawValue === '' ? 0 : Number(rawValue));
                }}
                inputProps={{ inputMode: 'numeric' }}
                InputProps={{
                  endAdornment: (
                    <Typography variant="caption" sx={{ mr: 0.5, color: 'text.secondary' }}>
                      원
                    </Typography>
                  ),
                }}
                sx={compactFieldSx}
              />
              <FormControl size="small" sx={{ width: 320, flex: '0 0 auto' }}>
                <InputLabel>매수 조건</InputLabel>
                <Select
                  label="매수 조건"
                  value={settings.buyCondition ?? ''}
                  onChange={(e) => handleBuyConditionChange(e.target.value)}
                  disabled={conditionsLoading}
                >
                  {conditionsLoading && (
                    <MenuItem value="" disabled>
                      조건식 불러오는 중…
                    </MenuItem>
                  )}
                  {!conditionsLoading && buyConditions.length === 0 && (
                    <MenuItem value="" disabled>
                      불러온 조건식 없음
                    </MenuItem>
                  )}
                  {settings.buyCondition &&
                    !buyConditions.some((c) => c.value === settings.buyCondition) && (
                      <MenuItem value={settings.buyCondition}>
                        {settings.buyCondition} (저장된 값)
                      </MenuItem>
                    )}
                  {buyConditions.map((opt) => (
                    <MenuItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </InlineFields>
          </SectionCard>

          <SectionCard title="주문 설정" icon={ReceiptLongIcon}>
            <InlineFields>
              <TextField
                size="small"
                label="매수 지정가 기준틱"
                type="number"
                value={settings.buyLimitTickOffset}
                onChange={(e) => patchSetting('buyLimitTickOffset', Number(e.target.value))}
                sx={{ width: 130, minWidth: 130, flex: '0 0 auto' }}
              />
              <TextField
                size="small"
                label="매도 지정가 기준틱"
                type="number"
                value={settings.sellLimitTickOffset}
                onChange={(e) => patchSetting('sellLimitTickOffset', Number(e.target.value))}
                sx={{ width: 130, minWidth: 130, flex: '0 0 auto' }}
              />
              <Box
                sx={{
                  ml: 2,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.75,
                  flex: '0 0 auto',
                  flexWrap: 'wrap',
                }}
              >
                <AccessTimeIcon
                  sx={{ fontSize: '1.5rem', color: '#F9C74F', flexShrink: 0 }}
                  aria-hidden
                />
                <TextField
                  size="small"
                  label="매수시작"
                  type="time"
                  value={String(settings.buyTimeStart || '15:00').slice(0, 5)}
                  onChange={(e) => {
                    const v = String(e.target.value || '15:00').slice(0, 5);
                    patchSetting('buyTimeStart', v || '15:00');
                  }}
                  InputLabelProps={{ shrink: true }}
                  inputProps={{ step: 60 }}
                  sx={{
                    ...compactFieldSx,
                    width: 140,
                    '& input::-webkit-calendar-picker-indicator': {
                      cursor: 'pointer',
                      filter: (theme) => (theme.palette.mode === 'dark' ? 'invert(1)' : 'none'),
                      opacity: 1,
                    },
                  }}
                />
                <TextField
                  size="small"
                  label="매수종료"
                  type="time"
                  value={String(settings.buyTimeEnd || '15:20').slice(0, 5)}
                  onChange={(e) => {
                    const v = String(e.target.value || '15:20').slice(0, 5);
                    patchSetting('buyTimeEnd', v || '15:20');
                  }}
                  InputLabelProps={{ shrink: true }}
                  inputProps={{ step: 60 }}
                  sx={{
                    ...compactFieldSx,
                    width: 140,
                    '& input::-webkit-calendar-picker-indicator': {
                      cursor: 'pointer',
                      filter: (theme) => (theme.palette.mode === 'dark' ? 'invert(1)' : 'none'),
                      opacity: 1,
                    },
                  }}
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!settings.useSplitBuy}
                      onChange={(e) => patchSetting('useSplitBuy', e.target.checked)}
                      size="small"
                    />
                  }
                  label="분할매수 (기준틱 30% , -3틱추가 30% , -3틱추가 40%)"
                  sx={{ ml: 1, mr: 0, whiteSpace: 'nowrap' }}
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!settings.buyEndMarketFill}
                      onChange={(e) => patchSetting('buyEndMarketFill', e.target.checked)}
                      size="small"
                    />
                  }
                  label="[주문미체결시] 매수종료시간에 시장가매수"
                  sx={{ ml: 1, mr: 0, whiteSpace: 'nowrap' }}
                />
              </Box>
            </InlineFields>
          </SectionCard>

          <SectionCard title="익절 / 손절 / 트레일링 스탑 설정" icon={ShieldIcon}>
            <InlineFields>
              <FormControlLabel
                control={
                  <Switch
                    checked={settings.useTakeProfit}
                    onChange={(e) => patchSetting('useTakeProfit', e.target.checked)}
                    size="small"
                  />
                }
                label="익절 사용"
                sx={{ mr: 0, whiteSpace: 'nowrap' }}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={settings.useStopLoss}
                    onChange={(e) => patchSetting('useStopLoss', e.target.checked)}
                    size="small"
                  />
                }
                label="손절 사용"
                sx={{ mr: 0, whiteSpace: 'nowrap' }}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={settings.useTrailingStop}
                    onChange={(e) => patchSetting('useTrailingStop', e.target.checked)}
                    size="small"
                  />
                }
                label="트레일링 스탑 사용"
                sx={{ mr: 0, whiteSpace: 'nowrap' }}
              />
              <TextField
                size="small"
                label="익절 (%)"
                type="number"
                value={settings.takeProfitPercent}
                onChange={(e) => patchSetting('takeProfitPercent', Number(e.target.value))}
                disabled={!settings.useTakeProfit}
                sx={cardFieldSx}
              />
              <TextField
                size="small"
                label="손절 (%)"
                type="number"
                value={settings.stopLossPercent}
                onChange={(e) => patchSetting('stopLossPercent', Number(e.target.value))}
                disabled={!settings.useStopLoss}
                sx={cardFieldSx}
              />
              <TextField
                size="small"
                label="트레일링 스탑 ON (%)"
                type="number"
                value={settings.trailingStopOnPercent}
                onChange={(e) => patchSetting('trailingStopOnPercent', Number(e.target.value))}
                disabled={!settings.useTrailingStop}
                sx={{ ...cardFieldSx, minWidth: 160 }}
              />
              <TextField
                size="small"
                label="트레일링 스탑 고점대비 (%)"
                type="number"
                value={settings.trailingStopFromHighPercent}
                onChange={(e) => patchSetting('trailingStopFromHighPercent', Number(e.target.value))}
                disabled={!settings.useTrailingStop}
                sx={{ ...cardFieldSx, minWidth: 180 }}
              />
            </InlineFields>
          </SectionCard>

          <SectionCard title="지표 기반 매도" icon={ShowChartIcon}>
            <InlineFields>
              <FormControlLabel
                control={
                  <Switch
                    checked={!!settings.useDailyMaSell}
                    onChange={(e) => patchSetting('useDailyMaSell', e.target.checked)}
                    size="small"
                  />
                }
                label="일봉 이평선 매도 사용"
                sx={{ mr: 0, whiteSpace: 'nowrap' }}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={!!settings.useMinuteMaSell}
                    onChange={(e) => patchSetting('useMinuteMaSell', e.target.checked)}
                    size="small"
                  />
                }
                label="분봉 이평선 매도 사용"
                sx={{ mr: 0, whiteSpace: 'nowrap' }}
              />
              <TextField
                size="small"
                label="일봉 매도 기준 이평선"
                type="number"
                value={settings.dailySellMa}
                onChange={(e) => patchSetting('dailySellMa', Number(e.target.value))}
                disabled={!settings.useDailyMaSell}
                sx={compactFieldSx}
              />
              <TextField
                size="small"
                label="분봉 설정"
                type="number"
                value={settings.minuteChartSetting}
                onChange={(e) => patchSetting('minuteChartSetting', Number(e.target.value))}
                disabled={!settings.useMinuteMaSell}
                sx={compactFieldSx}
              />
              <TextField
                size="small"
                label="분봉 매도 기준 이평선"
                type="number"
                value={settings.minuteSellMa}
                onChange={(e) => patchSetting('minuteSellMa', Number(e.target.value))}
                disabled={!settings.useMinuteMaSell}
                sx={compactFieldSx}
              />
            </InlineFields>
          </SectionCard>

          <SectionCard title="제한 설정" icon={TuneIcon}>
            <InlineFields>
              <TextField
                size="small"
                label="최대 트래킹 종목 수"
                type="number"
                value={settings.maxTrackingStocks}
                onChange={(e) => patchSetting('maxTrackingStocks', Number(e.target.value))}
                sx={cardFieldSx}
              />
              <TextField
                size="small"
                label="최대 보유 종목 수"
                type="number"
                value={settings.maxHoldingStocks}
                onChange={(e) => patchSetting('maxHoldingStocks', Number(e.target.value))}
                sx={cardFieldSx}
              />
              <TextField
                size="small"
                label="최대사용금액"
                value={settings.maxUsageAmountKrw ? formatNumber(settings.maxUsageAmountKrw) : ''}
                onChange={(e) => {
                  const rawValue = e.target.value.replace(/,/g, '').replace(/[^0-9]/g, '');
                  patchSetting('maxUsageAmountKrw', rawValue === '' ? 0 : Number(rawValue));
                }}
                inputProps={{ inputMode: 'numeric' }}
                InputProps={{
                  endAdornment: (
                    <Typography variant="caption" sx={{ mr: 0.5, color: 'text.secondary' }}>
                      원
                    </Typography>
                  ),
                }}
                sx={{ ...cardFieldSx, minWidth: 180 }}
              />
            </InlineFields>
          </SectionCard>
        </TabPanel>

        <TabPanel value={tab} index={1}>
          <Paper sx={{ p: 2 }}>
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 2,
                mb: 2,
              }}
            >
              <Typography
                variant="h6"
                sx={{
                  fontWeight: 'bold',
                  fontSize: indicatorTabTitleFont,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.75,
                  mr: 1,
                }}
              >
                <ReceiptLongIcon sx={{ fontSize: '0.95rem' }} />
                거래 내역
              </Typography>
              <TextField
                size="small"
                label="시작일"
                type="date"
                value={tradeStartDate}
                onChange={(e) => setTradeStartDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
                inputProps={{ style: { colorScheme: 'light' } }}
                sx={tradeDateFieldSx}
              />
              <TextField
                size="small"
                label="종료일"
                type="date"
                value={tradeEndDate}
                onChange={(e) => setTradeEndDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
                inputProps={{ style: { colorScheme: 'light' } }}
                sx={tradeDateFieldSx}
              />
              <Button
                variant="contained"
                onClick={fetchTradeHistory}
                disabled={tradeLoading}
              >
                조회
              </Button>
            </Box>

            <TableContainer sx={indicatorTabTableSx}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow sx={{ bgcolor: 'action.hover' }}>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>거래일자</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>종목명</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>매수가격</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>매수수량</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>매도가격</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>이익금액</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>이익비율(%)</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>매도사유</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tradeLoading && tradeHistory.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                        <CircularProgress size={28} />
                        <Typography variant="body2" sx={{ mt: 1, fontSize: indicatorTabBodyFont }}>
                          거래 내역을 불러오는 중…
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : tradeHistory.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                        해당 기간에 청산된 거래가 없습니다.
                      </TableCell>
                    </TableRow>
                  ) : (
                    tradeHistory.map((row) => {
                      const profitRate =
                        row.profitRate != null && row.profitRate !== ''
                          ? Number(row.profitRate)
                          : null;
                      const profitColor =
                        profitRate == null || !Number.isFinite(profitRate) || profitRate === 0
                          ? 'text.primary'
                          : profitRate > 0
                            ? 'error.main'
                            : 'primary.main';
                      return (
                        <TableRow key={row.id} hover>
                          <TableCell align="center">{row.tradeDate || '-'}</TableCell>
                          <TableCell align="center">
                            {row.stockName || row.stockCode || '-'}
                          </TableCell>
                          <TableCell align="center">
                            {row.buyPrice != null ? formatNumber(row.buyPrice) : '-'}
                          </TableCell>
                          <TableCell align="center">
                            {row.buyQty != null ? formatNumber(row.buyQty) : '-'}
                          </TableCell>
                          <TableCell align="center">
                            {row.sellPrice != null ? formatNumber(row.sellPrice) : '-'}
                          </TableCell>
                          <TableCell
                            align="center"
                            sx={{
                              color: profitColor,
                              fontWeight:
                                row.profitAmount != null && row.profitAmount !== 0 ? 600 : undefined,
                            }}
                          >
                            {row.profitAmount != null ? formatNumber(row.profitAmount) : '-'}
                          </TableCell>
                          <TableCell
                            align="center"
                            sx={{
                              color: profitColor,
                              fontWeight: profitRate != null && profitRate !== 0 ? 600 : undefined,
                            }}
                          >
                            {profitRate != null && Number.isFinite(profitRate)
                              ? profitRate.toFixed(2)
                              : '-'}
                          </TableCell>
                          <TableCell align="center">
                            {row.sellReasonLabel || row.sellReason || '-'}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                  {tradeHistory.length > 0 && (
                    <TableRow
                      sx={{
                        '& .MuiTableCell-root': {
                          bgcolor: 'action.hover',
                          fontWeight: 'bold',
                          borderTop: '2px solid',
                          borderTopColor: 'divider',
                        },
                      }}
                    >
                      <TableCell align="center" colSpan={5}>
                        합계 ({formatNumber(tradeTotals.count)}건)
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={{
                          color:
                            tradeTotals.profitAmount > 0
                              ? 'error.main'
                              : tradeTotals.profitAmount < 0
                                ? 'primary.main'
                                : 'text.primary',
                        }}
                      >
                        {formatNumber(Math.round(tradeTotals.profitAmount))}
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={{
                          color:
                            tradeTotals.profitRate > 0
                              ? 'error.main'
                              : tradeTotals.profitRate < 0
                                ? 'primary.main'
                                : 'text.primary',
                        }}
                      >
                        {tradeTotals.profitRate != null
                          ? tradeTotals.profitRate.toFixed(2)
                          : '-'}
                      </TableCell>
                      <TableCell align="center">-</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </TabPanel>

        <TabPanel value={tab} index={0}>
          <Paper sx={{ p: 2 }}>
            <Typography
              variant="h6"
              sx={{ fontWeight: 'bold', mb: 2, fontSize: indicatorTabTitleFont }}
            >
              실시간 트래킹
            </Typography>

            {String(settings.buyCondition ?? '') === '' && (
              <Alert severity="warning" sx={{ mb: 2, fontSize: indicatorTabBodyFont }}>
                주문설정에서 매수 조건(영웅문 조건식)을 선택·저장한 뒤 다시 열어 주세요.
              </Alert>
            )}

            <TableContainer sx={indicatorTabTableSx}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow sx={{ bgcolor: 'action.hover' }}>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>거래소</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>종목코드</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>종목명</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>편입시각</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>현재가</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>매입가</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>수익률(%)</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>일봉이평</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>분봉이평</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>매수주문상태</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>매도주문상태</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>삭제</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {trackingLoading && trackingStocks.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} align="center" sx={{ py: 4 }}>
                        <CircularProgress size={28} />
                        <Typography variant="body2" sx={{ mt: 1, fontSize: indicatorTabBodyFont }}>
                          조건식 종목을 불러오는 중…
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : trackingStocks.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                        트래킹 종목이 없습니다. 매수조건을 저장한 뒤 새로고침하세요.
                      </TableCell>
                    </TableRow>
                  ) : (
                    trackingStocks.map((row) => {
                      const profitRate =
                        row.buyOrderStatus === '체결 완료' &&
                        row.profitRate != null &&
                        row.profitRate !== ''
                          ? Number(row.profitRate)
                          : null;
                      const profitColor =
                        profitRate == null || !Number.isFinite(profitRate) || profitRate === 0
                          ? 'text.primary'
                          : profitRate > 0
                            ? 'error.main'
                            : 'primary.main';
                      const isManual = row.source === 'manual';
                      const holdingLocked =
                        isManual &&
                        !!row.positionId &&
                        (row.buyOrderStatus === '체결 완료' ||
                          row.buyOrderStatus === '매도중' ||
                          row.sellOrderStatus === '주문 완료');
                      return (
                      <TableRow key={row.stockCode} hover>
                        <TableCell align="center">{row.stockMarket || 'KRX'}</TableCell>
                        <TableCell align="center">{row.stockCode}</TableCell>
                        <TableCell align="center">
                          {row.stockName || '-'}
                          {isManual ? (
                            <Chip
                              label="수동"
                              size="small"
                              sx={{ ml: 0.75, height: 20, fontSize: '0.65rem' }}
                            />
                          ) : null}
                        </TableCell>
                        <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>
                          {formatKstDateTime(row.enteredAt || row.updatedAt)}
                        </TableCell>
                        <TableCell align="center">
                          {row.price != null ? formatNumber(row.price) : '-'}
                        </TableCell>
                        <TableCell align="center">
                          {row.buyPrice != null ? formatNumber(row.buyPrice) : '-'}
                        </TableCell>
                        <TableCell
                          align="center"
                          sx={{ color: profitColor, fontWeight: profitRate != null && profitRate !== 0 ? 600 : undefined }}
                        >
                          {profitRate != null && Number.isFinite(profitRate)
                            ? profitRate.toFixed(2)
                            : '-'}
                        </TableCell>
                        <TableCell align="center">{row.dailyMa ?? '-'}</TableCell>
                        <TableCell align="center">{row.minuteMa ?? '-'}</TableCell>
                        <TableCell align="center">{row.buyOrderStatus || '대기'}</TableCell>
                        <TableCell align="center">{row.sellOrderStatus || '대기'}</TableCell>
                        <TableCell align="center">
                          {isManual ? (
                            <Tooltip
                              title={
                                holdingLocked
                                  ? '체결·보유 종목은 삭제할 수 없습니다'
                                  : '수동 종목 삭제'
                              }
                            >
                              <span>
                                <IconButton
                                  size="small"
                                  color="error"
                                  disabled={holdingLocked || manualRemoving}
                                  onClick={() =>
                                    setDeleteManualTarget({
                                      stockCode: String(row.stockCode).substring(0, 6),
                                      stockName: row.stockName || '',
                                    })
                                  }
                                  aria-label="수동 종목 삭제"
                                >
                                  <DeleteOutlineIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          ) : (
                            '-'
                          )}
                        </TableCell>
                      </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>

          {/* 종목 검색 및 추가 — 리스트 아래, 관심종목과 동일 구성 */}
          <Paper sx={{ p: 3, mt: 0.3 }}>
            <Typography
              variant="h6"
              gutterBottom
              sx={{ fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
            >
              <AddCircleOutlineIcon sx={{ fontSize: '1.05rem' }} />
              종목추가
            </Typography>
            <Grid container spacing={2} alignItems="flex-start">
              <Grid item xs={12} sm={8}>
                <TextField
                  label="종목명"
                  fullWidth
                  value={searchName}
                  onChange={(e) => setSearchName(e.target.value)}
                  placeholder="예: 삼성전자"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddManualStock();
                    }
                  }}
                  InputProps={{
                    endAdornment: searchingStock ? (
                      <InputAdornment position="end">
                        <CircularProgress size={20} />
                      </InputAdornment>
                    ) : foundStockCode ? (
                      <InputAdornment position="end">
                        <Typography variant="body2" color="primary" sx={{ fontWeight: 'bold', mr: 1 }}>
                          {foundStockCode}
                        </Typography>
                      </InputAdornment>
                    ) : null,
                  }}
                  helperText={
                    searchingStock
                      ? '종목 정보를 검색하는 중...'
                      : foundStockCode
                        ? `종목명: ${foundStockName || searchName}`
                        : '종목명을 입력하면 자동으로 종목코드가 검색됩니다.'
                  }
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <Button
                  variant="contained"
                  startIcon={
                    manualAdding ? <CircularProgress size={18} color="inherit" /> : <SearchIcon />
                  }
                  onClick={handleAddManualStock}
                  disabled={loading || manualAdding || !searchName.trim()}
                  fullWidth
                  sx={{ height: '56px' }}
                >
                  추가
                </Button>
              </Grid>
            </Grid>
          </Paper>
        </TabPanel>
      </Box>
    </PageFrame>
  );
};

export default IndicatorTrading;

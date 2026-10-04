import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  IconButton,
  CircularProgress,
  Alert,
  FormControlLabel,
  Checkbox,
  Chip,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { createChart, ColorType, CrosshairMode, CandlestickSeries, LineSeries, HistogramSeries } from 'lightweight-charts';
import apiClient from '../utils/axios';

const MA_DEFS = [
  { period: 5, color: '#212121', key: 'ma5' },
  { period: 20, color: '#f9a825', key: 'ma20' },
  { period: 60, color: '#2e7d32', key: 'ma60' },
  { period: 120, color: '#9e9e9e', key: 'ma120' },
];

const INTERVAL_OPTIONS = [
  { value: 'day', label: '일봉' },
  { value: 'week', label: '주봉' },
  { value: 'month', label: '월봉' },
];

const toUnix = (dateStr) => {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
};

/** 이벤트 일자를 현재 봉(일/주/월) time에 매핑 */
const resolveBarUnix = (bars, dateStr) => {
  const d = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !bars?.length) return null;
  const exact = bars.find((b) => b.date === d);
  if (exact) return toUnix(exact.date);
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i].date >= d) return toUnix(bars[i].date);
  }
  return null;
};

const calcMa = (closes, period) => {
  const out = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i += 1) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out.push(sum / period);
    else out.push(null);
  }
  return out;
};

/**
 * 관심종목/보유종목 일봉 차트 다이얼로그 (캔들 + 이평 + 거래량)
 * enableTradingOverlays: 매수라인·차수·마커 표시 (관심종목·보유종목 공통)
 */
const StockDailyChartDialog = ({
  open,
  onClose,
  stockCode,
  stockName,
  stockMarket = 'KRX',
  stexTp = null,
  buyLevels = [],
  tradeMarkers = [],
  enableTradingOverlays = true,
}) => {
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [bars, setBars] = useState([]);
  const [showBuyLines, setShowBuyLines] = useState(false);
  const [showStageLabels, setShowStageLabels] = useState(true);
  const [showTradePoints, setShowTradePoints] = useState(true);
  const [chartInterval, setChartInterval] = useState('day');
  /** @type {[{ stage: number, top: number }]} */
  const [stagePills, setStagePills] = useState([]);
  /** 매수/매도 마커: 체결가(Y) · 일자(X) 좌표 오버레이 (B1/S1 …) */
  const [tradeMarkerOverlays, setTradeMarkerOverlays] = useState([]);
  /** 크로스헤어 가격+현재가대비% 커스텀 라벨 */
  const [crosshairLabel, setCrosshairLabel] = useState(null);
  const isUs = String(stockMarket || '').toUpperCase() === 'US';

  const formatPriceLabel = useCallback(
    (price) => {
      const n = Number(price);
      if (!Number.isFinite(n)) return String(price ?? '');
      if (isUs) {
        return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
      }
      return n.toLocaleString('ko-KR');
    },
    [isUs]
  );

  const activeBuyLevels = useMemo(
    () => {
      if (!enableTradingOverlays) return [];
      return (buyLevels || [])
        .map((lv) => ({
          stage: lv.stage,
          price: Number(lv.price) || 0,
        }))
        .filter((lv) => lv.price > 0);
    },
    [buyLevels, enableTradingOverlays]
  );

  const activeTradeMarkers = useMemo(() => {
    if (!enableTradingOverlays) return [];
    return Array.isArray(tradeMarkers) ? tradeMarkers : [];
  }, [tradeMarkers, enableTradingOverlays]);

  const refreshStagePills = useCallback(() => {
    const series = candleSeriesRef.current;
    if (!series || !showStageLabels || !activeBuyLevels.length) {
      setStagePills([]);
      return;
    }
    const next = [];
    for (const lv of activeBuyLevels) {
      const y = series.priceToCoordinate(lv.price);
      if (y == null || Number.isNaN(y)) continue;
      next.push({ stage: lv.stage, top: y });
    }
    setStagePills(next);
  }, [activeBuyLevels, showStageLabels]);

  /** B/S 마커를 체결가 높이·해당 봉 X에 배치 */
  const refreshTradeMarkerOverlays = useCallback(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series || !showTradePoints || !activeTradeMarkers.length || !bars.length) {
      setTradeMarkerOverlays([]);
      return;
    }

    const byKey = new Map();
    for (const m of activeTradeMarkers) {
      const time = resolveBarUnix(bars, m.date);
      if (time == null) continue;
      const price = Number(m.price) || 0;
      if (!(price > 0)) continue;
      const isSell = m.side === 'sell';
      const label = `${isSell ? 'S' : 'B'}${m.stage}`;
      const key = `${time}_${price}_${isSell ? 's' : 'b'}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.text.split(' ').includes(label)) {
          existing.text = `${existing.text} ${label}`;
        }
      } else {
        byKey.set(key, {
          time,
          price,
          text: label,
          isSell,
          color: isSell ? '#c62828' : '#1b5e20',
        });
      }
    }

    const next = [];
    for (const item of byKey.values()) {
      const x = chart.timeScale().timeToCoordinate(item.time);
      const y = series.priceToCoordinate(item.price);
      if (x == null || Number.isNaN(x) || y == null || Number.isNaN(y)) continue;
      next.push({
        key: `tm-${item.isSell ? 's' : 'b'}-${item.time}-${item.price}`,
        left: x,
        top: y,
        text: item.text,
        color: item.color,
        // 매도는 점 아래 라벨, 매수는 점 위 — 같은 봉에서 겹침 완화
        labelBelow: item.isSell,
      });
    }
    setTradeMarkerOverlays(next);
  }, [activeTradeMarkers, bars, showTradePoints]);

  const refreshChartOverlays = useCallback(() => {
    refreshStagePills();
    refreshTradeMarkerOverlays();
  }, [refreshStagePills, refreshTradeMarkerOverlays]);

  const loadBars = useCallback(async () => {
    if (!stockCode) return;
    setLoading(true);
    setError('');
    try {
      const market =
        String(stockMarket || '').toUpperCase() === 'US'
          ? 'US'
          : stockMarket === 'NXT'
            ? 'NXT'
            : 'KRX';
      const days =
        market === 'US'
          ? chartInterval === 'month'
            ? 120
            : chartInterval === 'week'
              ? 200
              : 240
          : chartInterval === 'month'
            ? 600
            : chartInterval === 'week'
              ? 500
              : 240;
      const params = { days, market, interval: chartInterval };
      if (market === 'US' && stexTp) params.stex_tp = stexTp;
      const { data } = await apiClient.get(
        `/market/daily-chart/${encodeURIComponent(stockCode)}`,
        { params }
      );
      const list = Array.isArray(data?.bars) ? data.bars : [];
      const cleaned = list
        .map((b) => {
          const close = Number(b.close) || 0;
          if (!b?.date || !(close > 0)) return null;
          const open = Number(b.open) > 0 ? Number(b.open) : close;
          const high = Number(b.high) > 0 ? Number(b.high) : Math.max(open, close);
          const low = Number(b.low) > 0 ? Number(b.low) : Math.min(open, close);
          return {
            date: b.date,
            open,
            high,
            low,
            close,
            volume: Number(b.volume) || 0,
          };
        })
        .filter(Boolean);
      setBars(cleaned);
      if (!cleaned.length) setError('차트 데이터가 없습니다.');
    } catch (err) {
      setBars([]);
      setError(err.response?.data?.error || err.message || '차트 조회 실패');
    } finally {
      setLoading(false);
    }
  }, [stockCode, stockMarket, chartInterval, stexTp]);

  useEffect(() => {
    if (open && stockCode) loadBars();
  }, [open, stockCode, loadBars]);

  // 종목 바뀌면 일봉으로 리셋
  useEffect(() => {
    if (open) setChartInterval('day');
  }, [stockCode, open]);
  useEffect(() => {
    if (!open || !containerRef.current || !bars.length) return undefined;

    const el = containerRef.current;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: 520,
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#424242',
      },
      grid: {
        vertLines: { color: '#f5f5f5' },
        horzLines: { color: '#f5f5f5' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        horzLine: {
          labelVisible: false, // 가격+% 커스텀 라벨 사용
        },
      },
      leftPriceScale: {
        visible: false,
      },
      rightPriceScale: {
        visible: true,
        borderColor: '#eeeeee',
      },
      timeScale: {
        borderColor: '#eeeeee',
        timeVisible: false,
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#e53935',
      downColor: '#1e88e5',
      borderUpColor: '#e53935',
      borderDownColor: '#1e88e5',
      wickUpColor: '#e53935',
      wickDownColor: '#1e88e5',
      priceScaleId: 'right',
      ...(isUs
        ? { priceFormat: { type: 'price', precision: 2, minMove: 0.01 } }
        : {}),
    });
    candleSeriesRef.current = candleSeries;

    const candleData = bars.map((b) => ({
      time: toUnix(b.date),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    }));
    candleSeries.setData(candleData);

    const lastClose = Number(bars[bars.length - 1]?.close) || 0;
    const formatCrosshairPrice = (price) => {
      const n = Number(price);
      if (!Number.isFinite(n)) return '';
      if (isUs) {
        return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return Math.round(n).toLocaleString('ko-KR');
    };

    const onCrosshairMove = (param) => {
      if (
        !param ||
        param.point === undefined ||
        param.point.x < 0 ||
        param.point.y < 0 ||
        !candleSeriesRef.current
      ) {
        setCrosshairLabel(null);
        return;
      }
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price == null || !Number.isFinite(price) || !(lastClose > 0)) {
        setCrosshairLabel(null);
        return;
      }
      const y = candleSeries.priceToCoordinate(price);
      if (y == null || Number.isNaN(y)) {
        setCrosshairLabel(null);
        return;
      }
      const pct = ((price - lastClose) / lastClose) * 100;
      const sign = pct > 0 ? '+' : '';
      setCrosshairLabel({
        top: y,
        priceText: formatCrosshairPrice(price),
        pctText: `${sign}${pct.toFixed(2)}%`,
        // 한국식: 상승 빨강, 하락 파랑
        pctBg: pct > 0 ? '#e53935' : pct < 0 ? '#1e88e5' : '#616161',
      });
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    const closes = bars.map((b) => Number(b.close));
    MA_DEFS.forEach(({ period, color }) => {
      const ma = calcMa(closes, period);
      const line = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        title: '',
        priceScaleId: 'right',
      });
      const data = [];
      for (let i = 0; i < bars.length; i += 1) {
        if (ma[i] == null) continue;
        data.push({ time: toUnix(bars[i].date), value: ma[i] });
      }
      line.setData(data);
    });

    if (showBuyLines) {
      activeBuyLevels.forEach((lv) => {
        const line = chart.addSeries(LineSeries, {
          color: '#e53935',
          lineWidth: 1,
          lineStyle: 0,
          priceLineVisible: false,
          lastValueVisible: false,
          title: '',
          priceScaleId: 'right',
        });
        if (candleData.length) {
          line.setData([
            { time: candleData[0].time, value: lv.price },
            { time: candleData[candleData.length - 1].time, value: lv.price },
          ]);
        }
      });
    }

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.75, bottom: 0 },
    });
    chart.priceScale('right').applyOptions({
      scaleMargins: { top: 0.14, bottom: 0.34 },
    });

    volumeSeries.setData(
      bars.map((b) => {
        const up = Number(b.close) >= Number(b.open);
        return {
          time: toUnix(b.date),
          value: Number(b.volume) || 0,
          color: up ? 'rgba(229, 57, 53, 0.45)' : 'rgba(30, 136, 229, 0.45)',
        };
      })
    );

    chart.timeScale().fitContent();

    const onResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
      refreshChartOverlays();
    };
    window.addEventListener('resize', onResize);
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshChartOverlays);
    requestAnimationFrame(() => refreshChartOverlays());

    return () => {
      window.removeEventListener('resize', onResize);
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshChartOverlays);
      } catch (_) {
        /* ignore */
      }
      try {
        chart.unsubscribeCrosshairMove(onCrosshairMove);
      } catch (_) {
        /* ignore */
      }
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      setStagePills([]);
      setTradeMarkerOverlays([]);
      setCrosshairLabel(null);
    };
  }, [open, bars, showBuyLines, showTradePoints, activeBuyLevels, refreshChartOverlays, isUs, activeTradeMarkers]);

  useEffect(() => {
    refreshChartOverlays();
  }, [showStageLabels, refreshChartOverlays]);

  const last = bars.length ? bars[bars.length - 1] : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: {
          bgcolor: '#fafafa',
          color: '#212121',
          backgroundImage: 'none',
          border: '1px solid #e0e0e0',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        },
      }}
    >
      <DialogTitle
        component="div"
        sx={{
          pr: 6,
          bgcolor: '#ffffff',
          borderBottom: '1px solid #eeeeee',
          color: '#212121',
        }}
      >
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
          <Box>
            <Typography variant="h6" component="div" sx={{ fontWeight: 700, fontSize: '1.05rem', color: '#212121' }}>
              {stockName || stockCode}{' '}
              <Typography component="span" variant="body2" sx={{ color: '#757575' }}>
                ({stockCode})
              </Typography>
            </Typography>
            {last && (
              <Typography variant="body2" sx={{ mt: 0.5, color: '#616161' }}>
                종가 {formatPriceLabel(last.close)} · 시 {formatPriceLabel(last.open)} ·
                고 {formatPriceLabel(last.high)} · 저 {formatPriceLabel(last.low)}
                {last.volume != null ? ` · 거래량 ${Number(last.volume).toLocaleString()}` : ''}
              </Typography>
            )}
          </Box>
          <Box display="flex" alignItems="center" gap={1} flexWrap="wrap" sx={{ color: '#424242' }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={chartInterval}
              onChange={(_e, next) => {
                if (next) setChartInterval(next);
              }}
              sx={{
                bgcolor: '#f5f5f5',
                '& .MuiToggleButton-root': {
                  px: 1.25,
                  py: 0.25,
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  color: '#616161',
                  borderColor: '#e0e0e0',
                  '&.Mui-selected': {
                    bgcolor: '#1976d2',
                    color: '#fff',
                    '&:hover': { bgcolor: '#1565c0' },
                  },
                },
              }}
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <ToggleButton key={opt.value} value={opt.value}>
                  {opt.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            {enableTradingOverlays && (
              <Box display="flex" alignItems="center" sx={{ gap: 0.25, ml: 0.5 }}>
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        checked={showBuyLines}
                        onChange={(e) => setShowBuyLines(e.target.checked)}
                        sx={{ p: 0.25, pr: 0 }}
                      />
                    }
                    label="매수라인"
                    sx={{
                      m: 0,
                      gap: 0,
                      '& .MuiFormControlLabel-label': {
                        fontSize: '0.875rem',
                        pl: 0,
                        ml: 0,
                      },
                    }}
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        checked={showStageLabels}
                        onChange={(e) => setShowStageLabels(e.target.checked)}
                        sx={{ p: 0.25, pr: 0 }}
                      />
                    }
                    label="차수"
                    sx={{
                      m: 0,
                      gap: 0,
                      '& .MuiFormControlLabel-label': {
                        fontSize: '0.875rem',
                        pl: 0,
                        ml: 0,
                      },
                    }}
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        checked={showTradePoints}
                        onChange={(e) => setShowTradePoints(e.target.checked)}
                        sx={{ p: 0.25, pr: 0 }}
                      />
                    }
                    label="마커"
                    sx={{
                      m: 0,
                      gap: 0,
                      '& .MuiFormControlLabel-label': {
                        fontSize: '0.875rem',
                        pl: 0,
                        ml: 0,
                      },
                    }}
                  />
              </Box>
            )}
          </Box>
        </Box>
        <IconButton
          aria-label="close"
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8, color: '#616161' }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent
        dividers
        sx={{
          bgcolor: '#ffffff',
          borderColor: '#eeeeee',
          color: '#212121',
        }}
      >
        <Box display="flex" gap={1.5} mb={1} flexWrap="wrap" alignItems="center">
          {MA_DEFS.map((m) => (
            <Chip
              key={m.key}
              size="small"
              label={`${m.period}일`}
              sx={{
                height: 22,
                bgcolor: m.color,
                color: '#fff',
                fontWeight: 600,
                '& .MuiChip-label': { px: 1 },
              }}
            />
          ))}
          {showBuyLines &&
            activeBuyLevels.map((lv) => (
              <Chip
                key={`buy-${lv.stage}`}
                size="small"
                label={`${lv.stage}차 ${formatPriceLabel(lv.price)}`}
                sx={{ bgcolor: '#ef9a9a', color: '#b71c1c' }}
              />
            ))}
        </Box>
        {loading && (
          <Box display="flex" justifyContent="center" alignItems="center" minHeight={320}>
            <CircularProgress />
          </Box>
        )}
        {error && !loading && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Box
          ref={wrapRef}
          sx={{
            position: 'relative',
            width: '100%',
            height: 520,
            display: loading ? 'none' : 'block',
            bgcolor: '#ffffff',
            border: '1px solid #e8e8e8',
            borderRadius: 1,
            overflow: 'hidden',
          }}
        >
          <Box ref={containerRef} sx={{ width: '100%', height: '100%' }} />
          {crosshairLabel && (
            <Box
              sx={{
                position: 'absolute',
                right: 0,
                top: crosshairLabel.top,
                transform: 'translateY(-50%)',
                zIndex: 3,
                display: 'flex',
                alignItems: 'stretch',
                pointerEvents: 'none',
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1.35,
                boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                borderRadius: '2px 0 0 2px',
                overflow: 'hidden',
              }}
            >
              <Box
                sx={{
                  bgcolor: '#131722',
                  color: '#fff',
                  px: 0.75,
                  py: 0.2,
                  whiteSpace: 'nowrap',
                }}
              >
                {crosshairLabel.priceText}
              </Box>
              <Box
                sx={{
                  bgcolor: crosshairLabel.pctBg,
                  color: '#fff',
                  px: 0.6,
                  py: 0.2,
                  whiteSpace: 'nowrap',
                }}
              >
                {crosshairLabel.pctText}
              </Box>
            </Box>
          )}
          {showStageLabels &&
            stagePills.map((p) => (
              <Box
                key={`pill-${p.stage}`}
                sx={{
                  position: 'absolute',
                  left: 6,
                  top: p.top,
                  transform: 'translateY(-50%)',
                  zIndex: 2,
                  px: 0.9,
                  py: 0.15,
                  borderRadius: 999,
                  bgcolor: '#ffeb3b',
                  color: '#212121',
                  fontSize: 11,
                  fontWeight: 700,
                  lineHeight: 1.4,
                  border: '1px solid #fbc02d',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {p.stage}차
              </Box>
            ))}
          {showTradePoints &&
            tradeMarkerOverlays.map((m) => (
              <Box
                key={m.key}
                sx={{
                  position: 'absolute',
                  left: m.left,
                  top: m.top,
                  transform: m.labelBelow ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
                  zIndex: 2,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 0.1,
                  pointerEvents: 'none',
                }}
              >
                {m.labelBelow ? (
                  <>
                    <Box
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        bgcolor: m.color,
                        border: '1px solid #fff',
                        boxShadow: `0 0 0 1px ${m.color}`,
                      }}
                    />
                    <Typography
                      component="span"
                      sx={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: m.color,
                        lineHeight: 1.15,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {m.text}
                    </Typography>
                  </>
                ) : (
                  <>
                    <Typography
                      component="span"
                      sx={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: m.color,
                        lineHeight: 1.15,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {m.text}
                    </Typography>
                    <Box
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        bgcolor: m.color,
                        border: '1px solid #fff',
                        boxShadow: `0 0 0 1px ${m.color}`,
                      }}
                    />
                  </>
                )}
              </Box>
            ))}
        </Box>
      </DialogContent>
    </Dialog>
  );
};

export default StockDailyChartDialog;

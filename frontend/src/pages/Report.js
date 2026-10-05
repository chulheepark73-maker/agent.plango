import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  Grid,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from '@mui/material';
import AssessmentIcon from '@mui/icons-material/Assessment';
import BarChartIcon from '@mui/icons-material/BarChart';
import DonutLargeIcon from '@mui/icons-material/DonutLarge';
import LeaderboardIcon from '@mui/icons-material/Leaderboard';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import apiClient from '../utils/axios';
import PageFrame from '../components/PageFrame';
import { formatNumber } from '../utils/formatUtils';
import { calculateProfit, DEFAULT_FEE_RATES } from '../utils/profitUtils';

const paperSx = {
  bgcolor: 'background.paper',
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 2,
  boxShadow: 'none',
  p: 2.5,
  height: '100%',
};

const headerSelectSx = {
  height: 28,
  fontSize: '0.8rem',
  '& .MuiSelect-select': { py: 0, display: 'flex', alignItems: 'center' },
};

const headCellSx = {
  fontWeight: 600,
  fontSize: '0.72rem',
  color: 'text.secondary',
  borderColor: 'divider',
  py: 0.75,
  whiteSpace: 'nowrap',
};

const bodyCellSx = {
  color: 'text.primary',
  borderColor: 'divider',
  fontSize: '0.8125rem',
  py: 0.6,
};

const STRATEGY_LABEL = {
  SPLIT_TRADE: '분할',
  INFINITE_TRADE: '무한',
  LIQUIDATE: '청산',
};

const pickRate = (v, fallback) =>
  v != null && Number.isFinite(Number(v)) ? Number(v) : fallback;

const toFeeRates = (s) => ({
  buyFeeRate: Number(s?.buyFeeRate) || DEFAULT_FEE_RATES.buyFeeRate,
  sellFeeRate: Number(s?.sellFeeRate) || DEFAULT_FEE_RATES.sellFeeRate,
  sellTaxRate: Number(s?.sellTaxRate) || DEFAULT_FEE_RATES.sellTaxRate,
  usBuyFeeRate: pickRate(s?.usBuyFeeRate, DEFAULT_FEE_RATES.usBuyFeeRate),
  usSellFeeRate: pickRate(s?.usSellFeeRate, DEFAULT_FEE_RATES.usSellFeeRate),
  usSellTaxRate: pickRate(s?.usSellTaxRate, DEFAULT_FEE_RATES.usSellTaxRate),
});

const isUsRow = (r) => String(r.stockMarket || '').toUpperCase() === 'US';

const SectionTitle = ({ icon: Icon, children, right }) => (
  <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
    <Typography
      variant="h6"
      sx={{ fontWeight: 700, fontSize: '1rem', display: 'inline-flex', alignItems: 'center', gap: 0.6 }}
    >
      <Icon sx={{ fontSize: '1rem', color: 'text.secondary' }} />
      {children}
    </Typography>
    {right}
  </Box>
);

const Report = () => {
  const theme = useTheme();
  const now = new Date();
  const [rows, setRows] = useState([]);
  const [feeRates, setFeeRates] = useState(DEFAULT_FEE_RATES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [market, setMarket] = useState('KR');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState('all');

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [historyRes, settingsRes] = await Promise.all([
        apiClient.get('/holdings/trade-history'),
        apiClient.get('/settings').catch(() => null),
      ]);
      setRows(historyRes.data || []);
      if (settingsRes?.data) setFeeRates(toFeeRates(settingsRes.data));
    } catch (err) {
      setError(err.response?.data?.error || '거래 이력을 불러오지 못했습니다.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const isUs = market === 'US';
  const money = useCallback(
    (v) => (isUs ? `$${formatNumber(Math.round(v * 100) / 100)}` : `${formatNumber(Math.round(v))}원`),
    [isUs]
  );
  const profitColor = (v) => (v > 0 ? 'error.main' : v < 0 ? 'primary.main' : 'text.primary');

  /** 손익 계산된 거래 (시장 필터) */
  const trades = useMemo(
    () =>
      rows
        .filter((r) => (isUs ? isUsRow(r) : !isUsRow(r)))
        .map((r) => {
          const buyPrice = Number(r.buy_price) || 0;
          const sellPrice = Number(r.sell_price) || 0;
          const qty = Number(r.sell_qty) || 0;
          const p = calculateProfit({ buyPrice, sellPrice, qty, stockMarket: r.stockMarket, feeRates });
          const date = String(r.createdAt || '');
          const kind =
            r.orderReason === 'LIQUIDATE' ? 'LIQUIDATE' : String(r.strategyType || '').toUpperCase();
          return {
            ...r,
            date,
            y: Number(date.slice(0, 4)),
            m: Number(date.slice(5, 7)),
            buyPrice,
            sellPrice,
            qty,
            kind,
            profit: p.profitAmount,
            profitRate: p.profitRate,
            fees: p.fees,
            buyAmount: buyPrice * qty,
          };
        }),
    [rows, isUs, feeRates]
  );

  const years = useMemo(() => {
    const set = new Set(trades.map((t) => t.y).filter(Boolean));
    set.add(now.getFullYear());
    return [...set].sort((a, b) => b - a);
  }, [trades]); // eslint-disable-line react-hooks/exhaustive-deps

  const yearTrades = useMemo(() => trades.filter((t) => t.y === year), [trades, year]);
  const periodTrades = useMemo(
    () => (month === 'all' ? yearTrades : yearTrades.filter((t) => t.m === Number(month))),
    [yearTrades, month]
  );

  const summary = useMemo(() => {
    const count = periodTrades.length;
    const wins = periodTrades.filter((t) => t.profit > 0).length;
    const profit = periodTrades.reduce((s, t) => s + t.profit, 0);
    const fees = periodTrades.reduce((s, t) => s + t.fees, 0);
    const invested = periodTrades.reduce((s, t) => s + t.buyAmount, 0);
    return {
      count,
      wins,
      losses: count - wins,
      winRate: count > 0 ? (wins / count) * 100 : 0,
      profit,
      fees,
      returnRate: invested > 0 ? (profit / invested) * 100 : 0,
    };
  }, [periodTrades]);

  const monthly = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const list = yearTrades.filter((t) => t.m === i + 1);
        return {
          name: `${i + 1}월`,
          month: i + 1,
          profit: Math.round(list.reduce((s, t) => s + t.profit, 0) * (isUs ? 100 : 1)) / (isUs ? 100 : 1),
          count: list.length,
        };
      }),
    [yearTrades, isUs]
  );

  const byStrategy = useMemo(() => {
    const map = new Map();
    periodTrades.forEach((t) => {
      const key = STRATEGY_LABEL[t.kind] || '기타';
      const prev = map.get(key) || { name: key, count: 0, profit: 0 };
      prev.count += 1;
      prev.profit += t.profit;
      map.set(key, prev);
    });
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [periodTrades]);

  const byStock = useMemo(() => {
    const map = new Map();
    periodTrades.forEach((t) => {
      const key = t.stockCode;
      const prev = map.get(key) || {
        stockCode: t.stockCode,
        stockName: t.stockName || t.stockCode,
        count: 0,
        wins: 0,
        profit: 0,
        invested: 0,
      };
      prev.count += 1;
      if (t.profit > 0) prev.wins += 1;
      prev.profit += t.profit;
      prev.invested += t.buyAmount;
      map.set(key, prev);
    });
    return [...map.values()].sort((a, b) => b.profit - a.profit);
  }, [periodTrades]);

  const recent = useMemo(
    () => [...periodTrades].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 15),
    [periodTrades]
  );

  const pieColors = [
    theme.palette.primary.main,
    theme.palette.warning.main,
    theme.palette.success.main,
    theme.palette.secondary.main,
  ];
  const axisColor = theme.palette.text.secondary;
  const periodLabel = month === 'all' ? `${year}년` : `${year}년 ${String(month).padStart(2, '0')}월`;

  const kpis = [
    { label: '실현손익', value: money(summary.profit), color: profitColor(summary.profit) },
    { label: '수익률', value: `${summary.returnRate.toFixed(2)}%`, color: profitColor(summary.returnRate) },
    { label: '거래 건수', value: `${formatNumber(summary.count)}건` },
    {
      label: '승률',
      value: `${summary.winRate.toFixed(1)}%`,
      sub: `${summary.wins}승 ${summary.losses}패`,
    },
    { label: '수수료·세금', value: money(summary.fees) },
  ];

  return (
    <PageFrame>
      <Paper elevation={0} sx={{ ...paperSx, height: 'auto', mb: 2, px: 2, py: 1.25 }}>
        <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
          <Typography
            variant="h6"
            sx={{ fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: 1 }}
          >
            <AssessmentIcon sx={{ fontSize: '1.05rem', color: 'text.secondary' }} />
            리포트
            <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 0.5 }}>
              {periodLabel} · {isUs ? '미국' : '국내'}
            </Typography>
          </Typography>
          <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
            <ToggleButtonGroup
              size="small"
              exclusive
              value={market}
              onChange={(_, v) => v && setMarket(v)}
            >
              <ToggleButton value="KR" sx={{ px: 1.25, py: 0, height: 28, fontSize: '0.75rem' }}>국내</ToggleButton>
              <ToggleButton value="US" sx={{ px: 1.25, py: 0, height: 28, fontSize: '0.75rem' }}>미국</ToggleButton>
            </ToggleButtonGroup>
            <Select size="small" value={year} onChange={(e) => setYear(Number(e.target.value))} sx={{ minWidth: 96, ...headerSelectSx }}>
              {years.map((y) => (
                <MenuItem key={y} value={y}>
                  {y}년
                </MenuItem>
              ))}
            </Select>
            <Select size="small" value={month} onChange={(e) => setMonth(e.target.value)} sx={{ minWidth: 88, ...headerSelectSx }}>
              <MenuItem value="all">전체</MenuItem>
              {Array.from({ length: 12 }, (_, i) => (
                <MenuItem key={i + 1} value={i + 1}>
                  {i + 1}월
                </MenuItem>
              ))}
            </Select>
          </Box>
        </Box>
      </Paper>

      {error && (
        <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box display="flex" justifyContent="center" py={8}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          {/* KPI */}
          <Grid container spacing={1.5} sx={{ mb: 2 }}>
            {kpis.map((k) => (
              <Grid item xs={6} sm={4} md key={k.label}>
                <Paper elevation={0} sx={{ ...paperSx, p: 2 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.78rem' }}>
                    {k.label}
                  </Typography>
                  <Typography
                    sx={{
                      fontWeight: 700,
                      fontSize: '1.35rem',
                      mt: 0.5,
                      color: k.color || 'text.primary',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {k.value}
                  </Typography>
                  {k.sub && (
                    <Typography variant="caption" color="text.secondary">
                      {k.sub}
                    </Typography>
                  )}
                </Paper>
              </Grid>
            ))}
          </Grid>

          {/* 월별 손익 / 전략 비중 */}
          <Grid container spacing={1.5} sx={{ mb: 2 }}>
            <Grid item xs={12} md={8}>
              <Paper elevation={0} sx={paperSx}>
                <SectionTitle icon={BarChartIcon}>{year}년 월별 실현손익</SectionTitle>
                <Box sx={{ height: 260 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthly} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} vertical={false} />
                      <XAxis dataKey="name" tick={{ fill: axisColor, fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis
                        tick={{ fill: axisColor, fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                        width={isUs ? 56 : 72}
                        tickFormatter={(v) => (isUs ? `$${formatNumber(v)}` : formatNumber(v))}
                      />
                      <Tooltip
                        cursor={{ fill: theme.palette.action.hover }}
                        contentStyle={{
                          background: theme.palette.background.paper,
                          border: `1px solid ${theme.palette.divider}`,
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                        formatter={(v, _n, p) => [`${money(v)} (${p.payload.count}건)`, '실현손익']}
                      />
                      <Bar
                        dataKey="profit"
                        radius={[4, 4, 0, 0]}
                        onClick={(d) => d?.month && setMonth(d.month)}
                        style={{ cursor: 'pointer' }}
                      >
                        {monthly.map((d) => (
                          <Cell
                            key={d.month}
                            fill={d.profit >= 0 ? theme.palette.error.main : theme.palette.primary.main}
                            fillOpacity={month === 'all' || Number(month) === d.month ? 1 : 0.35}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </Box>
              </Paper>
            </Grid>
            <Grid item xs={12} md={4}>
              <Paper elevation={0} sx={paperSx}>
                <SectionTitle icon={DonutLargeIcon}>전략별 거래</SectionTitle>
                {byStrategy.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 8 }}>
                    거래 이력이 없습니다.
                  </Typography>
                ) : (
                  <>
                    <Box sx={{ height: 170 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={byStrategy} dataKey="count" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2}>
                            {byStrategy.map((s, i) => (
                              <Cell key={s.name} fill={pieColors[i % pieColors.length]} stroke="none" />
                            ))}
                          </Pie>
                          <Tooltip formatter={(v, n) => [`${v}건`, n]} />
                        </PieChart>
                      </ResponsiveContainer>
                    </Box>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1 }}>
                      {byStrategy.map((s, i) => (
                        <Box key={s.name} display="flex" alignItems="center" justifyContent="space-between">
                          <Box display="flex" alignItems="center" gap={0.75}>
                            <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: pieColors[i % pieColors.length] }} />
                            <Typography variant="body2">
                              {s.name} · {s.count}건
                            </Typography>
                          </Box>
                          <Typography variant="body2" sx={{ color: profitColor(s.profit), fontVariantNumeric: 'tabular-nums' }}>
                            {money(s.profit)}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  </>
                )}
              </Paper>
            </Grid>
          </Grid>

          {/* 종목별 성과 / 최근 거래 */}
          <Grid container spacing={1.5}>
            <Grid item xs={12} md={6}>
              <Paper elevation={0} sx={paperSx}>
                <SectionTitle icon={LeaderboardIcon}>종목별 성과</SectionTitle>
                <TableContainer sx={{ maxHeight: 420 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={headCellSx}>종목명</TableCell>
                        <TableCell align="right" sx={headCellSx}>건수</TableCell>
                        <TableCell align="right" sx={headCellSx}>승률</TableCell>
                        <TableCell align="right" sx={headCellSx}>수익률</TableCell>
                        <TableCell align="right" sx={headCellSx}>실현손익</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {byStock.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} align="center" sx={{ ...bodyCellSx, color: 'text.secondary', py: 3 }}>
                            거래 이력이 없습니다.
                          </TableCell>
                        </TableRow>
                      ) : (
                        byStock.map((s) => {
                          const rate = s.invested > 0 ? (s.profit / s.invested) * 100 : 0;
                          return (
                            <TableRow key={s.stockCode} hover>
                              <TableCell sx={bodyCellSx}>
                                {s.stockName}
                                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                                  {s.stockCode}
                                </Typography>
                              </TableCell>
                              <TableCell align="right" sx={bodyCellSx}>{s.count}</TableCell>
                              <TableCell align="right" sx={bodyCellSx}>
                                {((s.wins / s.count) * 100).toFixed(0)}%
                              </TableCell>
                              <TableCell align="right" sx={{ ...bodyCellSx, color: profitColor(rate) }}>
                                {rate.toFixed(2)}%
                              </TableCell>
                              <TableCell
                                align="right"
                                sx={{ ...bodyCellSx, color: profitColor(s.profit), fontVariantNumeric: 'tabular-nums' }}
                              >
                                {money(s.profit)}
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
            <Grid item xs={12} md={6}>
              <Paper elevation={0} sx={paperSx}>
                <SectionTitle icon={ReceiptLongIcon}>최근 거래</SectionTitle>
                <TableContainer sx={{ maxHeight: 420 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={headCellSx}>매도일</TableCell>
                        <TableCell sx={headCellSx}>종목명</TableCell>
                        <TableCell align="center" sx={headCellSx}>유형</TableCell>
                        <TableCell align="right" sx={headCellSx}>수량</TableCell>
                        <TableCell align="right" sx={headCellSx}>수익률</TableCell>
                        <TableCell align="right" sx={headCellSx}>실현손익</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {recent.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} align="center" sx={{ ...bodyCellSx, color: 'text.secondary', py: 3 }}>
                            거래 이력이 없습니다.
                          </TableCell>
                        </TableRow>
                      ) : (
                        recent.map((t) => (
                          <TableRow key={`${t.orderId || t.stockCode}-${t.date}`} hover>
                            <TableCell sx={{ ...bodyCellSx, whiteSpace: 'nowrap' }}>{t.date.slice(5, 16)}</TableCell>
                            <TableCell sx={bodyCellSx}>{t.stockName || t.stockCode}</TableCell>
                            <TableCell align="center" sx={bodyCellSx}>
                              {STRATEGY_LABEL[t.kind] || '-'}
                              {t.kind !== 'INFINITE_TRADE' && t.kind !== 'LIQUIDATE' && t.sell_cur
                                ? ` ${t.sell_cur}차`
                                : ''}
                            </TableCell>
                            <TableCell align="right" sx={bodyCellSx}>{formatNumber(t.qty)}</TableCell>
                            <TableCell align="right" sx={{ ...bodyCellSx, color: profitColor(t.profitRate) }}>
                              {t.profitRate.toFixed(2)}%
                            </TableCell>
                            <TableCell
                              align="right"
                              sx={{ ...bodyCellSx, color: profitColor(t.profit), fontVariantNumeric: 'tabular-nums' }}
                            >
                              {money(t.profit)}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Paper>
            </Grid>
          </Grid>
        </>
      )}
    </PageFrame>
  );
};

export default Report;

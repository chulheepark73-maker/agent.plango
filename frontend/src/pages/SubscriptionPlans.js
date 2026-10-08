import React, { useCallback, useEffect, useState } from 'react';
import {
  Paper,
  Box,
  Typography,
  Alert,
  CircularProgress,
  Chip,
  Button,
  Radio,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import { Link as RouterLink } from 'react-router-dom';
import apiClient from '../utils/axios';
import PageFrame from '../components/PageFrame';

const CURRENT_COLOR = '#f5a623';

/** 아직 신청할 수 없는 플랜 (서버에서도 막는다) */
const DISABLED_PLAN_CODES = new Set([]);

const formatPrice = (value) => `${Number(value || 0).toLocaleString('ko-KR')}원`;

const formatDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) : '-';

/** 플랜 결제주기 기준 만료일 (서버 startSubscription 과 동일: 월 +1개월, 연 +1년) */
const planPeriod = (plan, date) => {
  const d = new Date(date);
  if (plan.billingCycle === 'year') {
    d.setFullYear(d.getFullYear() + 1);
    return { end: d, label: '1년' };
  }
  d.setMonth(d.getMonth() + 1);
  return { end: d, label: '1개월' };
};

const planTitle = (plan) =>
  plan.billingCycle && plan.billingCycle !== 'none' && plan.billingCycleLabel
    ? `${plan.name} · ${plan.billingCycleLabel}`
    : plan.name;

const SectionTitle = ({ children }) => (
  <Typography sx={{ fontWeight: 'bold', fontSize: '0.95rem', mb: 1.25 }}>{children}</Typography>
);

/** 만료일까지 남은 일수 (KST 날짜 기준, 지났으면 0) */
const daysLeft = (iso) => {
  if (!iso) return null;
  const diff = Date.parse(formatDate(iso)) - Date.parse(formatDate(new Date().toISOString()));
  return Number.isNaN(diff) ? null : Math.max(0, Math.round(diff / 86400000));
};

const formatDot = (iso) => (iso ? formatDate(iso).replace(/-/g, '.') : '-');

const PAYMENT_STATUS = {
  pending: { label: '입금대기', color: CURRENT_COLOR },
  active: { label: '이용중', color: 'success.main' },
  expired: { label: '만료', color: 'text.secondary' },
  cancelled: { label: '취소', color: 'text.secondary' },
  rejected: { label: '거절', color: 'text.secondary' },
};

const usagePeriod = (s) => {
  if (s.status === 'pending') return '승인 후 확정';
  if (s.status === 'rejected') return '-';
  return `${formatDot(s.startedAt)} ~ ${formatDot(s.cancelledAt || s.expiresAt)}`;
};

const payHeadSx = { fontWeight: 600, fontSize: '0.8rem', color: 'text.secondary', whiteSpace: 'nowrap' };
const payCellSx = { fontSize: '0.8125rem', whiteSpace: 'nowrap' };

/** 결제 관리 — 중앙 subscriptions 이력 */
const PaymentHistory = ({ rows, loading, error }) => (
  <>
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mb: 1.25 }}>
      <Typography sx={{ fontWeight: 'bold', fontSize: '0.95rem' }}>결제 관리</Typography>
      <Typography sx={{ fontSize: '0.95rem', color: CURRENT_COLOR }}>({rows.length}건)</Typography>
    </Box>
    <Paper variant="outlined" sx={{ mb: 2 }}>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={payHeadSx}>신청일</TableCell>
              <TableCell sx={payHeadSx}>상품명</TableCell>
              <TableCell sx={payHeadSx}>이용기간</TableCell>
              <TableCell align="right" sx={payHeadSx}>결제금액</TableCell>
              <TableCell align="center" sx={payHeadSx}>상태</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={22} />
                </TableCell>
              </TableRow>
            ) : error || rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ ...payCellSx, color: 'text.secondary', py: 4 }}>
                  {error || '결제 내역이 없습니다.'}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((s) => {
                const st = PAYMENT_STATUS[s.status] || { label: s.status, color: 'text.secondary' };
                return (
                  <TableRow key={s.id} hover>
                    <TableCell sx={payCellSx}>{formatDate(s.createdAt || s.startedAt)}</TableCell>
                    <TableCell sx={payCellSx}>
                      {s.planName}
                      {s.billingCycleLabel && s.billingCycleLabel !== '-' ? ` · ${s.billingCycleLabel}` : ''}
                    </TableCell>
                    <TableCell sx={{ ...payCellSx, color: 'text.secondary' }}>
                      {usagePeriod(s)}
                    </TableCell>
                    <TableCell align="right" sx={payCellSx}>
                      {s.amount != null ? formatPrice(s.amount) : '-'}
                    </TableCell>
                    <TableCell align="center" sx={{ ...payCellSx, color: st.color }}>
                      [{st.label}]
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
        <InfoOutlinedIcon sx={{ fontSize: '1rem', color: 'text.secondary' }} />
        <Typography sx={{ fontWeight: 'bold', fontSize: '0.875rem' }}>도움말</Typography>
      </Box>
      <Box component="ul" sx={{ m: 0, pl: 2.5, color: 'text.secondary', fontSize: '0.8125rem', lineHeight: 1.8 }}>
        <li>유료 플랜을 신청하면 입금대기 상태가 되며, 입금 확인 후 관리자가 승인하면 적용됩니다.</li>
        <li>이용기간은 관리자 승인일부터 계산됩니다. (월간 1개월 / 년간 1년)</li>
        <li>입금대기 중에 다른 플랜을 신청하면 이전 신청은 거절 처리됩니다.</li>
        <li>유료 구독 이용기간 중에는 새 플랜을 신청할 수 없습니다. 현재 구독이 만료된 후 신청하세요.</li>
      </Box>
    </Paper>
  </>
);

const SubscriptionPlans = () => {
  const [plans, setPlans] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [selectedCode, setSelectedCode] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const { data } = await apiClient.get('/subscription/history');
      setHistory(Array.isArray(data?.subscriptions) ? data.subscriptions : []);
      setHistoryError(null);
    } catch (e) {
      setHistoryError(e.response?.data?.error || '결제 내역을 불러오지 못했습니다.');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const loadMe = useCallback(async () => {
    const { data } = await apiClient.get('/subscription/current');
    setMe(data);
    const code = data?.subscriptionPlanCode;
    setSelectedCode(code && code !== 'free' ? code : null);
    return data;
  }, []);

  useEffect(() => {
    Promise.allSettled([apiClient.get('/subscription/plans'), loadMe()])
      .then(([plansRes, meRes]) => {
        if (plansRes.status === 'fulfilled') {
          setPlans(plansRes.value.data?.plans || []);
        } else {
          setError(plansRes.reason?.response?.data?.error || '구독 플랜을 불러오지 못했습니다.');
        }
        if (meRes.status === 'rejected') {
          setError(meRes.reason?.response?.data?.error || '구독 정보를 불러오지 못했습니다.');
        }
      })
      .finally(() => setLoading(false));
  }, [loadMe]);

  const currentCode = me?.subscriptionPlanCode || 'free';
  const subscribed = me?.subscription === 'Y' && currentCode !== 'free';
  const selectedPlan = plans.find((p) => p.code === selectedCode) || null;
  const pendingCode = history.find((s) => s.status === 'pending')?.planCode || null;
  const canSave =
    !!selectedPlan &&
    selectedCode !== 'free' &&
    selectedCode !== currentCode &&
    selectedCode !== pendingCode &&
    !DISABLED_PLAN_CODES.has(selectedCode) &&
    !saving;

  const handleSave = async () => {
    if (!canSave) return;
    if (subscribed) {
      window.alert(
        `현재 ${me.subscriptionPlanName}${me.subscriptionCycle ? `(${me.subscriptionCycle})` : ''} 구독 이용기간 중입니다. (만료일: ${formatDate(me.subscriptionExpiresAt)})\n현재 구독이 만료된 후 신청할 수 있습니다.`
      );
      return;
    }
    const period = planPeriod(selectedPlan, new Date());
    const confirmText = [
      `${planTitle(selectedPlan)} 플랜을 신청합니다. (${formatPrice(selectedPlan.price)})`,
      `입금 확인 후 관리자가 승인하면 승인일부터 ${period.label}간 적용됩니다.`,
      pendingCode ? '기존 입금대기 신청은 거절 처리됩니다.' : null,
      '신청하시겠습니까?',
    ]
      .filter(Boolean)
      .join('\n');
    if (!window.confirm(confirmText)) return;

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const { data } = await apiClient.post('/subscription', { planCode: selectedPlan.code });
      await Promise.all([loadMe(), loadHistory()]);
      setMessage(data?.message || '구독 신청이 접수되었습니다.');
    } catch (e) {
      setError(e.response?.data?.error || '구독 신청에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageFrame>
      <Paper sx={{ px: 2, py: 1.25, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LocalOfferIcon sx={{ fontSize: '1.05rem' }} />
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            서버구독 플랜
          </Typography>
        </Box>
      </Paper>

      <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start', flexWrap: { xs: 'wrap', lg: 'nowrap' } }}>
      <Box sx={{ flex: 1, minWidth: 0, width: { xs: '100%', lg: 'auto' } }}>
        <PaymentHistory rows={history} loading={historyLoading} error={historyError} />
      </Box>
      <Box
        sx={{
          width: { xs: '100%', lg: 'calc(100% / 3)' },
          minWidth: { md: 480 },
          flexShrink: 0,
        }}
      >
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {message && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setMessage(null)}>
            {message}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <>
            {me && me.registered === false && (
              <Alert
                severity="warning"
                sx={{ mb: 2 }}
                action={
                  <Button color="inherit" size="small" component={RouterLink} to="/server-registration">
                    서버등록
                  </Button>
                }
              >
                이 서버가 PlanGo.Today 에 등록되지 않아 구독 혜택이 적용되지 않습니다(무료 한도 적용).
                서버등록 메뉴에서 등록하세요.
              </Alert>
            )}
            <SectionTitle>현재 이용중인 서버구독</SectionTitle>
            <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Chip
                  size="small"
                  label={subscribed ? '구독중' : '무료'}
                  color={subscribed ? 'success' : 'default'}
                />
                <Typography sx={{ fontWeight: 'bold' }}>
                  {me?.subscriptionPlanName || '무료'}
                  {subscribed && me?.subscriptionCycle ? ` (${me.subscriptionCycle})` : ''}
                </Typography>
                {subscribed && daysLeft(me.subscriptionExpiresAt) != null && (
                  <Box sx={{ ml: 'auto', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.2 }}>
                      남은 일수
                    </Typography>
                    <Typography sx={{ fontWeight: 'bold', color: CURRENT_COLOR, fontSize: '2rem', lineHeight: 1.1 }}>
                      {daysLeft(me.subscriptionExpiresAt)}
                    </Typography>
                  </Box>
                )}
              </Box>
              <Typography variant="body2" color="text.secondary">
                {subscribed
                  ? `시작일: ${formatDate(me.subscriptionStartedAt)} · 만료일: ${formatDate(me.subscriptionExpiresAt)}`
                  : '유료 구독이 없습니다.'}
              </Typography>
            </Paper>

            <SectionTitle>서버구독 플랜 선택</SectionTitle>
            {plans.map((plan) => {
              const isCurrent = plan.code === currentCode;
              const isFree = plan.code === 'free';
              const isDisabled = DISABLED_PLAN_CODES.has(plan.code);
              const isSelected = plan.code === selectedCode;
              const selectable = !isFree && !isDisabled && !saving;
              return (
                <Paper
                  key={plan.id}
                  variant="outlined"
                  onClick={selectable ? () => setSelectedCode(plan.code) : undefined}
                  sx={{
                    p: 2,
                    pl: 1,
                    mb: 1.25,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    cursor: selectable ? 'pointer' : 'default',
                    opacity: isDisabled ? 0.5 : 1,
                    borderColor: isSelected && !isDisabled ? 'primary.main' : 'divider',
                    borderWidth: isSelected && !isDisabled ? 2 : 1,
                    bgcolor: isCurrent ? 'action.hover' : 'background.paper',
                  }}
                >
                  <Radio
                    size="small"
                    checked={isSelected && selectable}
                    disabled={!selectable}
                    onChange={() => setSelectedCode(plan.code)}
                  />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 'bold', color: isCurrent ? CURRENT_COLOR : 'text.primary' }}>
                      {planTitle(plan)}
                      {isCurrent ? ' (현재)' : ''}
                    </Typography>
                    {plan.description && (
                      <Typography variant="body2" sx={{ color: isCurrent ? CURRENT_COLOR : 'text.secondary' }}>
                        {plan.description}
                      </Typography>
                    )}
                    {!isFree && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                        {formatPrice(plan.price)}
                      </Typography>
                    )}
                  </Box>
                  {isCurrent ? (
                    <Chip
                      size="small"
                      variant="outlined"
                      label="이용중"
                      sx={{ color: CURRENT_COLOR, borderColor: CURRENT_COLOR, flexShrink: 0 }}
                    />
                  ) : plan.code === pendingCode ? (
                    <Chip size="small" color="info" variant="outlined" label="입금대기" sx={{ flexShrink: 0 }} />
                  ) : (
                    isDisabled && <Chip size="small" label="준비중" sx={{ flexShrink: 0 }} />
                  )}
                </Paper>
              );
            })}

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2, mb: 1 }}>
              <Button variant="contained" onClick={handleSave} disabled={!canSave} sx={{ minWidth: 128 }}>
                {saving ? <CircularProgress size={20} color="inherit" /> : '신청'}
              </Button>
            </Box>
          </>
        )}
      </Box>
      </Box>
    </PageFrame>
  );
};

export default SubscriptionPlans;

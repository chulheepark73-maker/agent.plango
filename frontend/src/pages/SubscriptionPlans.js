import React, { useCallback, useEffect, useState } from 'react';
import { Paper, Box, Typography, Alert, CircularProgress, Chip, Button, Radio } from '@mui/material';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import { Link as RouterLink } from 'react-router-dom';
import apiClient from '../utils/axios';
import PageFrame from '../components/PageFrame';

const CURRENT_COLOR = '#f5a623';

/** 아직 신청할 수 없는 플랜 (서버에서도 막는다) */
const DISABLED_PLAN_CODES = new Set(['premium_year']);

const formatPrice = (value) => `${Number(value || 0).toLocaleString('ko-KR')}원`;

const formatDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) : '-';

const oneMonthLater = (date) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  return d;
};

const planTitle = (plan) =>
  plan.billingCycle && plan.billingCycle !== 'none' && plan.billingCycleLabel
    ? `${plan.name} · ${plan.billingCycleLabel}`
    : plan.name;

const SectionTitle = ({ children }) => (
  <Typography sx={{ fontWeight: 'bold', fontSize: '0.95rem', mb: 1.25 }}>{children}</Typography>
);

const SubscriptionPlans = () => {
  const [plans, setPlans] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [selectedCode, setSelectedCode] = useState(null);

  const loadMe = useCallback(async () => {
    const { data } = await apiClient.get('/subscription/current');
    setMe(data);
    setSelectedCode(data?.subscriptionPlanCode || 'free');
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
  const canSave =
    !!selectedPlan && selectedCode !== currentCode && !DISABLED_PLAN_CODES.has(selectedCode) && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    const now = new Date();
    const confirmText =
      selectedPlan.code === 'free'
        ? '무료 플랜으로 변경하면 현재 구독이 바로 취소되고, 자동매매가 모두 OFF 됩니다.\n변경하시겠습니까?'
        : `${planTitle(selectedPlan)} 플랜으로 변경합니다.\n이용 기간: ${formatDate(now)} ~ ${formatDate(oneMonthLater(now))} (1개월)\n변경하시겠습니까?`;
    if (!window.confirm(confirmText)) return;

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const { data } = await apiClient.post('/subscription', { planCode: selectedPlan.code });
      await loadMe();
      setMessage(data?.message || '구독 플랜이 변경되었습니다.');
    } catch (e) {
      setError(e.response?.data?.error || '구독 변경에 실패했습니다.');
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
            구독플랜
          </Typography>
        </Box>
      </Paper>

      <Box sx={{ width: { xs: '100%', md: '50%', lg: 'calc(100% / 3)' }, minWidth: { md: 480 } }}>
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
            <SectionTitle>현재 구독</SectionTitle>
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
              </Box>
              <Typography variant="body2" color="text.secondary">
                {subscribed
                  ? `시작일: ${formatDate(me.subscriptionStartedAt)} · 만료일: ${formatDate(me.subscriptionExpiresAt)}`
                  : '유료 구독이 없습니다.'}
              </Typography>
            </Paper>

            <SectionTitle>플랜 선택</SectionTitle>
            {plans.map((plan) => {
              const isCurrent = plan.code === currentCode;
              const isFree = plan.code === 'free';
              const isDisabled = DISABLED_PLAN_CODES.has(plan.code);
              const isSelected = plan.code === selectedCode;
              const selectable = !isDisabled && !saving;
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
                    checked={isSelected && !isDisabled}
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
                  ) : (
                    isDisabled && <Chip size="small" label="준비중" sx={{ flexShrink: 0 }} />
                  )}
                </Paper>
              );
            })}

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
              <Button variant="contained" onClick={handleSave} disabled={!canSave}>
                {saving ? <CircularProgress size={20} color="inherit" /> : '저장'}
              </Button>
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              ※ 유료 플랜은 신청한 날부터 1개월간 이용됩니다. 연간 구독은 준비 중입니다.
            </Typography>
          </>
        )}
      </Box>
    </PageFrame>
  );
};

export default SubscriptionPlans;

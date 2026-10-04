import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import apiClient from '../utils/axios';

const STRATEGY_LABEL = { SPLIT_TRADE: '분할', INFINITE_TRADE: '무한' };

/**
 * 보유종목 일괄청산: 비밀번호 확인 → 진행 확인 → 매도
 * 국내: 최유리지정가(매수 최우선호가) / 미국: 화면 표시 시세(livePrice) 지정가
 * @param {{ open: boolean, target: { stockCode, stockName, isUs?: boolean, plans: {planId, strategyType}[] } | null, livePrice?: number, onClose: Function, onDone?: Function }} props
 */
const LiquidateDialog = ({ open, target, livePrice = 0, onClose, onDone }) => {
  const isUs = !!target?.isUs;
  const [step, setStep] = useState('password');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null);

  useEffect(() => {
    if (open) {
      setStep('password');
      setPassword('');
      setBusy(false);
      setError(null);
      setResults(null);
    }
  }, [open]);

  const handleClose = () => {
    if (busy) return;
    setPassword('');
    onClose();
  };

  const handleVerify = async () => {
    if (!password) {
      setError('비밀번호를 입력해주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.post('/auth/verify-password', { password });
      if (res.data?.verified) {
        setStep('confirm');
      } else {
        setError('비밀번호가 일치하지 않습니다.');
      }
    } catch (err) {
      setError(err.response?.data?.error || '비밀번호 확인 중 오류가 발생했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const handleLiquidate = async () => {
    if (isUs && !(Number(livePrice) > 0)) {
      setError('표시된 시세가 없어 지정가를 정할 수 없습니다.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.post('/trading-v2/liquidate', {
        password,
        planIds: (target?.plans || []).map((p) => p.planId),
        ...(isUs ? { limitPrice: Number(livePrice) } : {}),
      });
      setResults(res.data?.results || []);
      setStep('result');
      if (onDone) onDone(res.data);
    } catch (err) {
      setError(err.response?.data?.error || '일괄청산 요청에 실패했습니다.');
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  const title = target ? `${target.stockName || target.stockCode} (${target.stockCode})` : '';

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, fontSize: '1rem' }}>일괄청산 · {title}</DialogTitle>
      <DialogContent>
        {step === 'password' && (
          <Box sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              본인 확인을 위해 로그인 비밀번호를 입력해주세요.
            </Typography>
            <TextField
              type="password"
              label="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) handleVerify();
              }}
              autoFocus
              fullWidth
              size="small"
              autoComplete="current-password"
            />
          </Box>
        )}

        {step === 'confirm' && (
          <Box sx={{ pt: 1 }}>
            <Typography variant="body1" sx={{ fontWeight: 700, mb: 1 }}>
              일괄청산을 진행 하시겠습니까?
            </Typography>
            <Typography variant="body2" color="text.secondary">
              대상: {(target?.plans || []).map((p) => STRATEGY_LABEL[p.strategyType] || p.strategyType).join(' · ')}
            </Typography>
            {isUs && (
              <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 700 }}>
                지정가: ${Number(livePrice) > 0 ? Number(livePrice).toFixed(Number(livePrice) >= 1 ? 2 : 4) : '-'}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {isUs
                ? '미체결 주문을 취소하고 보유 잔량 전부를 현재 표시된 시세로 지정가 매도합니다. 시세가 움직이면 미체결로 남을 수 있습니다.'
                : '미체결 주문을 취소하고 보유 잔량 전부를 매수 최우선호가(최유리지정가)로 즉시 매도합니다.'}{' '}
              체결 후 해당 플랜은 종료되어 재매수하지 않습니다.
            </Typography>
          </Box>
        )}

        {step === 'result' && (
          <Box sx={{ pt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {(results || []).map((r) => (
              <Alert key={r.planId} severity={r.ok ? 'success' : 'error'} sx={{ py: 0 }}>
                {STRATEGY_LABEL[r.strategyType] || `플랜 ${r.planId}`}:{' '}
                {r.ok
                  ? r.message ||
                    (r.orders || [])
                      .map((o) =>
                        o.ok ? `${o.stageNo}차 ${o.qty}주 접수` : `${o.stageNo}차 실패(${o.error})`
                      )
                      .join(', ')
                  : r.error}
              </Alert>
            ))}
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 1.5, py: 0 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        {step === 'result' ? (
          <Button onClick={handleClose} variant="contained">
            닫기
          </Button>
        ) : (
          <>
            <Button onClick={handleClose} disabled={busy}>
              취소
            </Button>
            <Button
              onClick={step === 'password' ? handleVerify : handleLiquidate}
              variant="contained"
              color={step === 'confirm' ? 'error' : 'primary'}
              disabled={busy}
              startIcon={busy ? <CircularProgress size={16} color="inherit" /> : null}
            >
              확인
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default LiquidateDialog;

import React, { useCallback, useEffect, useState } from 'react';
import {
  Paper,
  Box,
  Typography,
  Card,
  CardContent,
  Chip,
  TextField,
  Button,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import DnsIcon from '@mui/icons-material/Dns';
import apiClient from '../utils/axios';
import PageFrame from '../components/PageFrame';
import { formatKstDateTime } from '../utils/formatUtils';

const ServerRegistration = () => {
  const [status, setStatus] = useState(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/auth/server-registration');
      setStatus(data);
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || '등록 상태를 불러오지 못했습니다.' });
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleRegister = async () => {
    setConfirmOpen(false);
    setLoading(true);
    setMessage(null);
    try {
      const { data } = await apiClient.post('/auth/server-registration', { password });
      setPassword('');
      setMessage({ type: 'success', text: data.message || '서버 등록이 완료되었습니다.' });
      await fetchStatus();
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || '서버 등록 중 오류가 발생했습니다.' });
    } finally {
      setLoading(false);
    }
  };

  const registered = !!status?.registered;

  return (
    <PageFrame>
      <Paper sx={{ px: 2, py: 1.25, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <DnsIcon sx={{ fontSize: '1.05rem', color: '#4fc3f7' }} />
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            서버 등록
          </Typography>
        </Box>
      </Paper>

      {message && (
        <Alert severity={message.type} sx={{ mb: 2 }} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
              등록 상태
            </Typography>
            {status && (
              <Chip
                size="small"
                color={registered ? 'success' : 'default'}
                label={registered ? '등록됨' : '미등록'}
              />
            )}
          </Box>

          {registered ? (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.75 }}>
              <Typography variant="body2" color="text.secondary">에이전트 ID</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{status.agentId}</Typography>
              <Typography variant="body2" color="text.secondary">등록 일시</Typography>
              <Typography variant="body2">{formatKstDateTime(status.registeredAt)}</Typography>
              <Typography variant="body2" color="text.secondary">마지막 동기화</Typography>
              <Typography variant="body2">{formatKstDateTime(status.lastSyncedAt)}</Typography>
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              이 서버는 아직 PlanGo 인증서비스에 등록되지 않았습니다. 서버를 등록해야 모든 기능을
              정상적으로 이용 가능합니다.
            </Typography>
          )}
        </CardContent>
      </Card>

      {status && !registered && (
      <Card>
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1 }}>
            이 서버 등록하기
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            비밀번호를 다시 확인한 뒤 PlanGo 인증서비스 에서 이 서버의 에이전트 키를 발급받습니다.
            한 계정에는 서버 한 대만 등록되며, 다른 서버에 등록되어 있었다면 그 서버의 등록은 해제됩니다.
          </Typography>
          <Box
            component="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (password) setConfirmOpen(true);
            }}
            sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}
          >
            <TextField
              type="password"
              size="small"
              label="PlanGo.Today 비밀번호"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              sx={{ minWidth: 260 }}
            />
            <Button type="submit" variant="contained" disabled={loading || !password}>
              {loading ? '등록 중...' : '서버 등록'}
            </Button>
          </Box>
        </CardContent>
      </Card>
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>서버 등록</DialogTitle>
        <DialogContent>
          <DialogContentText>
            이 서버를 PlanGo.Today 에 등록합니다. 이 계정으로 다른 서버가 등록되어 있다면 해제됩니다. 계속할까요?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>취소</Button>
          <Button onClick={handleRegister} variant="contained" autoFocus>
            등록
          </Button>
        </DialogActions>
      </Dialog>
    </PageFrame>
  );
};

export default ServerRegistration;

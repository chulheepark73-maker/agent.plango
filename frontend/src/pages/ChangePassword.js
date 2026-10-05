import React, { useState } from 'react';
import { Paper, Box, Typography, Alert, TextField, Button } from '@mui/material';
import LockResetIcon from '@mui/icons-material/LockReset';
import LockIcon from '@mui/icons-material/Lock';
import apiClient from '../utils/axios';
import PageFrame from '../components/PageFrame';

const MIN_LENGTH = 6;

const errorText = (error, fallback) =>
  error?.response?.data?.error || error?.response?.data?.errors?.[0]?.msg || fallback;

const SectionTitle = ({ children }) => (
  <Typography sx={{ fontWeight: 'bold', fontSize: '0.95rem', mb: 1.25 }}>{children}</Typography>
);

const ChangePassword = () => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [verified, setVerified] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleVerify = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { data } = await apiClient.post('/auth/verify-password', { password: currentPassword });
      if (data?.verified) {
        setVerified(true);
      } else {
        setMessage({ type: 'error', text: '비밀번호가 일치하지 않습니다.' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: errorText(error, '비밀번호 확인 중 오류가 발생했습니다.') });
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setMessage(null);
    if (newPassword.length < MIN_LENGTH) {
      setMessage({ type: 'error', text: `새 비밀번호는 최소 ${MIN_LENGTH}자 이상이어야 합니다.` });
      return;
    }
    if (newPassword !== confirm) {
      setMessage({ type: 'error', text: '새 비밀번호가 서로 다릅니다. 다시 입력해주세요.' });
      return;
    }
    setBusy(true);
    try {
      const { data } = await apiClient.put('/auth/change-password', { currentPassword, newPassword });
      setMessage({ type: 'success', text: data.message || '비밀번호가 변경되었습니다.' });
      setVerified(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (error) {
      setMessage({ type: 'error', text: errorText(error, '비밀번호 변경 중 오류가 발생했습니다.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageFrame>
      <Paper sx={{ px: 2, py: 1.25, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LockResetIcon sx={{ fontSize: '1.05rem' }} />
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            비밀번호변경
          </Typography>
        </Box>
      </Paper>

      <Box sx={{ width: { xs: '100%', md: '50%', lg: 'calc(100% / 3)' }, minWidth: { md: 480 } }}>
        {message && (
          <Alert severity={message.type} sx={{ mb: 2 }} onClose={() => setMessage(null)}>
            {message.text}
          </Alert>
        )}

        {!verified ? (
          <>
            <SectionTitle>현재 비밀번호 확인</SectionTitle>
            <Paper variant="outlined" component="form" onSubmit={handleVerify} sx={{ p: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, color: 'text.secondary' }}>
                <LockIcon fontSize="small" />
                <Typography variant="body2">현재 사용 중인 비밀번호를 입력해주세요.</Typography>
              </Box>
              <TextField
                fullWidth
                size="small"
                type="password"
                label="현재 비밀번호"
                autoComplete="current-password"
                autoFocus
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                sx={{ mb: 2 }}
              />
              <Button type="submit" variant="contained" fullWidth disabled={busy || !currentPassword}>
                확인
              </Button>
            </Paper>
          </>
        ) : (
          <>
            <SectionTitle>새 비밀번호</SectionTitle>
            <Paper
              variant="outlined"
              component="form"
              onSubmit={handleSave}
              sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              <TextField
                size="small"
                type="password"
                label={`새 비밀번호 (${MIN_LENGTH}자 이상)`}
                autoComplete="new-password"
                autoFocus
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <TextField
                size="small"
                type="password"
                label="새 비밀번호 재입력"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              <Button type="submit" variant="contained" disabled={busy || !newPassword || !confirm}>
                저장
              </Button>
            </Paper>
          </>
        )}
      </Box>
    </PageFrame>
  );
};

export default ChangePassword;

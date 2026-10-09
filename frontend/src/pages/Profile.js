import React, { useEffect, useState } from 'react';
import { Paper, Box, Typography, Alert, TextField, Button } from '@mui/material';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import LockIcon from '@mui/icons-material/Lock';
import apiClient from '../utils/axios';
import PageFrame, { pageHeaderSx } from '../components/PageFrame';
import { useAuth } from '../contexts/AuthContext';

const PHONE_RE = /^01[0-9]{9}$/;

const errorText = (error, fallback) =>
  error?.response?.data?.error || error?.response?.data?.errors?.[0]?.msg || fallback;

const SectionTitle = ({ children }) => (
  <Typography sx={{ fontWeight: 'bold', fontSize: '0.95rem', mb: 1.25 }}>{children}</Typography>
);

const Profile = () => {
  const { user, fetchUser } = useAuth();
  const [verified, setVerified] = useState(false);
  const [password, setPassword] = useState('');
  const [profile, setProfile] = useState({ username: '', phoneNumber: '' });
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!verified) return;
    setProfile({ username: user?.username || '', phoneNumber: user?.phoneNumber || '' });
  }, [verified, user]);

  const phoneInvalid = !!profile.phoneNumber && !PHONE_RE.test(profile.phoneNumber.replace(/[-\s]/g, ''));

  const handleVerify = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { data } = await apiClient.post('/auth/verify-password', { password });
      if (data?.verified) {
        setVerified(true);
        setPassword('');
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
    setBusy(true);
    setMessage(null);
    try {
      const { data } = await apiClient.put('/auth/profile', {
        username: profile.username.trim(),
        phoneNumber: profile.phoneNumber.replace(/[-\s]/g, ''),
      });
      setMessage({ type: 'success', text: data.message || '개인정보가 수정되었습니다.' });
      fetchUser?.();
    } catch (error) {
      setMessage({ type: 'error', text: errorText(error, '개인정보 수정 중 오류가 발생했습니다.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageFrame>
      <Paper sx={pageHeaderSx}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ManageAccountsIcon sx={{ fontSize: '1.05rem' }} />
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            내 정보관리
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
            <SectionTitle>비밀번호 확인</SectionTitle>
            <Paper variant="outlined" component="form" onSubmit={handleVerify} sx={{ p: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, color: 'text.secondary' }}>
                <LockIcon fontSize="small" />
                <Typography variant="body2">개인정보 보호를 위해 비밀번호를 다시 입력해주세요.</Typography>
              </Box>
              <TextField
                fullWidth
                size="small"
                type="password"
                label="비밀번호"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                sx={{ mb: 2 }}
              />
              <Button type="submit" variant="contained" fullWidth disabled={busy || !password}>
                확인
              </Button>
            </Paper>
          </>
        ) : (
          <>
            <SectionTitle>개인정보</SectionTitle>
            <Paper
              variant="outlined"
              component="form"
              onSubmit={handleSave}
              sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              <TextField label="이메일" size="small" value={user?.email || ''} disabled />
              <TextField
                label="이름"
                size="small"
                value={profile.username}
                onChange={(e) => setProfile((p) => ({ ...p, username: e.target.value }))}
              />
              <TextField
                label="휴대폰 번호"
                size="small"
                placeholder="01012345678"
                value={profile.phoneNumber}
                onChange={(e) =>
                  setProfile((p) => ({ ...p, phoneNumber: e.target.value.replace(/[^0-9-]/g, '') }))
                }
                error={phoneInvalid}
                helperText={phoneInvalid ? '올바른 휴대폰 번호를 입력하세요. (예: 01012345678)' : ''}
              />
              <Button
                type="submit"
                variant="contained"
                disabled={busy || !profile.username.trim() || !profile.phoneNumber || phoneInvalid}
              >
                저장
              </Button>
            </Paper>
          </>
        )}
      </Box>
    </PageFrame>
  );
};

export default Profile;

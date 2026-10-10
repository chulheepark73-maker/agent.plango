import React, { useEffect, useState } from 'react';
import { Paper, Box, Typography, Alert, TextField, Button } from '@mui/material';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import LockIcon from '@mui/icons-material/Lock';
import apiClient from '../utils/axios';
import PageFrame, { pageHeaderSx } from '../components/PageFrame';
import { useAuth } from '../contexts/AuthContext';
import useCentralStatus from '../hooks/useCentralStatus';
import { isGuestEmail } from '../utils/guest';

const PHONE_RE = /^01[0-9]{9}$/;
const MIN_PASSWORD_LENGTH = 6;

const errorText = (error, fallback) =>
  error?.response?.data?.error || error?.response?.data?.errors?.[0]?.msg || fallback;

const SectionTitle = ({ children }) => (
  <Typography sx={{ fontWeight: 'bold', fontSize: '0.95rem', mb: 1.25 }}>{children}</Typography>
);

const Profile = () => {
  const { user, fetchUser } = useAuth();
  const [verified, setVerified] = useState(false);
  const [password, setPassword] = useState('');
  const [verifiedPassword, setVerifiedPassword] = useState('');
  const [profile, setProfile] = useState({ username: '', phoneNumber: '' });
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const { checking, offlineMessage, recheck } = useCentralStatus();
  const offline = !!offlineMessage;
  const isGuest = isGuestEmail(user?.email);

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
        setVerifiedPassword(password);
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
    setMessage(null);
    const changePassword = !isGuest && !!(newPassword || confirmPassword);
    if (changePassword) {
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setMessage({ type: 'error', text: `새 비밀번호는 최소 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.` });
        return;
      }
      if (newPassword !== confirmPassword) {
        setMessage({ type: 'error', text: '새 비밀번호가 서로 다릅니다. 다시 입력해주세요.' });
        return;
      }
    }

    setBusy(true);
    let profileSaved = false;
    try {
      await apiClient.put('/auth/profile', {
        username: profile.username.trim(),
        phoneNumber: profile.phoneNumber.replace(/[-\s]/g, ''),
      });
      profileSaved = true;
      fetchUser?.();

      if (changePassword) {
        await apiClient.put('/auth/change-password', {
          currentPassword: verifiedPassword,
          newPassword,
        });
        setVerifiedPassword(newPassword);
        setNewPassword('');
        setConfirmPassword('');
      }
      setMessage({
        type: 'success',
        text: changePassword ? '개인정보와 비밀번호가 변경되었습니다.' : '개인정보가 수정되었습니다.',
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: profileSaved
          ? `개인정보는 수정되었지만 비밀번호 변경에 실패했습니다. ${errorText(error, '')}`.trim()
          : errorText(error, '개인정보 수정 중 오류가 발생했습니다.'),
      });
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

      {offline && (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={recheck} disabled={checking}>
              다시 확인
            </Button>
          }
        >
          {offlineMessage}
        </Alert>
      )}
      {message && (
        <Alert severity={message.type} sx={{ mb: 2 }} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}

      <Box sx={{ width: { xs: '100%', md: '50%', lg: 'calc(100% / 3)' }, minWidth: { md: 480 } }}>
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
                disabled={checking || offline}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                sx={{ mb: 2 }}
              />
              <Button
                type="submit"
                variant="contained"
                fullWidth
                disabled={busy || checking || offline || !password}
              >
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
              <Box sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 2 }}>
                <Typography sx={{ fontWeight: 'bold', fontSize: '0.875rem' }}>비밀번호 변경</Typography>
                <Typography variant="caption" color="text.secondary">
                  {isGuest
                    ? '게스트 모드에서는 비밀번호를 변경할 수 없습니다.'
                    : '변경하지 않으려면 비워 두세요.'}
                </Typography>
              </Box>
              {!isGuest && (
                <>
                  <TextField
                    size="small"
                    type="password"
                    label={`새 비밀번호 (${MIN_PASSWORD_LENGTH}자 이상)`}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <TextField
                    size="small"
                    type="password"
                    label="새 비밀번호 재입력"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </>
              )}
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

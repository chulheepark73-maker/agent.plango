import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Alert,
  Divider,
  Box,
} from '@mui/material';
import PrivacyTipIcon from '@mui/icons-material/PrivacyTip';
import apiClient from '../utils/axios';

const PHONE_RE = /^01[0-9]{9}$/;

const errorText = (error, fallback) =>
  error?.response?.data?.error || error?.response?.data?.errors?.[0]?.msg || fallback;

/** 개인정보(이름·휴대폰)·비밀번호 변경 — PlanGo 인증서비스에 반영 */
const ProfileDialog = ({ open, onClose, user, onSaved }) => {
  const [profile, setProfile] = useState({ username: '', phoneNumber: '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProfile({ username: user?.username || '', phoneNumber: user?.phoneNumber || '' });
    setPw({ currentPassword: '', newPassword: '', confirm: '' });
    setMessage(null);
  }, [open, user]);

  const phoneInvalid = !!profile.phoneNumber && !PHONE_RE.test(profile.phoneNumber.replace(/[-\s]/g, ''));
  const pwMismatch = !!pw.confirm && pw.newPassword !== pw.confirm;

  const saveProfile = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const { data } = await apiClient.put('/auth/profile', {
        username: profile.username.trim(),
        phoneNumber: profile.phoneNumber.replace(/[-\s]/g, ''),
      });
      setMessage({ type: 'success', text: data.message || '개인정보가 수정되었습니다.' });
      onSaved?.();
    } catch (error) {
      setMessage({ type: 'error', text: errorText(error, '개인정보 수정 중 오류가 발생했습니다.') });
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const { data } = await apiClient.put('/auth/change-password', {
        currentPassword: pw.currentPassword,
        newPassword: pw.newPassword,
      });
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      setMessage({ type: 'success', text: data.message || '비밀번호가 변경되었습니다.' });
    } catch (error) {
      setMessage({ type: 'error', text: errorText(error, '비밀번호 변경 중 오류가 발생했습니다.') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <PrivacyTipIcon fontSize="small" />
        개인정보 변경
      </DialogTitle>
      <DialogContent>
        {message && (
          <Alert severity={message.type} sx={{ mb: 2 }} onClose={() => setMessage(null)}>
            {message.text}
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
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
            onChange={(e) => setProfile((p) => ({ ...p, phoneNumber: e.target.value.replace(/[^0-9-]/g, '') }))}
            error={phoneInvalid}
            helperText={phoneInvalid ? '올바른 휴대폰 번호를 입력하세요. (예: 01012345678)' : ''}
          />
          <Button
            variant="contained"
            onClick={saveProfile}
            disabled={saving || !profile.username.trim() || !profile.phoneNumber || phoneInvalid}
          >
            개인정보 저장
          </Button>
        </Box>

        <Divider sx={{ my: 3 }} />

        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 1.5 }}>
          비밀번호 변경
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label="현재 비밀번호"
            type="password"
            size="small"
            autoComplete="current-password"
            value={pw.currentPassword}
            onChange={(e) => setPw((p) => ({ ...p, currentPassword: e.target.value }))}
          />
          <TextField
            label="새 비밀번호 (6자 이상)"
            type="password"
            size="small"
            autoComplete="new-password"
            value={pw.newPassword}
            onChange={(e) => setPw((p) => ({ ...p, newPassword: e.target.value }))}
          />
          <TextField
            label="새 비밀번호 확인"
            type="password"
            size="small"
            autoComplete="new-password"
            value={pw.confirm}
            onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))}
            error={pwMismatch}
            helperText={pwMismatch ? '비밀번호가 일치하지 않습니다.' : ''}
          />
          <Button
            variant="outlined"
            onClick={changePassword}
            disabled={
              saving || !pw.currentPassword || pw.newPassword.length < 6 || pw.newPassword !== pw.confirm
            }
          >
            비밀번호 변경
          </Button>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>닫기</Button>
      </DialogActions>
    </Dialog>
  );
};

export default ProfileDialog;

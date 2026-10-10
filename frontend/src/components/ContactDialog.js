import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  IconButton,
  Tooltip,
  Link,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import SupportAgentIcon from '@mui/icons-material/SupportAgent';
import { useAuth } from '../contexts/AuthContext';

export const CONTACT_EMAIL = 'k9200391@naver.com';
const KAKAO_CHANNEL_URL = 'http://pf.kakao.com/_eFiFX';
const NAVER_CAFE_URL = 'https://cafe.naver.com/plango5';

const buildMailto = ({ userEmail, appVersion }) => {
  const body = [
    '문의 내용:',
    '',
    '',
    '',
    '----',
    `계정: ${userEmail || '-'}`,
    `버전: ${appVersion ? `v${appVersion}` : '-'}`,
    `브라우저: ${navigator.userAgent}`,
  ].join('\n');
  const params = new URLSearchParams({ subject: '[PlanGo 문의] ', body });
  return `mailto:${CONTACT_EMAIL}?${params.toString().replace(/\+/g, '%20')}`;
};

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
};

const labelSx = { fontSize: '0.8rem', color: 'text.secondary', width: 64, flexShrink: 0 };

/** @param {{ open: boolean, onClose: () => void, appVersion?: string }} props */
const ContactDialog = ({ open, onClose, appVersion }) => {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  const handleCopy = async () => {
    setCopied(await copyText(CONTACT_EMAIL));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      sx={{ '& .MuiDialog-paper': { maxWidth: 520 } }}
    >
      <DialogTitle sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
        <SupportAgentIcon sx={{ fontSize: '1.3rem', color: 'primary.main' }} />
        문의하기
      </DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
          <Typography sx={labelSx}>이메일</Typography>
          <Typography sx={{ fontWeight: 600, fontSize: '0.9rem' }}>{CONTACT_EMAIL}</Typography>
          <Tooltip title={copied ? '복사됨' : '주소 복사'}>
            <IconButton size="small" onClick={handleCopy} sx={{ ml: 0.5 }}>
              {copied ? (
                <CheckIcon sx={{ fontSize: '1rem', color: 'success.main' }} />
              ) : (
                <ContentCopyIcon sx={{ fontSize: '1rem' }} />
              )}
            </IconButton>
          </Tooltip>
        </Box>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ ml: 8, mb: 2 }}>
          메일 프로그램이 열리지 않으면 주소를 복사해 사용하는 메일에서 보내주세요.
        </Typography>

        <Typography sx={{ fontWeight: 'bold', fontSize: '0.85rem', mb: 1 }}>다른 문의 방법</Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <Link href={KAKAO_CHANNEL_URL} target="_blank" rel="noopener noreferrer" sx={{ fontSize: '0.85rem' }}>
            카카오톡 채널 1:1 상담
          </Link>
          <Link href={NAVER_CAFE_URL} target="_blank" rel="noopener noreferrer" sx={{ fontSize: '0.85rem' }}>
            PlanGo 네이버카페 Q&amp;A
          </Link>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pt: 1.5, pb: 3 }}>
        <Button onClick={onClose}>닫기</Button>
        <Button variant="contained" href={buildMailto({ userEmail: user?.email, appVersion })}>
          메일 보내기
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ContactDialog;

import React, { useEffect, useState } from 'react';
import { Paper, Box, Typography, Alert, Button, Chip } from '@mui/material';
import TelegramIcon from '@mui/icons-material/Telegram';
import ChatBubbleIcon from '@mui/icons-material/ChatBubble';
import apiClient from '../utils/axios';
import PageFrame, { pageHeaderSx } from '../components/PageFrame';

const TelegramSettings = () => {
  const [settings, setSettings] = useState({
    agentRegistered: undefined,
    hasTelegramChatId: false,
    telegramDeepLinkReady: false,
    telegramLinkPending: false,
  });
  const [waitingForChat, setWaitingForChat] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const fetchSettings = async () => {
    const { data } = await apiClient.get('/settings');
    setSettings((prev) => ({ ...prev, ...data }));
    return data;
  };

  useEffect(() => {
    fetchSettings().catch(() => {
      setMessage({ type: 'error', text: '설정을 불러오는데 실패했습니다.' });
    });
  }, []);

  useEffect(() => {
    if (!waitingForChat) return undefined;

    const interval = setInterval(async () => {
      try {
        const data = await fetchSettings();
        if (data.hasTelegramChatId) {
          setWaitingForChat(false);
          setMessage({ type: 'success', text: '텔레그램 알림이 연결되었습니다.' });
        }
      } catch {
        /* 무시 */
      }
    }, 2000);

    const timeout = setTimeout(() => {
      setWaitingForChat(false);
    }, 120000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [waitingForChat]);

  const handleDeepLink = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const { data } = await apiClient.post('/settings/telegram-deep-link');
      setSettings((prev) => ({ ...prev, telegramLinkPending: true }));
      setWaitingForChat(true);
      window.open(data.botUrl, '_blank', 'noopener,noreferrer');
      setMessage({
        type: 'success',
        text: '텔레그램이 열렸습니다. 봇 채팅에서「시작」을 눌러 연결을 완료하세요. (최대 약 2분간 연결 상태를 확인합니다)',
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '연결 링크를 만들 수 없습니다. 서버 텔레그램 설정을 확인하세요.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageFrame>
      <Paper sx={pageHeaderSx}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TelegramIcon sx={{ fontSize: '1.05rem' }} />
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            텔레그램 설정
          </Typography>
        </Box>
      </Paper>

      {message && (
        <Alert severity={message.type} sx={{ mb: 2 }} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            md: 'repeat(2, minmax(0, 1fr))',
            lg: 'repeat(3, minmax(0, 1fr))',
          },
          gap: 2,
          alignItems: 'stretch',
        }}
      >
        <Paper sx={{ p: 3 }}>
          <Box display="flex" alignItems="center" flexWrap="wrap" gap={1} sx={{ mb: 2 }}>
            <Typography
              variant="h6"
              sx={{ fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
            >
              <TelegramIcon sx={{ fontSize: '1.05rem' }} />
              텔레그램 알림 기능 설정
            </Typography>
            {settings.hasTelegramChatId && (
              <Chip label="텔레그램 알림 연결됨" color="success" size="small" />
            )}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            <strong>연결 방법:</strong> 「텔레그램 봇으로 연결」을 누르면 텔레그램이 열리고, 봇 채팅에서 <strong>시작(/start)</strong>을 누르면 이 계정에 채팅 ID가
            저장되어 알림을 받을 수 있습니다.
            <strong>알림 내용:</strong> Trailing 의 시작과 종료가 모두 텔레그램 알림으로 전달합니다. 최종 체결 여부는 카카오톡 메세지로 키움증권 제공입니디.
          </Typography>
          {settings.agentRegistered === false && (
            <Alert severity="info" sx={{ mb: 2 }}>
              텔레그램 알림은 서버 등록 후 사용할 수 있습니다. 상단의 <strong>서버 등록</strong> 메뉴에서 등록하세요.
            </Alert>
          )}
          {settings.agentRegistered && !settings.telegramDeepLinkReady && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              PlanGo 인증서비스에 텔레그램 봇이 설정되어 있지 않습니다. 관리자에게 문의하세요.
            </Alert>
          )}
          {settings.telegramLinkPending && (
            <Chip
              label="봇에서 /start 대기 중 (링크 유효 약 15분)"
              color="primary"
              size="small"
              sx={{ mb: 2 }}
            />
          )}
          <Box>
            <Button
              variant="contained"
              color="primary"
              onClick={handleDeepLink}
              disabled={loading || !settings.telegramDeepLinkReady || settings.hasTelegramChatId}
              size="medium"
            >
              텔레그램 봇으로 연결
            </Button>
            {waitingForChat && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                봇에서 시작을 누른 뒤 잠시만 기다려 주세요…
              </Typography>
            )}
          </Box>
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Box display="flex" alignItems="center" flexWrap="wrap" gap={1} sx={{ mb: 2 }}>
            <Typography
              variant="h6"
              sx={{ fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
            >
              <ChatBubbleIcon sx={{ fontSize: '1.05rem', color: '#FEE500' }} />
              카카오톡 알림 기능 설정
            </Typography>
            <Chip label="키움증권 제공" size="small" variant="outlined" />
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            <strong>연결 방법:</strong> 카카오톡 알림은 PlanGo가 아닌 <strong>키움증권</strong>에서 보내는 알림입니다.
            키움증권 앱(영웅문)의 알림 설정에서 카카오톡 알림을 신청하면 받을 수 있습니다.
            <br />
            <strong>알림 내용:</strong> PlanGo가 낸 주문이 체결되면 체결 종목·수량·가격이 카카오톡 메세지로 전달됩니다.
          </Typography>
          <Alert severity="info">
            텔레그램(Trailing 시작·종료)과 카카오톡(최종 체결)을 함께 사용하면 주문 진행 상황을 모두 확인할 수 있습니다.
          </Alert>
        </Paper>
      </Box>
    </PageFrame>
  );
};

export default TelegramSettings;

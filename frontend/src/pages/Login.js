import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Container,
  Paper,
  TextField,
  Button,
  Typography,
  Box,
  Alert,
  Link,
} from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../utils/axios';
import { centralUrl } from '../utils/central';

const linkSx = {
  color: 'text.primary',
  textDecoration: 'none',
  fontSize: '0.875rem',
  '&:hover': { textDecoration: 'underline' },
};

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [loading, setLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState(null);
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    apiClient
      .get('/auth/agent-status')
      .then(({ data }) => setAgentStatus(data))
      .catch(() => setAgentStatus(null));
  }, []);

  const validateEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setEmailError('');

    if (!email) {
      setEmailError('이메일을 입력하세요.');
      return;
    }
    if (!validateEmail(email)) {
      setEmailError('유효한 이메일 주소를 입력하세요.');
      return;
    }
    if (!password) {
      setError('비밀번호를 입력하세요.');
      return;
    }

    setLoading(true);
    try {
      const result = await login(email, password);
      if (result.success) {
        navigate('/dashboard');
      } else if (result.requiresVerification) {
        setError('이메일 인증이 완료되지 않았습니다. PlanGo.Today 에서 이메일 인증을 완료해주세요.');
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError('오류가 발생했습니다. 다시 시도해주세요.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
      }}
    >
      <Container component="main" maxWidth="sm">
        <Paper
          elevation={0}
          sx={{
            padding: 4,
            width: '115%',
            maxWidth: '575px',
            margin: '0 auto',
            bgcolor: 'background.default',
            border: 'none',
            boxShadow: 'none',
          }}
        >
          <Link
            href={`${process.env.PUBLIC_URL || ''}/plango-landing.html`}
            variant="body2"
            underline="none"
            sx={{
              color: '#D4AF37',
              fontWeight: 600,
              marginBottom: 1.5,
              display: 'inline-block',
              '&:hover': { color: '#B8962E', textDecoration: 'none' },
            }}
          >
            ✨ PlanGo 둘러보기
          </Link>
          <Typography
            component="h1"
            variant="h4"
            sx={{ fontWeight: 'bold', color: 'text.primary', marginBottom: 0.75 }}
          >
            로그인
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            PlanGo.Today 계정으로 로그인합니다.
            {agentStatus?.paired
              ? ` 이 에이전트는 ${agentStatus.ownerEmail} 계정에 연결되어 있습니다.`
              : ' 처음 로그인한 계정이 이 에이전트의 주인으로 등록됩니다.'}
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          <Box component="form" onSubmit={handleLogin}>
            <TextField
              fullWidth
              id="email"
              placeholder="이메일"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError('');
              }}
              error={!!emailError}
              helperText={emailError}
              sx={{ mb: 2, '& .MuiOutlinedInput-root': { borderRadius: '4px' } }}
            />

            <TextField
              fullWidth
              name="password"
              placeholder="비밀번호"
              type="password"
              id="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              sx={{ mb: 2, '& .MuiOutlinedInput-root': { borderRadius: '4px' } }}
            />

            <Button
              type="submit"
              fullWidth
              variant="contained"
              color="primary"
              disabled={loading || !!emailError}
              sx={{ mt: 2, mb: 0.5, py: 1.5, borderRadius: '4px' }}
            >
              {loading ? '처리 중...' : '로그인 진행'}
            </Button>

            <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1.5 }}>
              <Link href={centralUrl('/login')} target="_blank" rel="noopener noreferrer" sx={linkSx}>
                계정 만들기 (PlanGo.Today)
              </Link>
              <Link href={centralUrl('/login')} target="_blank" rel="noopener noreferrer" sx={linkSx}>
                비밀번호를 잊어버리셨나요?
              </Link>
            </Box>
          </Box>
        </Paper>
      </Container>
    </Box>
  );
};

export default Login;

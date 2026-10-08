import React, { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  AppBar,
  Toolbar,
  Box,
  IconButton,
  Tooltip,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Alert,
  useTheme,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import TuneIcon from '@mui/icons-material/Tune';
import SettingsIcon from '@mui/icons-material/Settings';
import LogoutIcon from '@mui/icons-material/Logout';
import CandlestickChartIcon from '@mui/icons-material/CandlestickChart';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import AssessmentIcon from '@mui/icons-material/Assessment';
import DnsIcon from '@mui/icons-material/Dns';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import LockResetIcon from '@mui/icons-material/LockReset';
import TelegramIcon from '@mui/icons-material/Telegram';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import { useAuth } from '../contexts/AuthContext';
import { useThemeMode } from '../contexts/ThemeModeContext';
import apiClient from '../utils/axios';
import Footer from './Footer';

// light / dark AppBar 대비에 맞춘 아이콘 색
const menuItems = [
  { Icon: DashboardIcon, path: '/dashboard', tooltip: '대시보드' },
  {
    Icon: AccountTreeIcon,
    path: '/trading-v2',
    tooltip: '관심종목',
    iconColorLight: '#00796b',
    iconColorDark: '#80cbc4',
  },
  {
    Icon: TuneIcon,
    path: '/indicator-trading',
    tooltip: '지표기반매매',
    iconColorLight: '#f9a825',
    iconColorDark: '#ffeb3b',
  },
  {
    Icon: AssessmentIcon,
    path: '/report',
    tooltip: '리포트',
    iconColorLight: '#5e35b1',
    iconColorDark: '#b39ddb',
  },
  {
    Icon: SettingsIcon,
    path: '/settings',
    tooltip: '환경설정',
    iconColorLight: '#e65100',
    iconColorDark: '#ff9800',
  },
];

const sideMenuGroups = [
  {
    title: '서버 서비스',
    items: [
      { Icon: DnsIcon, path: '/server-registration', label: '서버등록' },
    ],
  },
  {
    title: '구독서비스',
    items: [
      { Icon: LocalOfferIcon, path: '/subscription-plans', label: '서버구독 플랜' },
    ],
  },
  {
    title: '나의 서비스',
    items: [
      { Icon: ManageAccountsIcon, path: '/profile', label: '내 정보관리' },
      { Icon: TelegramIcon, path: '/telegram-settings', label: '텔레그램 설정' },
      { Icon: LockResetIcon, path: '/change-password', label: '비밀번호변경' },
    ],
  },
  {
    title: '프로그램 정보',
    items: [{ key: 'app-version', info: 'appVersion' }],
  },
];

const SIDEBAR_WIDTH = 180;
const APPBAR_HEIGHT = 64;

/** 서버 미등록 상태에서도 열리는 화면 (대시보드는 빈 상태로 보인다) */
const UNREGISTERED_OPEN_PATHS = [
  '/dashboard',
  '/server-registration',
  '/subscription-plans',
  '/profile',
  '/change-password',
];
const isOpenWhenUnregistered = (path) => UNREGISTERED_OPEN_PATHS.includes(path);

const Layout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { logout, agentRegistered, agentStatus } = useAuth();
  const { setThemeMode } = useThemeMode();
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const unregistered = agentRegistered === false;
  const isLocked = useCallback(
    (path) => unregistered && !isOpenWhenUnregistered(path),
    [unregistered]
  );

  useEffect(() => {
    if (isLocked(location.pathname)) navigate('/server-registration', { replace: true });
  }, [isLocked, location.pathname, navigate]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get('/settings/version')
      .then(({ data }) => {
        if (!cancelled) setAppVersion(data?.appVersion || '');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleThemeToggle = useCallback(() => {
    setThemeMode(isDark ? 'white' : 'dark').catch(() => {});
  }, [isDark, setThemeMode]);

  const handleMenuClick = useCallback((path) => {
    navigate(path);
  }, [navigate]);

  const handleLogoutClick = useCallback(() => {
    setLogoutDialogOpen(true);
  }, []);

  const handleLogoutConfirm = useCallback(() => {
    setLogoutDialogOpen(false);
    logout();
    navigate('/login');
  }, [logout, navigate]);

  const handleLogoutCancel = useCallback(() => {
    setLogoutDialogOpen(false);
  }, []);

  const isActive = useCallback((path) => location.pathname === path, [location.pathname]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <AppBar position="fixed" sx={{ width: '100%' }}>
        <Toolbar sx={{ justifyContent: 'space-between', gap: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="h5" component="div" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
              <CandlestickChartIcon sx={{ fontSize: '1.4rem' }} />
              PlanGo Agent
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
          {menuItems.map((item) => {
            const active = isActive(item.path);
            const iconColor = isDark
              ? item.iconColorDark
              : item.iconColorLight;
            return (
              <Tooltip
                key={item.path}
                title={isLocked(item.path) ? `${item.tooltip} (서버 등록 후 이용)` : item.tooltip}
                arrow
              >
                {/* disabled 버튼은 이벤트를 발생시키지 않아 Tooltip에 wrapper가 필요 */}
                <span>
                  <IconButton
                    color="inherit"
                    disabled={!!item.disabled || isLocked(item.path)}
                    onClick={() => handleMenuClick(item.path)}
                    sx={{
                      backgroundColor: active ? 'action.selected' : 'transparent',
                      color: iconColor || 'text.primary',
                      '&:hover': {
                        backgroundColor: 'action.hover',
                      },
                      '&.Mui-disabled': {
                        color: iconColor || 'text.primary',
                        opacity: 0.45,
                      },
                    }}
                  >
                    <item.Icon />
                  </IconButton>
                </span>
              </Tooltip>
            );
          })}
          <Tooltip title={isDark ? 'Light 모드로 전환' : 'Dark 모드로 전환'} arrow>
            <IconButton
              color="inherit"
              onClick={handleThemeToggle}
              sx={{
                color: 'text.primary',
                '&:hover': {
                  backgroundColor: 'action.hover',
                },
              }}
            >
              {isDark ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title="로그아웃" arrow>
            <IconButton
              color="inherit"
              onClick={handleLogoutClick}
              sx={{
                color: 'text.primary',
                '&:hover': {
                  backgroundColor: 'action.hover',
                },
              }}
            >
              <LogoutIcon />
            </IconButton>
          </Tooltip>
          </Box>
        </Toolbar>
      </AppBar>

      {/* 로그아웃 확인 다이얼로그 */}
      <Dialog
        open={logoutDialogOpen}
        onClose={handleLogoutCancel}
        aria-labelledby="logout-dialog-title"
        aria-describedby="logout-dialog-description"
      >
        <DialogTitle id="logout-dialog-title" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LogoutIcon color="primary" />
          로그아웃 확인
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="logout-dialog-description">
            정말 로그아웃 하시겠습니까?
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={handleLogoutCancel} color="primary">
            취소
          </Button>
          <Button onClick={handleLogoutConfirm} color="primary" variant="contained" autoFocus>
            로그아웃
          </Button>
        </DialogActions>
      </Dialog>
      <Box
        component="nav"
        sx={{
          position: 'fixed',
          top: APPBAR_HEIGHT,
          left: 0,
          bottom: 0,
          width: SIDEBAR_WIDTH,
          borderRight: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          overflowY: 'auto',
          zIndex: (t) => t.zIndex.appBar - 1,
        }}
      >
        {sideMenuGroups.map((group) => (
          <List
            key={group.title}
            dense
            sx={{ py: 0.5 }}
            subheader={
              <Typography
                variant="body2"
                sx={{ px: 2, pt: 1.5, pb: 0.75, color: 'text.secondary', fontWeight: 500 }}
              >
                {group.title}
              </Typography>
            }
          >
            {group.items.map((item) => item.info ? (
              <Box
                key={item.key}
                sx={{ mx: 1, px: 2, py: 0.75, display: 'flex', alignItems: 'center' }}
              >
                <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
                  {appVersion ? `v${appVersion}` : '-'}
                </Typography>
              </Box>
            ) : (
              <ListItemButton
                key={item.path}
                selected={isActive(item.path)}
                disabled={isLocked(item.path)}
                onClick={() => handleMenuClick(item.path)}
                sx={{
                  mx: 1,
                  borderRadius: 1.5,
                  '&.Mui-selected': {
                    bgcolor: isDark ? 'rgba(144, 202, 249, 0.16)' : 'rgba(25, 118, 210, 0.12)',
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 36, color: 'text.primary' }}>
                  <item.Icon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            ))}
          </List>
        ))}
      </Box>
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: 3,
          ml: `${SIDEBAR_WIDTH}px`,
          width: `calc(100% - ${SIDEBAR_WIDTH}px)`,
          mt: `${APPBAR_HEIGHT}px`,
          minHeight: `calc(100vh - ${APPBAR_HEIGHT}px)`,
          backgroundColor: 'background.default', // 테마의 배경색 사용
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box sx={{ flex: 1 }}>
          {unregistered && location.pathname !== '/server-registration' && (
            <Alert
              severity="warning"
              sx={{ mb: 2 }}
              action={
                <Button color="inherit" size="small" onClick={() => navigate('/server-registration')}>
                  서버 등록
                </Button>
              }
            >
              {agentStatus?.agentRevoked?.message
                ? `${agentStatus.agentRevoked.message} 서버 등록 후 이용할 수 있습니다.`
                : '이 서버는 아직 등록되지 않았습니다. 서버 등록 후 자동매매와 모든 기능을 이용할 수 있습니다.'}
            </Alert>
          )}
          <Outlet />
        </Box>
        <Footer />
      </Box>
    </Box>
  );
};

export default Layout;


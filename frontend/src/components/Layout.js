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
const SIDEBAR_GAP = 16;
const APPBAR_HEIGHT = 64;
/** 창을 이보다 좁히면 화면을 줄이지 않고 가로 스크롤 */
const MIN_PAGE_WIDTH = 1600;

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
    <Box sx={{ minWidth: MIN_PAGE_WIDTH, minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="sticky">
        <Toolbar sx={{ justifyContent: 'space-between', gap: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography
              variant="h5"
              component="div"
              role="button"
              tabIndex={0}
              title="대시보드"
              onClick={() => handleMenuClick('/dashboard')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleMenuClick('/dashboard');
                }
              }}
              sx={{
                fontWeight: 'bold',
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                cursor: 'pointer',
                userSelect: 'none',
                color: isDark ? undefined : '#1a7f37',
              }}
            >
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
        PaperProps={{ sx: { width: 520, maxWidth: 'calc(100% - 32px)' } }}
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
      <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
      <Box
        component="nav"
        sx={{
          position: 'sticky',
          top: APPBAR_HEIGHT + SIDEBAR_GAP,
          ml: `${SIDEBAR_GAP}px`,
          mt: `${SIDEBAR_GAP}px`,
          width: SIDEBAR_WIDTH,
          flexShrink: 0,
          maxHeight: `calc(100vh - ${APPBAR_HEIGHT + SIDEBAR_GAP * 2}px)`,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5,
          zIndex: (t) => t.zIndex.appBar - 1,
        }}
      >
        {[
          sideMenuGroups.filter((g) => !g.items.some((i) => i.info)),
          sideMenuGroups.filter((g) => g.items.some((i) => i.info)),
        ].map((cardGroups, cardIndex) => (
          <Box
            key={cardIndex}
            sx={{
              bgcolor: 'background.paper',
              border: 1,
              borderColor: 'divider',
              borderRadius: 1.5,
              overflow: 'hidden',
              boxShadow: isDark ? '0 2px 10px rgba(0,0,0,0.45)' : '0 2px 10px rgba(0,0,0,0.08)',
              flexShrink: 0,
            }}
          >
            {cardGroups.map((group) => (
              <List
                key={group.title}
                dense
                disablePadding
                sx={{ '&:last-of-type > :last-child': { borderBottom: 0 } }}
                subheader={
                  <Typography
                    sx={{
                      px: 1.5,
                      py: 0.75,
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      color: isDark ? 'text.secondary' : '#0969da',
                      bgcolor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.045)',
                      borderBottom: 1,
                      borderColor: 'divider',
                    }}
                  >
                    {group.title}
                  </Typography>
                }
              >
                {group.items.map((item) => item.info ? (
                  <Box
                    key={item.key}
                    sx={{ px: 1.5, py: 0.75, borderBottom: 1, borderColor: 'divider' }}
                  >
                    <Typography
                      variant="caption"
                      sx={{ display: 'block', textAlign: 'right', wordBreak: 'break-all' }}
                    >
                      {appVersion || '-'}
                    </Typography>
                  </Box>
                ) : (
                  <ListItemButton
                    key={item.path}
                    selected={isActive(item.path)}
                    disabled={isLocked(item.path)}
                    onClick={() => handleMenuClick(item.path)}
                    sx={{
                      px: 1.5,
                      py: 0.5,
                      borderBottom: 1,
                      borderColor: 'divider',
                      '&.Mui-selected, &.Mui-selected:hover': {
                        bgcolor: isDark ? 'rgba(144, 202, 249, 0.22)' : '#3a3a3a',
                        color: isDark ? 'text.primary' : '#fff',
                      },
                      '&.Mui-selected .MuiListItemIcon-root': {
                        color: isDark ? 'text.primary' : '#fff',
                      },
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 30, color: 'text.secondary' }}>
                      <item.Icon sx={{ fontSize: '1.05rem' }} />
                    </ListItemIcon>
                    <ListItemText
                      primary={item.label}
                      primaryTypographyProps={{ fontSize: '0.85rem', fontWeight: 400 }}
                    />
                  </ListItemButton>
                ))}
              </List>
            ))}
          </Box>
        ))}
      </Box>
      <Box
        component="main"
        sx={{
          flex: 1,
          minWidth: 0,
          p: 3,
          pt: `${SIDEBAR_GAP}px`,
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
    </Box>
  );
};

export default Layout;


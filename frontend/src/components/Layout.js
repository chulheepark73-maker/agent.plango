import React, { useCallback, useState } from 'react';
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
  useTheme,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import TuneIcon from '@mui/icons-material/Tune';
import SettingsIcon from '@mui/icons-material/Settings';
import LogoutIcon from '@mui/icons-material/Logout';
import CandlestickChartIcon from '@mui/icons-material/CandlestickChart';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import AssessmentIcon from '@mui/icons-material/Assessment';
import { useAuth } from '../contexts/AuthContext';

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
    tooltip: '나의 환경설정',
    iconColorLight: '#e65100',
    iconColorDark: '#ff9800',
  },
];

const Layout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { logout } = useAuth();
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);

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
              PlanGo.Today Agent Client
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
          {menuItems.map((item) => {
            const active = isActive(item.path);
            const iconColor = isDark
              ? item.iconColorDark
              : item.iconColorLight;
            return (
              <Tooltip key={item.path} title={item.tooltip} arrow>
                {/* disabled 버튼은 이벤트를 발생시키지 않아 Tooltip에 wrapper가 필요 */}
                <span>
                  <IconButton
                    color="inherit"
                    disabled={!!item.disabled}
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
        <DialogTitle id="logout-dialog-title">
          로그아웃 확인
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="logout-dialog-description">
            정말 로그아웃 하시겠습니까?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleLogoutCancel} color="primary">
            취소
          </Button>
          <Button onClick={handleLogoutConfirm} color="primary" variant="contained" autoFocus>
            로그아웃
          </Button>
        </DialogActions>
      </Dialog>
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: 3,
          width: '100%',
          mt: '64px', // AppBar 높이만큼 여백
          minHeight: 'calc(100vh - 64px)', // 전체 화면 높이
          backgroundColor: 'background.default', // 테마의 배경색 사용
        }}
      >
        <Outlet />
      </Box>
    </Box>
  );
};

export default Layout;


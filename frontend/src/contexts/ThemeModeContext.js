import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import apiClient from '../utils/axios';
import { useAuth } from './AuthContext';

const STORAGE_KEY = 'app_theme';

/** @typedef {'dark' | 'white'} AppThemeMode */

const ThemeModeContext = createContext(null);

export const useThemeMode = () => {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) {
    throw new Error('useThemeMode must be used within a ThemeModeProvider');
  }
  return ctx;
};

const normalizeMode = (value) => {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'white' || v === 'light') return 'white';
  return 'dark';
};

const readStoredMode = () => {
  try {
    return normalizeMode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'dark';
  }
};

/** 경고·오류 알림: 대시보드 오류 메시지와 같은 호박색 테두리 스타일로 통일 */
const noticeAlertOverrides = (isDark) => {
  const fg = isDark ? '#e3b341' : '#9a6700';
  const notice = {
    backgroundColor: isDark ? 'rgba(187, 128, 9, 0.12)' : 'rgba(154, 103, 0, 0.1)',
    color: fg,
    border: `1px solid ${isDark ? 'rgba(187, 128, 9, 0.35)' : 'rgba(154, 103, 0, 0.35)'}`,
    '& .MuiAlert-icon': { color: fg },
  };
  return { styleOverrides: { standardWarning: notice, standardError: notice } };
};

const createAppTheme = (mode) => {
  const isDark = mode !== 'white';

  if (isDark) {
    return createTheme({
      palette: {
        mode: 'dark',
        primary: { main: '#58a6ff' },
        secondary: { main: '#f778ba' },
        error: { main: '#ff7b72' },
        background: {
          default: '#081120',
          paper: '#101b2d',
        },
        divider: '#1e2d45',
        text: {
          primary: '#e6edf3',
          secondary: '#8b949e',
        },
        action: {
          hover: 'rgba(240, 246, 252, 0.08)',
          selected: 'rgba(240, 246, 252, 0.12)',
        },
      },
      typography: {
        h6: { fontSize: '1rem' },
      },
      shape: { borderRadius: 8 },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            body: {
              scrollbarColor: '#1e2d45 #081120',
            },
          },
        },
        MuiTextField: {
          defaultProps: { autoComplete: 'off' },
        },
        MuiPaper: {
          defaultProps: { elevation: 0 },
          styleOverrides: {
            root: { backgroundImage: 'none' },
          },
        },
        MuiAppBar: {
          defaultProps: {
            elevation: 0,
            color: 'inherit',
          },
          styleOverrides: {
            colorInherit: {
              backgroundColor: '#0d182a',
              color: '#e6edf3',
              borderBottom: '1px solid #1e2d45',
            },
          },
        },
        MuiTableCell: {
          styleOverrides: {
            root: { borderColor: '#1e2d45' },
          },
        },
        MuiAlert: noticeAlertOverrides(true),
      },
    });
  }

  return createTheme({
    palette: {
      mode: 'light',
      primary: { main: '#0969da' },
      secondary: { main: '#bf3989' },
      error: { main: '#cf222e' },
      background: {
        default: '#f6f8fa',
        paper: '#ffffff',
      },
      divider: '#d0d7de',
      text: {
        primary: '#1f2328',
        secondary: '#656d76',
      },
      action: {
        hover: 'rgba(31, 35, 40, 0.06)',
        selected: 'rgba(31, 35, 40, 0.08)',
      },
    },
    typography: {
      h6: { fontSize: '1rem' },
    },
    shape: { borderRadius: 8 },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            scrollbarColor: '#d0d7de #f6f8fa',
          },
        },
      },
      MuiTextField: {
        defaultProps: { autoComplete: 'off' },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: { backgroundImage: 'none' },
        },
      },
      MuiAppBar: {
        defaultProps: {
          elevation: 0,
          color: 'inherit',
        },
        styleOverrides: {
          colorInherit: {
            backgroundColor: '#ffffff',
            color: '#1f2328',
            borderBottom: '1px solid #d0d7de',
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { borderColor: '#d0d7de' },
        },
      },
      MuiAlert: noticeAlertOverrides(false),
    },
  });
};

export const ThemeModeProvider = ({ children }) => {
  const { token } = useAuth();
  const [themeMode, setThemeModeState] = useState(readStoredMode);

  const applyMode = useCallback((next) => {
    const mode = normalizeMode(next);
    setThemeModeState(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, []);

  // 로그인 후 user_settings.theme 로드
  useEffect(() => {
    if (!token) {
      applyMode(readStoredMode());
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await apiClient.get('/settings/user-settings');
        if (!cancelled && data?.theme != null) {
          applyMode(data.theme);
        }
      } catch (err) {
        console.warn('[ThemeMode] user-settings 조회 실패:', err.message || err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, applyMode]);

  const setThemeMode = useCallback(
    async (next) => {
      const mode = normalizeMode(next);
      applyMode(mode);
      if (!token) return mode;
      try {
        await apiClient.put('/settings/user-settings', { theme: mode });
      } catch (err) {
        console.error('[ThemeMode] theme 저장 실패:', err);
        throw err;
      }
      return mode;
    },
    [token, applyMode]
  );

  const muiTheme = useMemo(() => createAppTheme(themeMode), [themeMode]);

  const value = useMemo(
    () => ({
      themeMode,
      isDark: themeMode === 'dark',
      setThemeMode,
    }),
    [themeMode, setThemeMode]
  );

  return (
    <ThemeModeContext.Provider value={value}>
      <ThemeProvider theme={muiTheme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
};

import React, { useState, useEffect } from 'react';
import {
  Container,
  Typography,
  TextField,
  Button,
  Box,
  Alert,
  Card,
  CardContent,
  Divider,
  IconButton,
  InputAdornment,
  Grid,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  TableHead,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  FormControlLabel,
  Radio,
  RadioGroup,
} from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import DeleteIcon from '@mui/icons-material/Delete';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import AccountBoxIcon from '@mui/icons-material/AccountBox';
import PrivacyTipIcon from '@mui/icons-material/PrivacyTip';
import TelegramIcon from '@mui/icons-material/Telegram';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';
import CreditCardIcon from '@mui/icons-material/CreditCard';
import KeyIcon from '@mui/icons-material/Key';
import StarIcon from '@mui/icons-material/Star';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import UpdateIcon from '@mui/icons-material/Update';
import SavingsIcon from '@mui/icons-material/Savings';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import apiClient from '../utils/axios';
import { openCentral } from '../utils/central';
import { useAuth } from '../contexts/AuthContext';
import { useThemeMode } from '../contexts/ThemeModeContext';

const Settings = () => {
  const { user } = useAuth();
  const { themeMode, setThemeMode } = useThemeMode();
  const [settings, setSettings] = useState({
    kiwoomAppKey: '',
    kiwoomAppSecret: '',
    hasAppSecret: false,
    hasAccessToken: false,
    isTokenExpired: false,
    tokenStatus: 'none', // 'none', 'valid', 'expired'
    tokenExpiresAt: null,
    kiwoomAccountNo: '',
    buyFeeRate: 0.000125,
    sellFeeRate: 0.000125,
    sellTaxRate: 0.0018,
    usBuyFeeRate: 0,
    usSellFeeRate: 0,
    usSellTaxRate: 0,
    hasTelegramChatId: false,
    telegramDeepLinkReady: false,
    telegramLinkPending: false,
    theme: 'dark',
    groupName1: '제목없음',
    groupName2: '제목없음',
    groupName3: '제목없음',
    groupName4: '제목없음',
    groupName5: '제목없음',
    groupName6: '제목없음',
    groupName7: '제목없음',
    groupName8: '제목없음',
    planWeek: 0,
    planMonth: 0,
    planYear: 0,
    planUsWeek: 0,
    planUsMonth: 0,
    planUsYear: 0,
    appVersion: '',
  });
  const [showSecret, setShowSecret] = useState(false);
  const [telegramWaitingForChat, setTelegramWaitingForChat] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [stockUpdateResultDialog, setStockUpdateResultDialog] = useState({
    open: false,
    type: 'success',
    text: '',
  });

  // 계좌정보 관련 state
  const [accountInfo, setAccountInfo] = useState(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [accountErrorMessage, setAccountErrorMessage] = useState(null);
  const [holdingsError, setHoldingsError] = useState(null);

  // 미국 계좌/잔고
  const [usDeposit, setUsDeposit] = useState(null);
  const [usHoldings, setUsHoldings] = useState([]);
  const [usAccountLoading, setUsAccountLoading] = useState(true);
  const [usDepositError, setUsDepositError] = useState(null);
  const [usHoldingsError, setUsHoldingsError] = useState(null);

  const formatDateKo = (value) => {
    if (!value) return '-';
    return new Date(value)
      .toLocaleDateString('ko-KR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
      .replace(/\./g, '-')
      .replace(/\s/g, '')
      .replace(/-$/, '');
  };

  /** 남은일수: KST 오늘 날짜 ~ 만료일(날짜만) 일수 차이 */
  const getSubscriptionRemainingDays = (expiresAt) => {
    if (!expiresAt) return null;
    const toKstYmd = (value) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(value));
      const y = Number(parts.find((p) => p.type === 'year')?.value);
      const m = Number(parts.find((p) => p.type === 'month')?.value);
      const d = Number(parts.find((p) => p.type === 'day')?.value);
      return { y, m, d };
    };
    try {
      const today = toKstYmd(new Date());
      const end = toKstYmd(expiresAt);
      if (![today.y, today.m, today.d, end.y, end.m, end.d].every(Number.isFinite)) {
        return null;
      }
      const todayUtc = Date.UTC(today.y, today.m - 1, today.d);
      const endUtc = Date.UTC(end.y, end.m - 1, end.d);
      const days = Math.round((endUtc - todayUtc) / (1000 * 60 * 60 * 24));
      return Number.isFinite(days) ? days : null;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    fetchSettings();
    fetchAccountInfo();
    fetchUsAccountInfo();
  }, []);

  useEffect(() => {
    if (!telegramWaitingForChat) return undefined;

    const interval = setInterval(async () => {
      try {
        const response = await apiClient.get('/settings');
        setSettings(response.data);
        if (response.data.hasTelegramChatId) {
          setTelegramWaitingForChat(false);
          setMessage({
            type: 'success',
            text: '텔레그램 알림이 연결되었습니다.',
          });
        }
      } catch {
        /* 무시 */
      }
    }, 2000);

    const timeout = setTimeout(() => {
      setTelegramWaitingForChat(false);
    }, 120000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [telegramWaitingForChat]);

  const fetchSettings = async () => {
    try {
      const [response, userSettingsRes] = await Promise.all([
        apiClient.get('/settings'),
        apiClient.get('/settings/user-settings').catch(() => null),
      ]);
      console.log('[환경설정] 조회 성공:', {
        hasAppKey: !!response.data.kiwoomAppKey,
        hasAppSecret: response.data.hasAppSecret,
        hasAccessToken: response.data.hasAccessToken,
        isTokenExpired: response.data.isTokenExpired,
        tokenStatus: response.data.tokenStatus,
        tokenExpiresAt: response.data.tokenExpiresAt,
        hasTelegramChatId: response.data.hasTelegramChatId,
        telegramDeepLinkReady: response.data.telegramDeepLinkReady,
        telegramLinkPending: response.data.telegramLinkPending,
      });
      const userSettings = userSettingsRes?.data || {};
      const groupNames = {};
      for (let n = 1; n <= 8; n += 1) {
        const key = `groupName${n}`;
        groupNames[key] =
          userSettings[key] !== undefined && userSettings[key] !== null
            ? userSettings[key]
            : '제목없음';
      }
      const theme =
        userSettings.theme === 'white' || userSettings.theme === 'light'
          ? 'white'
          : 'dark';
      setSettings((prev) => ({
        ...prev,
        ...response.data,
        ...groupNames,
        theme,
      }));
    } catch (error) {
      console.error('환경설정 조회 실패:', error);
      setMessage({
        type: 'error',
        text: '환경설정을 불러오는데 실패했습니다.',
      });
    }
  };

  // 토큰 만료까지 남은 시간 계산
  const getTokenRemainingTime = () => {
    if (!settings.tokenExpiresAt) return null;
    
    const expiresAt = new Date(settings.tokenExpiresAt);
    const now = new Date();
    const diffMs = expiresAt - now;
    
    if (diffMs <= 0) return null;
    
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (diffHours > 0) {
      return `약 ${diffHours}시간 ${diffMinutes}분`;
    } else if (diffMinutes > 0) {
      return `약 ${diffMinutes}분`;
    } else {
      return '곧 만료됩니다';
    }
  };

  const handleAppKeyChange = (e) => {
    setSettings({ ...settings, kiwoomAppKey: e.target.value });
  };

  const handleAppSecretChange = (e) => {
    setSettings({ ...settings, kiwoomAppSecret: e.target.value });
  };

  const handleTelegramDeepLink = async () => {
    setLoading(true);
    setMessage({ type: '', text: '' });

    try {
      const { data } = await apiClient.post('/settings/telegram-deep-link');
      setSettings((prev) => ({
        ...prev,
        telegramLinkPending: true,
      }));
      setTelegramWaitingForChat(true);
      window.open(data.botUrl, '_blank', 'noopener,noreferrer');
      setMessage({
        type: 'success',
        text: '텔레그램이 열렸습니다. 봇 채팅에서「시작」을 눌러 연결을 완료하세요. (최대 약 2분간 연결 상태를 확인합니다)',
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.response?.data?.error ||
          '연결 링크를 만들 수 없습니다. 서버 텔레그램 설정을 확인하세요.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveCredentials = async () => {
    if (!settings.kiwoomAppKey) {
      setMessage({
        type: 'error',
        text: 'App Key를 입력해주세요.',
      });
      return;
    }
    
    // App Secret이 비어있고 기존에 저장된 것이 있다면 업데이트하지 않음
    if (!settings.kiwoomAppSecret && !settings.hasAppSecret) {
      setMessage({
        type: 'error',
        text: 'App Secret을 입력해주세요.',
      });
      return;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });

    try {
      // App Secret이 비어있으면 기존 값 유지 (서버에서 처리)
      const payload = {
        appKey: settings.kiwoomAppKey,
      };
      
      // App Secret이 입력된 경우에만 포함
      if (settings.kiwoomAppSecret && settings.kiwoomAppSecret !== '***') {
        payload.appSecret = settings.kiwoomAppSecret;
      }
      
      await apiClient.post('/settings/app-credentials', payload);

      setMessage({
        type: 'success',
        text: 'App Key/Secret이 저장되었습니다. 이제 토큰을 발급받을 수 있습니다.',
      });
      await fetchSettings();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '저장 중 오류가 발생했습니다.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateToken = async () => {
    setLoading(true);
    setMessage({ type: '', text: '' });

    try {
      const response = await apiClient.post('/settings/generate-token');
      setMessage({
        type: 'success',
        text: `토큰이 발급되었습니다. 만료일: ${new Date(response.data.expiresAt).toLocaleString('ko-KR')}`,
      });
      await fetchSettings();
    } catch (error) {
      console.error('토큰 발급 에러:', error);
      
      // 상세한 에러 메시지 구성
      let errorMessage = '토큰 발급 중 오류가 발생했습니다.';
      
      if (error.response?.data) {
        const errorData = error.response.data;
        errorMessage = errorData.error || errorData.message || errorMessage;
        
        // 추가 정보가 있으면 표시
        if (errorData.status) {
          errorMessage += ` (상태 코드: ${errorData.status})`;
        }
        
        // 키움증권 API 에러 정보가 있으면 표시
        if (errorData.data) {
          if (errorData.data.msg) {
            errorMessage = errorData.data.msg;
          } else if (errorData.data.msg1) {
            errorMessage = errorData.data.msg1;
          }
        }
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      setMessage({
        type: 'error',
        text: errorMessage,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteToken = async () => {
    if (!window.confirm('정말 토큰을 삭제하시겠습니까?')) {
      return;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });

    try {
      await apiClient.delete('/settings/token');
      setMessage({
        type: 'success',
        text: '토큰이 삭제되었습니다.',
      });
      await fetchSettings();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '토큰 삭제 중 오류가 발생했습니다.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveGroupNames = async () => {
    setLoading(true);
    setMessage({ type: '', text: '' });
    try {
      const payload = {};
      for (let n = 1; n <= 8; n += 1) {
        const key = `groupName${n}`;
        // JSON은 undefined를 생략하므로 항상 문자열로 전송
        payload[key] = String(settings[key] ?? '').trim() || '제목없음';
      }
      const response = await apiClient.post('/settings/user-settings/group-names', payload);
      const saved = {};
      for (let n = 1; n <= 8; n += 1) {
        const key = `groupName${n}`;
        if (response.data?.[key] !== undefined) saved[key] = response.data[key];
      }
      setSettings((prev) => ({ ...prev, ...saved }));
      setMessage({
        type: 'success',
        text: response.data?.message || 'KRX/US 관심종목 이름이 저장되었습니다.',
      });
      window.alert('KRX/US 관심종목 이름 저장 완료');
      await fetchSettings();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '관심종목 이름 저장 중 오류가 발생했습니다.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleThemeModeChange = async (event) => {
    const next = event.target.value === 'white' ? 'white' : 'dark';
    setSettings((prev) => ({ ...prev, theme: next }));
    setLoading(true);
    setMessage({ type: '', text: '' });
    try {
      await setThemeMode(next);
      setMessage({
        type: 'success',
        text:
          next === 'white'
            ? 'Light 모드로 저장되었습니다.'
            : 'Dark 모드로 저장되었습니다.',
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || '화면모드 저장 중 오류가 발생했습니다.',
      });
    } finally {
      setLoading(false);
    }
  };

  const formatAmountWithWon = (value) => {
    const num = Number(value || 0);
    return `${num.toLocaleString('ko-KR')} 원`;
  };

  const formatAmountWithUsd = (value) => {
    const num = Number(value || 0);
    return `$${num.toLocaleString('en-US')}`;
  };

  const handlePlanAmountChange = (field) => (e) => {
    const digits = String(e.target.value || '').replace(/[^0-9]/g, '');
    setSettings((prev) => ({
      ...prev,
      [field]: digits ? Number(digits) : 0,
    }));
  };

  const handleSaveKrPlanStatus = async () => {
    setLoading(true);
    setMessage({ type: '', text: '' });

    try {
      const response = await apiClient.post('/settings/plan-status', {
        week: settings.planWeek,
        month: settings.planMonth,
        year: settings.planYear,
      });

      setSettings((prev) => ({
        ...prev,
        planWeek: response.data.planWeek ?? prev.planWeek,
        planMonth: response.data.planMonth ?? prev.planMonth,
        planYear: response.data.planYear ?? prev.planYear,
        planUsWeek: response.data.planUsWeek ?? prev.planUsWeek,
        planUsMonth: response.data.planUsMonth ?? prev.planUsMonth,
        planUsYear: response.data.planUsYear ?? prev.planUsYear,
      }));
      setMessage({
        type: 'success',
        text: response.data.message || 'KR 수익 목표가 저장되었습니다.',
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || 'KR 수익 목표 저장 중 오류가 발생했습니다.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveUsPlanStatus = async () => {
    setLoading(true);
    setMessage({ type: '', text: '' });

    try {
      const response = await apiClient.post('/settings/plan-status', {
        usWeek: settings.planUsWeek,
        usMonth: settings.planUsMonth,
        usYear: settings.planUsYear,
      });

      setSettings((prev) => ({
        ...prev,
        planWeek: response.data.planWeek ?? prev.planWeek,
        planMonth: response.data.planMonth ?? prev.planMonth,
        planYear: response.data.planYear ?? prev.planYear,
        planUsWeek: response.data.planUsWeek ?? prev.planUsWeek,
        planUsMonth: response.data.planUsMonth ?? prev.planUsMonth,
        planUsYear: response.data.planUsYear ?? prev.planUsYear,
      }));
      setMessage({
        type: 'success',
        text: response.data.message || 'US 수익 목표가 저장되었습니다.',
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || 'US 수익 목표 저장 중 오류가 발생했습니다.',
      });
    } finally {
      setLoading(false);
    }
  };

  // 계좌정보 조회 함수 (평가잔고 kt00018 + 예수금 kt00001 + 보유종목 kt00004)
  const fetchAccountInfo = async () => {
    setAccountLoading(true);
    setAccountErrorMessage(null);
    try {
      const [accountSettled, depositSettled] = await Promise.allSettled([
        apiClient.get('/account/info'),
        apiClient.get('/account/deposit'),
      ]);

      if (accountSettled.status !== 'fulfilled') {
        const error = accountSettled.reason;
        if (error?.response?.status === 401) {
          setAccountErrorMessage('로그인이 필요합니다.');
        } else if (error?.response?.status === 400 && error?.response?.data?.error) {
          setAccountErrorMessage(error.response.data.error);
        } else {
          setAccountErrorMessage('계좌 정보를 불러오는 중 오류가 발생했습니다.');
        }
        setAccountInfo(null);
        return;
      }

      const depositData =
        depositSettled.status === 'fulfilled' ? depositSettled.value.data || null : null;
      if (depositSettled.status === 'rejected') {
        const err = depositSettled.reason;
        console.warn(
          '[KR 예수금] 조회 실패:',
          err?.response?.data?.error || err?.message || err
        );
      }

      let holdingsData = null;
      try {
        const holdingsResponse = await apiClient.get('/account/holdings');
        const rawData = holdingsResponse.data;
        if (rawData) {
          holdingsData = rawData.stk_acnt_evlt_prst ||
                        rawData.output ||
                        rawData.output1 ||
                        rawData.acnt_evlt_remn_indv_tot ||
                        rawData.stk_cntr_remn ||
                        rawData.data ||
                        rawData.holdings ||
                        (Array.isArray(rawData) ? rawData : null);
          
          if (Array.isArray(holdingsData)) {
            if (Array.isArray(holdingsData[0])) {
              holdingsData = holdingsData.flat();
            }
            holdingsData = holdingsData.filter(item => {
              if (!item || typeof item !== 'object') return false;
              const hasStockCode = item.stk_cd || item.pdno || item.itm_cd || item.stock_code || item.code || item.srtn_cd;
              const hasStockName = item.stk_nm || item.pdno_nm || item.itm_nm || item.prdt_name || item.stock_name || item.itm_nm_eng || item.prdt_nm || item.itm_nm_kor;
              return hasStockCode || hasStockName;
            });
          }
        }
      } catch (holdingsError) {
        if (holdingsError.response?.data?.error) {
          setHoldingsError(holdingsError.response.data.error);
        } else {
          setHoldingsError('보유 종목 조회에 실패했습니다.');
        }
      }

      const combinedData = {
        ...accountSettled.value.data,
        // kt00001: 예수금 / 주문가능금액
        entr: depositData?.entr,
        ord_alow_amt: depositData?.ord_alow_amt,
        pymn_alow_amt: depositData?.pymn_alow_amt,
        d2_entra: depositData?.d2_entra,
        krDeposit: depositData,
        holdings: holdingsData,
      };

      setAccountInfo(combinedData);
    } catch (error) {
      if (error.response?.status === 401) {
        setAccountErrorMessage('로그인이 필요합니다.');
      } else if (error.response?.status === 400 && error.response?.data?.error) {
        setAccountErrorMessage(error.response.data.error);
      } else {
        setAccountErrorMessage('계좌 정보를 불러오는 중 오류가 발생했습니다.');
      }
      setAccountInfo(null);
    } finally {
      setAccountLoading(false);
    }
  };

  const fetchUsAccountInfo = async () => {
    setUsAccountLoading(true);
    setUsDepositError(null);
    setUsHoldingsError(null);
    try {
      const [depositRes, holdingsRes] = await Promise.allSettled([
        apiClient.get('/account/us/deposit'),
        apiClient.get('/account/us/holdings'),
      ]);

      if (depositRes.status === 'fulfilled') {
        setUsDeposit(depositRes.value.data || null);
      } else {
        const err = depositRes.reason;
        setUsDeposit(null);
        setUsDepositError(
          err?.response?.data?.error || '미국주식 예수금 조회에 실패했습니다.'
        );
      }

      if (holdingsRes.status === 'fulfilled') {
        const raw = holdingsRes.value.data;
        let rows = [];
        if (Array.isArray(raw?.holdings)) {
          rows = raw.holdings;
        } else if (Array.isArray(raw)) {
          rows = raw;
        } else if (raw && typeof raw === 'object') {
          rows =
            raw.stk_acnt_evlt_prst ||
            raw.output ||
            raw.output1 ||
            raw.data ||
            [];
          if (!Array.isArray(rows)) rows = [];
        }
        rows = rows.filter((item) => {
          if (!item || typeof item !== 'object') return false;
          return (
            item.stk_cd ||
            item.frgn_stk_nm ||
            item.stk_nm ||
            item.symbol ||
            item.ticker ||
            item.jmcode ||
            item.pdno
          );
        });
        setUsHoldings(rows);
        // 예수금 응답에 요약이 없으면 원장 응답의 스칼라 필드를 보조로 사용
        if (depositRes.status !== 'fulfilled' && raw && typeof raw === 'object') {
          setUsDeposit((prev) => prev || raw);
        }
      } else {
        const err = holdingsRes.reason;
        setUsHoldings([]);
        setUsHoldingsError(
          err?.response?.data?.error || '미국주식 원장잔고 조회에 실패했습니다.'
        );
      }
    } catch (error) {
      setUsDeposit(null);
      setUsHoldings([]);
      setUsDepositError('미국 계좌 정보를 불러오는 중 오류가 발생했습니다.');
    } finally {
      setUsAccountLoading(false);
    }
  };

  const formatNumber = (value) => {
    if (!value && value !== 0) return '-';
    const numValue = typeof value === 'string' ? parseInt(value.replace(/^0+/, '') || '0') : parseInt(value || 0);
    return numValue.toLocaleString();
  };

  const formatUsMoney = (value) => {
    if (value === null || value === undefined || value === '') return '-';
    const n = parseFloat(String(value).replace(/[,$]/g, '').replace(/^\+/, ''));
    if (!Number.isFinite(n)) return String(value);
    const abs = Math.abs(n);
    const formatted = abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${n < 0 ? '-' : ''}$${formatted}`;
  };

  const formatUsQty = (value) => {
    if (value === null || value === undefined || value === '') return '-';
    const n = parseFloat(String(value).replace(/,/g, ''));
    if (!Number.isFinite(n)) return String(value);
    return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  };

  /** US 잔고정보 카드에 표시할 요약 필드 (응답 키 유연 매핑) */
  const getUsDepositSummaryRows = () => {
    const src = usDeposit || {};
    const pick = (...keys) => {
      for (const k of keys) {
        if (src[k] !== undefined && src[k] !== null && src[k] !== '') return src[k];
      }
      return undefined;
    };

    // 원장 보유에서 합계 보조 계산 (ust21070 필드)
    let sumPur = 0;
    let sumEvlt = 0;
    let sumPl = 0;
    let hasHoldingSums = false;
    for (const h of usHoldings) {
      const pur =
        parseFloat(
          String(
            h.frgn_stk_book_amt ?? h.pur_amt ?? h.pchs_amt ?? h.buy_amt ?? '0'
          ).replace(/,/g, '')
        ) || 0;
      const evlt =
        parseFloat(String(h.evlt_amt ?? h.evlu_amt ?? h.eval_amt ?? '0').replace(/,/g, '')) || 0;
      const pl =
        parseFloat(String(h.pl_amt ?? h.evlu_pfls_amt ?? h.pfls_amt ?? '0').replace(/,/g, '')) || 0;
      if (pur || evlt || pl) hasHoldingSums = true;
      sumPur += pur;
      sumEvlt += evlt;
      sumPl += pl;
    }
    const sumRt = sumPur > 0 ? ((sumPl / sumPur) * 100).toFixed(2) : undefined;

    const rows = [
      { label: '총매입금액', value: hasHoldingSums ? sumPur : pick('tot_pur_amt', 'tot_pchs_amt', 'pur_amt'), money: true },
      { label: '총평가금액', value: hasHoldingSums ? sumEvlt : pick('tot_evlt_amt', 'tot_evlu_amt', 'evlt_amt'), money: true },
      { label: '총평가손익', value: hasHoldingSums ? sumPl : pick('tot_evlt_pl', 'tot_evlu_pfls_amt', 'tot_pl_amt', 'pl_amt'), money: true, colored: true },
      { label: '수익률(%)', value: sumRt ?? pick('tot_prft_rt', 'tot_pfls_rt', 'prft_rt'), percent: true, colored: true },
    ].filter((r) => r.value !== undefined && r.value !== null && r.value !== '');

    // result_list: 통화별 상세 (ust21110) — 예수금·주문가능만 (평가금액은 원장 합계/총평가금액 사용)
    const list = Array.isArray(src.result_list) ? src.result_list : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const ccy = String(item.crnc_code || item.cur_cd || item.curr_cd || item.ccy || '').trim();
      const ccyNm = String(item.crnc_nm || '').trim();
      const labelBase = ccy || ccyNm || '외화';
      const extras = [
        { label: `${labelBase} 예수금`, value: item.fc_entra ?? item.frcr_amt ?? item.dpst ?? item.entra, money: true },
        { label: `${labelBase} 주문가능`, value: item.fc_ord_alowa ?? item.fc_pymn_alowa ?? item.ord_psbl_amt, money: true },
      ];
      for (const row of extras) {
        if (row.value === undefined || row.value === null || row.value === '') continue;
        if (rows.some((r) => r.label === row.label)) continue;
        rows.push(row);
      }
    }

    return rows;
  };

  const formatPercent = (value) => {
    if (!value && value !== 0) return '-';
    return `${parseFloat(value || 0).toFixed(2)}%`;
  };

  // 계좌정보 보유종목 데이터 처리
  const getHoldingsData = () => {
    if (!accountInfo) return null;
    
    let holdings = null;
    if (Array.isArray(accountInfo.holdings)) {
      holdings = accountInfo.holdings;
    } else if (accountInfo.holdings && typeof accountInfo.holdings === 'object') {
      holdings = accountInfo.holdings.stk_acnt_evlt_prst ||
                accountInfo.holdings.output ||
                accountInfo.holdings.output1 ||
                accountInfo.holdings.acnt_evlt_remn_indv_tot ||
                accountInfo.holdings.stk_cntr_remn ||
                accountInfo.holdings.data ||
                accountInfo.holdings.holdings;
    }
    if (!holdings) {
      holdings = accountInfo.stk_acnt_evlt_prst ||
                accountInfo.output ||
                accountInfo.output1 ||
                accountInfo.acnt_evlt_remn_indv_tot ||
                accountInfo.stk_cntr_remn ||
                accountInfo.data ||
                accountInfo.holdings;
    }
    
    if (!holdings) return null;
    
    let flatHoldings = [];
    if (Array.isArray(holdings)) {
      flatHoldings = holdings.flat();
      flatHoldings = flatHoldings.filter(item => {
        if (!item || typeof item !== 'object') return false;
        const hasStockCode = item.stk_cd || item.pdno || item.itm_cd || item.stock_code || item.code || item.srtn_cd;
        const hasStockName = item.stk_nm || item.pdno_nm || item.itm_nm || item.prdt_name || item.stock_name || item.itm_nm_eng || item.prdt_nm || item.itm_nm_kor;
        return hasStockCode || hasStockName;
      });
    } else if (typeof holdings === 'object' && holdings !== null) {
      const hasStockCode = holdings.stk_cd || holdings.pdno || holdings.itm_cd || holdings.stock_code || holdings.code || holdings.srtn_cd;
      const hasStockName = holdings.stk_nm || holdings.pdno_nm || holdings.itm_nm || holdings.prdt_name || holdings.stock_name || holdings.itm_nm_eng || holdings.prdt_nm || holdings.itm_nm_kor;
      if (hasStockCode || hasStockName) {
        flatHoldings = [holdings];
      } else {
        const values = Object.values(holdings);
        flatHoldings = values.filter(item => {
          if (!item || typeof item !== 'object') return false;
          const hasCode = item.stk_cd || item.pdno || item.itm_cd || item.stock_code || item.code || item.srtn_cd;
          const hasName = item.stk_nm || item.pdno_nm || item.itm_nm || item.prdt_name || item.stock_name || item.itm_nm_eng || item.prdt_nm || item.itm_nm_kor;
          return hasCode || hasName;
        });
      }
    }
    
    return flatHoldings.length > 0 ? flatHoldings : null;
  };

  return (
    <Container maxWidth="xl">
      {message.text && (
        <Alert
          severity={message.type === 'error' ? 'error' : 'success'}
          sx={{ mb: 3 }}
          onClose={() => setMessage({ type: '', text: '' })}
        >
          {message.text}
        </Alert>
      )}

      <Grid container spacing={2}>
        {/* 왼쪽: 계좌정보 (6) */}
        <Grid item xs={12} md={7}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* 잔고정보 테이블 */}
            <Paper sx={{ p: 3 }}>
              <Typography
                variant="h6"
                sx={{ fontWeight: 'bold', mb: 2, display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
              >
                <AccountBalanceWalletIcon sx={{ fontSize: '1.05rem' }} />
                KR 잔고정보
              </Typography>

              {accountErrorMessage && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  {accountErrorMessage}
                </Alert>
              )}

              {accountLoading ? (
                <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
                  <CircularProgress />
                </Box>
              ) : accountInfo ? (
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow sx={{ bgcolor: 'action.hover' }}>
                        {accountInfo.tot_pur_amt !== undefined && (
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            총매입금액
                          </TableCell>
                        )}
                        {accountInfo.tot_evlt_amt !== undefined && (
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            총평가금액
                          </TableCell>
                        )}
                        {accountInfo.tot_evlt_pl !== undefined && (
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            총평가손익
                          </TableCell>
                        )}
                        {accountInfo.tot_prft_rt !== undefined && (
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            수익률(%)
                          </TableCell>
                        )}
                        {accountInfo.entr !== undefined && accountInfo.entr !== null && (
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            예수금
                          </TableCell>
                        )}
                        {accountInfo.prsm_dpst_aset_amt !== undefined && (
                          <TableCell align="center" sx={{ fontWeight: 'bold' }}>
                            추정자산
                          </TableCell>
                        )}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      <TableRow>
                        {accountInfo.tot_pur_amt !== undefined && (
                          <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                            {formatNumber(accountInfo.tot_pur_amt)}
                          </TableCell>
                        )}
                        {accountInfo.tot_evlt_amt !== undefined && (
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            {formatNumber(accountInfo.tot_evlt_amt)}
                          </TableCell>
                        )}
                        {accountInfo.tot_evlt_pl !== undefined && (
                          <TableCell 
                            align="center" 
                            sx={{ 
                              color: parseInt(accountInfo.tot_evlt_pl || 0) >= 0 ? '#d32f2f' : '#1976d2',
                              fontWeight: 'bold',
                              borderRight: '1px solid', 
                              borderColor: 'divider'
                            }}
                          >
                            {formatNumber(accountInfo.tot_evlt_pl)}
                          </TableCell>
                        )}
                        {accountInfo.tot_prft_rt !== undefined && (
                          <TableCell 
                            align="center" 
                            sx={{ 
                              color: parseFloat(accountInfo.tot_prft_rt || 0) >= 0 ? '#d32f2f' : '#1976d2',
                              fontWeight: 'bold',
                              borderRight: '1px solid', 
                              borderColor: 'divider'
                            }}
                          >
                            {formatPercent(accountInfo.tot_prft_rt)}
                          </TableCell>
                        )}
                        {accountInfo.entr !== undefined && accountInfo.entr !== null && (
                          <TableCell align="center" sx={{ fontWeight: 'bold', color: 'primary.main', borderRight: '1px solid', borderColor: 'divider' }}>
                            {formatNumber(accountInfo.entr)}
                          </TableCell>
                        )}
                        {accountInfo.prsm_dpst_aset_amt !== undefined && (
                          <TableCell align="center" sx={{ fontWeight: 'bold', color: 'primary.main' }}>
                            {formatNumber(accountInfo.prsm_dpst_aset_amt)}
                          </TableCell>
                        )}
                      </TableRow>
                    </TableBody>
                  </Table>
                </TableContainer>
              ) : (
                <Typography color="error">
                  계좌 정보를 불러올 수 없습니다.
                </Typography>
              )}
            </Paper>

            {/* 계좌정보 테이블 */}
            <Paper sx={{ p: 3 }}>
              <Typography
                variant="h6"
                sx={{ fontWeight: 'bold', mb: 2, display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
              >
                <AccountBoxIcon sx={{ fontSize: '1.05rem' }} />
                KR 계좌정보
              </Typography>

              {holdingsError && (
                <Alert severity="info" sx={{ mb: 2 }} onClose={() => setHoldingsError(null)}>
                  보유 종목 조회: {holdingsError}
                </Alert>
              )}

              {accountLoading ? (
                <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
                  <CircularProgress />
                </Box>
              ) : (() => {
                const flatHoldings = getHoldingsData();
                if (!flatHoldings) {
                  return (
                    <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 3 }}>
                      보유 종목이 없습니다.
                    </Typography>
                  );
                }

                return (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow sx={{ bgcolor: 'action.hover' }}>
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            종목명
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            수량
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            매입가
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            현재가
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            평가손익
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            수익률
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                            매입금액
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold' }}>
                            평가금액
                          </TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {flatHoldings.map((holding, index) => {
                          const stockCode = holding.stk_cd || holding.pdno || holding.itm_cd || holding.stock_code || holding.code || holding.srtn_cd || '';
                          const stockName = holding.stk_nm || holding.itm_nm || holding.pdno_nm || holding.prdt_name || holding.stock_name || holding.itm_nm_eng || holding.prdt_nm || holding.itm_nm_kor || stockCode || '-';
                          const quantity = holding.rmnd_qty || holding.hldg_qty || holding.qty || holding.quantity || holding.ord_qty || holding.hldg_qty_remn || 0;
                          const purchasePrice = holding.avg_prc || holding.pchs_avg_pric || holding.purchase_price || holding.avg_pric || holding.pchs_avg_pric_remn || 0;
                          const currentPrice = holding.cur_prc || holding.prpr || holding.current_price || holding.now_prc || holding.prc || holding.prpr_remn || 0;
                          const profitLoss = holding.pl_amt || holding.evlu_pfls_amt || holding.profit_loss || holding.evlu_pfls || holding.pfls_amt || holding.evlu_pfls_amt_remn || 0;
                          const profitRate = holding.pl_rt || holding.evlu_pfls_rt || holding.profit_rate || holding.pfls_rt || holding.rate || holding.evlu_pfls_rt_remn || 0;
                          const purchaseAmount = holding.pur_amt || holding.pchs_amt || holding.purchase_amount || holding.buy_amt || holding.pchs_amt_remn || 0;
                          const evaluationAmount = holding.evlt_amt || holding.evlu_amt || holding.evaluation_amount || holding.eval_amt || holding.evlu_amt_remn || 0;
                          
                          return (
                            <TableRow key={index} hover>
                              <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                                <Box>
                                  <Typography variant="body2">{stockName}</Typography>
                                  {stockCode && stockCode !== stockName && (
                                    <Typography variant="caption" color="text.secondary">
                                      ({stockCode})
                                    </Typography>
                                  )}
                                </Box>
                              </TableCell>
                              <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                                {formatNumber(quantity)}
                              </TableCell>
                              <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                                {formatNumber(purchasePrice)}
                              </TableCell>
                              <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                                {formatNumber(currentPrice)}
                              </TableCell>
                              <TableCell 
                                align="center" 
                                sx={{ 
                                  borderRight: '1px solid', 
                                  borderColor: 'divider',
                                  color: parseFloat(profitLoss || 0) >= 0 ? '#d32f2f' : '#1976d2',
                                  fontWeight: 'bold'
                                }}
                              >
                                {formatNumber(profitLoss)}
                              </TableCell>
                              <TableCell 
                                align="center" 
                                sx={{ 
                                  borderRight: '1px solid', 
                                  borderColor: 'divider',
                                  color: parseFloat(profitRate || 0) >= 0 ? '#d32f2f' : '#1976d2',
                                  fontWeight: 'bold'
                                }}
                              >
                                {formatPercent(profitRate)}
                              </TableCell>
                              <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                                {formatNumber(purchaseAmount)}
                              </TableCell>
                              <TableCell align="center">
                                {formatNumber(evaluationAmount)}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </TableContainer>
                );
              })()}
            </Paper>

            {/* US 잔고정보 */}
            <Paper sx={{ p: 3 }}>
              <Typography
                variant="h6"
                sx={{
                  fontWeight: 'bold',
                  mb: 2,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.75,
                  color: '#C9A227',
                }}
              >
                <AccountBalanceWalletIcon sx={{ fontSize: '1.05rem' }} />
                US 잔고정보
              </Typography>

              {usDepositError && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  {usDepositError}
                </Alert>
              )}

              {usAccountLoading ? (
                <Box display="flex" justifyContent="center" alignItems="center" minHeight="120px">
                  <CircularProgress />
                </Box>
              ) : (() => {
                const summaryRows = getUsDepositSummaryRows();
                if (!summaryRows.length) {
                  return (
                    <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 2 }}>
                      미국주식 잔고 정보가 없습니다.
                    </Typography>
                  );
                }
                return (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow sx={{ bgcolor: 'action.hover' }}>
                          {summaryRows.map((row, idx) => (
                            <TableCell
                              key={row.label}
                              align="center"
                              sx={{
                                fontWeight: 'bold',
                                borderRight: idx < summaryRows.length - 1 ? '1px solid' : undefined,
                                borderColor: 'divider',
                              }}
                            >
                              {row.label}
                            </TableCell>
                          ))}
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        <TableRow>
                          {summaryRows.map((row, idx) => {
                            const num = parseFloat(String(row.value).replace(/[,$%]/g, '')) || 0;
                            let display = '-';
                            if (row.percent) display = formatPercent(row.value);
                            else if (row.krw) display = formatNumber(row.value);
                            else if (row.money) display = formatUsMoney(row.value);
                            else display = String(row.value);
                            return (
                              <TableCell
                                key={row.label}
                                align="center"
                                sx={{
                                  fontWeight: row.colored || row.money ? 'bold' : undefined,
                                  color: row.colored
                                    ? num >= 0
                                      ? '#d32f2f'
                                      : '#1976d2'
                                    : row.label === '외화예수금' || row.label === '주문가능금액'
                                      ? 'primary.main'
                                      : undefined,
                                  borderRight: idx < summaryRows.length - 1 ? '1px solid' : undefined,
                                  borderColor: 'divider',
                                }}
                              >
                                {display}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      </TableBody>
                    </Table>
                  </TableContainer>
                );
              })()}
            </Paper>

            {/* US 계좌정보 */}
            <Paper sx={{ p: 3 }}>
              <Typography
                variant="h6"
                sx={{
                  fontWeight: 'bold',
                  mb: 2,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.75,
                  color: '#C9A227',
                }}
              >
                <AccountBoxIcon sx={{ fontSize: '1.05rem' }} />
                US 계좌정보
              </Typography>

              {usHoldingsError && (
                <Alert severity="info" sx={{ mb: 2 }} onClose={() => setUsHoldingsError(null)}>
                  미국 보유 종목 조회: {usHoldingsError}
                </Alert>
              )}

              {usAccountLoading ? (
                <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
                  <CircularProgress />
                </Box>
              ) : usHoldings.length === 0 ? (
                <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 3 }}>
                  미국주식 보유 종목이 없습니다.
                </Typography>
              ) : (
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow sx={{ bgcolor: 'action.hover' }}>
                        <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                          종목명
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                          수량
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                          매입가
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                          현재가
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                          평가손익
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                          수익률
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', borderRight: '1px solid', borderColor: 'divider' }}>
                          매입금액
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold' }}>
                          평가금액
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {usHoldings.map((holding, index) => {
                        const stockCode =
                          holding.stk_cd ||
                          holding.symbol ||
                          holding.ticker ||
                          holding.jmcode ||
                          holding.pdno ||
                          holding.itm_cd ||
                          '';
                        const stockName =
                          holding.frgn_stk_nm ||
                          holding.stk_nm ||
                          holding.itm_nm ||
                          holding.pdno_nm ||
                          holding.prdt_name ||
                          holding.stock_name ||
                          stockCode ||
                          '-';
                        const quantity =
                          holding.poss_qty ||
                          holding.qty ||
                          holding.rmnd_qty ||
                          holding.hldg_qty ||
                          holding.quantity ||
                          holding.ord_qty ||
                          0;
                        const purchasePrice =
                          holding.frgn_stk_book_uv ||
                          holding.avg_prc ||
                          holding.pchs_avg_pric ||
                          holding.purchase_price ||
                          holding.avg_pric ||
                          holding.pur_uv ||
                          0;
                        const currentPrice =
                          holding.now_pric ||
                          holding.now_prc ||
                          holding.cur_prc ||
                          holding.prpr ||
                          holding.current_price ||
                          holding.prc ||
                          0;
                        const profitLoss =
                          holding.pl_amt ||
                          holding.evlu_pfls_amt ||
                          holding.profit_loss ||
                          holding.evlu_pfls ||
                          holding.pfls_amt ||
                          0;
                        const profitRate =
                          holding.pl_rt ||
                          holding.evlu_pfls_rt ||
                          holding.profit_rate ||
                          holding.pfls_rt ||
                          holding.rate ||
                          0;
                        const purchaseAmount =
                          holding.frgn_stk_book_amt ||
                          holding.pur_amt ||
                          holding.pchs_amt ||
                          holding.purchase_amount ||
                          holding.buy_amt ||
                          0;
                        const evaluationAmount =
                          holding.evlt_amt ||
                          holding.evlu_amt ||
                          holding.evaluation_amount ||
                          holding.eval_amt ||
                          0;
                        const plNum = parseFloat(String(profitLoss).replace(/,/g, '')) || 0;
                        const rtNum = parseFloat(String(profitRate).replace(/,/g, '')) || 0;

                        return (
                          <TableRow key={`${stockCode}-${index}`} hover>
                            <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                              <Box>
                                <Typography variant="body2">{stockName}</Typography>
                                {stockCode && stockCode !== stockName && (
                                  <Typography variant="caption" color="text.secondary">
                                    ({stockCode})
                                  </Typography>
                                )}
                              </Box>
                            </TableCell>
                            <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                              {formatUsQty(quantity)}
                            </TableCell>
                            <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                              {formatUsMoney(purchasePrice)}
                            </TableCell>
                            <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                              {formatUsMoney(currentPrice)}
                            </TableCell>
                            <TableCell
                              align="center"
                              sx={{
                                borderRight: '1px solid',
                                borderColor: 'divider',
                                color: plNum >= 0 ? '#d32f2f' : '#1976d2',
                                fontWeight: 'bold',
                              }}
                            >
                              {formatUsMoney(profitLoss)}
                            </TableCell>
                            <TableCell
                              align="center"
                              sx={{
                                borderRight: '1px solid',
                                borderColor: 'divider',
                                color: rtNum >= 0 ? '#d32f2f' : '#1976d2',
                                fontWeight: 'bold',
                              }}
                            >
                              {formatPercent(profitRate)}
                            </TableCell>
                            <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                              {formatUsMoney(purchaseAmount)}
                            </TableCell>
                            <TableCell align="center">{formatUsMoney(evaluationAmount)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Paper>

            {/* KR 주간/월간/년간 수익 목표설정 */}
            <Paper sx={{ p: 3 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 1,
                  mb: 2,
                  minWidth: 0,
                }}
              >
                <Typography
                  variant="h6"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, m: 0 }}
                >
                  <SavingsIcon sx={{ fontSize: '1.05rem' }} />
                  KR 주간/월간/년간 수익 목표설정
                </Typography>
                <Typography component="span" variant="body2" color="text.secondary">
                  예: 12,000,000 원 형식으로 입력 가능하며 숫자로 저장됩니다.
                </Typography>
              </Box>

              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' },
                  gap: 2,
                }}
              >
                <TextField
                  fullWidth
                  margin="normal"
                  label="주간 목표금액"
                  value={formatAmountWithWon(settings.planWeek)}
                  onChange={handlePlanAmountChange('planWeek')}
                  placeholder="예: 12,000,000 원"
                />
                <TextField
                  fullWidth
                  margin="normal"
                  label="월간 목표금액"
                  value={formatAmountWithWon(settings.planMonth)}
                  onChange={handlePlanAmountChange('planMonth')}
                  placeholder="예: 12,000,000 원"
                />
                <TextField
                  fullWidth
                  margin="normal"
                  label="년간 목표금액"
                  value={formatAmountWithWon(settings.planYear)}
                  onChange={handlePlanAmountChange('planYear')}
                  placeholder="예: 12,000,000 원"
                />
              </Box>

              <Button
                variant="contained"
                onClick={handleSaveKrPlanStatus}
                disabled={loading}
                sx={{ mt: 2 }}
              >
                저장
              </Button>
            </Paper>

            {/* US 주간/월간/년간 수익 목표설정 */}
            <Paper sx={{ p: 3 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 1,
                  mb: 2,
                  minWidth: 0,
                }}
              >
                <Typography
                  variant="h6"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, m: 0 }}
                >
                  <SavingsIcon sx={{ fontSize: '1.05rem' }} />
                  US 주간/월간/년간 수익 목표설정
                </Typography>
                <Typography component="span" variant="body2" color="text.secondary">
                  예: $12,000 형식으로 입력 가능하며 숫자로 저장됩니다.
                </Typography>
              </Box>

              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' },
                  gap: 2,
                }}
              >
                <TextField
                  fullWidth
                  margin="normal"
                  label="주간 목표금액"
                  value={formatAmountWithUsd(settings.planUsWeek)}
                  onChange={handlePlanAmountChange('planUsWeek')}
                  placeholder="예: $12,000"
                />
                <TextField
                  fullWidth
                  margin="normal"
                  label="월간 목표금액"
                  value={formatAmountWithUsd(settings.planUsMonth)}
                  onChange={handlePlanAmountChange('planUsMonth')}
                  placeholder="예: $12,000"
                />
                <TextField
                  fullWidth
                  margin="normal"
                  label="년간 목표금액"
                  value={formatAmountWithUsd(settings.planUsYear)}
                  onChange={handlePlanAmountChange('planUsYear')}
                  placeholder="예: $12,000"
                />
              </Box>

              <Button
                variant="contained"
                onClick={handleSaveUsPlanStatus}
                disabled={loading}
                sx={{ mt: 2 }}
              >
                저장
              </Button>
            </Paper>

            {/* 개인정보 테이블 */}
            <Paper sx={{ p: 3 }}>
              <Typography
                variant="h6"
                sx={{ fontWeight: 'bold', mb: 2, display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
              >
                <PrivacyTipIcon sx={{ fontSize: '1.05rem' }} />
                개인정보
              </Typography>

              {user ? (
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3 }}>
                  {/* 왼쪽: 회원 등급 배지 */}
                  <Box
                    sx={{
                      width: 80,
                      height: 80,
                      borderRadius: '50%',
                      backgroundColor: user?.subscription === 'Y' ? 'error.main' : 'primary.main',
                      color: 'white',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      fontWeight: 'bold',
                      fontSize: '1rem',
                    }}
                  >
                    {user?.subscription === 'Y'
                      ? (user?.subscriptionPlanName || '구독회원')
                      : '일반회원'}
                  </Box>

                  {/* 오른쪽: 개인정보 목록 */}
                  <Box sx={{ flex: 1 }}>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <Typography component="span" sx={{ fontSize: '0.875rem', color: 'text.primary' }}>•</Typography>
                        <Typography sx={{ fontWeight: 'bold', minWidth: '90px', color: 'text.secondary', fontSize: '0.875rem' }}>
                          이메일주소:
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                          <Typography sx={{ fontSize: '0.875rem' }}>
                            {user.email || '-'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>                            
                          </Typography>
                        </Box>
                      </Box>
                      
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <Typography component="span" sx={{ fontSize: '0.875rem', color: 'text.primary' }}>•</Typography>
                        <Typography sx={{ fontWeight: 'bold', minWidth: '90px', color: 'text.secondary', fontSize: '0.875rem' }}>
                          이름:
                        </Typography>
                        <Typography sx={{ fontSize: '0.875rem' }}>
                          {user.username || user.id || '-'}
                        </Typography>
                      </Box>
                      
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <Typography component="span" sx={{ fontSize: '0.875rem', color: 'text.primary' }}>•</Typography>
                        <Typography sx={{ fontWeight: 'bold', minWidth: '90px', color: 'text.secondary', fontSize: '0.875rem' }}>
                          회원가입일:
                        </Typography>
                        <Typography sx={{ fontSize: '0.875rem' }}>
                          {user.createdAt 
                            ? new Date(user.createdAt).toLocaleDateString('ko-KR', {
                                year: 'numeric',
                                month: '2-digit',
                                day: '2-digit'
                              }).replace(/\./g, '-').replace(/\s/g, '').replace(/-$/, '')
                            : '-'}
                        </Typography>
                      </Box>
                      
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                        <Typography component="span" sx={{ fontSize: '0.875rem', color: 'text.primary' }}>•</Typography>
                        <Typography sx={{ fontWeight: 'bold', minWidth: '90px', color: 'text.secondary', fontSize: '0.875rem' }}>
                          휴대폰번호:
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1 }}>
                          <Typography sx={{ fontSize: '0.875rem' }}>
                            {user.phoneNumber 
                              ? (() => {
                                  const phone = user.phoneNumber.replace(/[-\s]/g, '');
                                  if (phone.length === 11) {
                                    return `${phone.substring(0, 3)}-${phone.substring(3, 7).replace(/\d/g, '*')}-${phone.substring(7)}`;
                                  }
                                  return phone;
                                })()
                              : '-'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
                            (SMS수신)
                          </Typography>
                          <Box sx={{ display: 'flex', gap: 1, ml: 'auto' }}>
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={() => openCentral('/settings')}
                              sx={{ fontSize: '0.75rem', py: 0.25, px: 1 }}
                            >
                              개인정보 변경
                            </Button>
                          </Box>
                        </Box>
                      </Box>
                    </Box>
                  </Box>
                </Box>
              ) : (
                <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 3 }}>
                  사용자 정보를 불러올 수 없습니다.
                </Typography>
              )}
            </Paper>

            {/* 구독관리 테이블 */}
            <Paper sx={{ p: 3 }}>
              <Typography
                variant="h6"
                sx={{ fontWeight: 'bold', mb: 2, display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
              >
                <WorkspacePremiumIcon sx={{ fontSize: '1.05rem' }} />
                구독플랜
              </Typography>

              {user ? (
                <>
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow sx={{ bgcolor: 'action.hover' }}>
                          <TableCell align="center" sx={{ fontWeight: 'bold', fontSize: '0.875rem', borderRight: '1px solid', borderColor: 'divider' }}>
                            현재 상태
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', fontSize: '0.875rem', borderRight: '1px solid', borderColor: 'divider' }}>
                            플랜명
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', fontSize: '0.875rem', borderRight: '1px solid', borderColor: 'divider' }}>
                            플랜시작일
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', fontSize: '0.875rem', borderRight: '1px solid', borderColor: 'divider' }}>
                            플랜만료일
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', fontSize: '0.875rem' }}>
                            남은일수
                          </TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        <TableRow>
                          <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                            <Typography
                              sx={{
                                fontSize: '0.875rem',
                                color: user?.subscription === 'Y'
                                  ? 'success.main'
                                  : user?.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) < new Date()
                                  ? 'error.main'
                                  : 'text.secondary',
                                fontWeight: 'bold'
                              }}
                            >
                              {user?.subscription === 'Y'
                                ? '구독중'
                                : user?.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) < new Date()
                                ? '만료됨'
                                : '무료'}
                            </Typography>
                          </TableCell>
                          <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                            <Typography sx={{ fontSize: '0.875rem' }}>
                              {user?.subscription === 'Y'
                                ? `${user?.subscriptionPlanName || '프리미엄'}${user?.subscriptionCycle ? ` (${user.subscriptionCycle})` : ''}`
                                : (user?.subscriptionPlanName || '무료')}
                            </Typography>
                          </TableCell>
                          <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                            <Typography sx={{ fontSize: '0.875rem' }}>
                              {formatDateKo(user?.subscriptionStartedAt)}
                            </Typography>
                          </TableCell>
                          <TableCell align="center" sx={{ borderRight: '1px solid', borderColor: 'divider' }}>
                            <Typography sx={{ fontSize: '0.875rem' }}>
                              {formatDateKo(user?.subscriptionExpiresAt)}
                            </Typography>
                          </TableCell>
                          <TableCell align="center">
                            {(() => {
                              const remainingDays =
                                user?.subscription === 'Y'
                                  ? getSubscriptionRemainingDays(user?.subscriptionExpiresAt)
                                  : null;
                              return (
                                <Typography
                                  sx={{
                                    fontSize: '0.875rem',
                                    fontWeight: remainingDays != null ? 'bold' : 'normal',
                                    color:
                                      remainingDays == null
                                        ? 'text.secondary'
                                        : remainingDays <= 3
                                          ? 'error.main'
                                          : remainingDays <= 7
                                            ? 'warning.main'
                                            : 'text.primary',
                                  }}
                                >
                                  {remainingDays == null
                                    ? '-'
                                    : `${Math.max(0, remainingDays)}일`}
                                </Typography>
                              );
                            })()}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => openCentral('/settings')}
                      sx={{ fontSize: '0.75rem', py: 0.25, px: 1 }}
                    >
                      구독플랜 변경
                    </Button>
                  </Box>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 3 }}>
                  사용자 정보를 불러올 수 없습니다.
                </Typography>
              )}
            </Paper>

            {/* 알림 기능 설정 (텔레그램) */}
            <Paper sx={{ p: 3 }}>
              <Box
                display="flex"
                alignItems="center"
                flexWrap="wrap"
                gap={1}
                sx={{ mb: 2 }}
              >
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
              {!settings.telegramDeepLinkReady && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  서버에 <code>TELEGRAM_BOT_TOKEN</code>과 <code>TELEGRAM_BOT_USERNAME</code>이 설정되어 있어야 합니다.
                  프로덕션에서는 웹훅(<code>/api/telegram/webhook</code>)으로, 로컬 개발 시에는{' '}
                  <code>TELEGRAM_USE_POLLING=true</code>로 공용 봇 메시지를 받을 수 있습니다.
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
              <Box sx={{ mb: 3 }}>
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleTelegramDeepLink}
                  disabled={
                    loading ||
                    !settings.telegramDeepLinkReady ||
                    settings.hasTelegramChatId
                  }
                  size="medium"
                >
                  텔레그램 봇으로 연결
                </Button>
                {telegramWaitingForChat && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    봇에서 시작을 누른 뒤 잠시만 기다려 주세요…
                  </Typography>
                )}
              </Box>
            </Paper>

            {/* 버전 정보 */}
            <Paper sx={{ p: 3 }}>
              <Typography
                variant="h6"
                sx={{ fontWeight: 'bold', mb: 2, display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
              >
                <UpdateIcon sx={{ fontSize: '1.05rem' }} />
                버전 정보
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography component="span" sx={{ fontSize: '0.875rem', color: 'text.primary' }}>•</Typography>
                <Typography sx={{ fontWeight: 'bold', minWidth: '90px', color: 'text.secondary', fontSize: '0.875rem' }}>
                  웹 버전:
                </Typography>
                <Typography sx={{ fontSize: '0.875rem' }}>
                  {settings.appVersion ? `v${settings.appVersion}` : '-'}
                </Typography>
              </Box>
            </Paper>
          </Box>
        </Grid>

        {/* 오른쪽: 환경설정 (4) */}
        <Grid item xs={12} md={5}>
          <Paper sx={{ p: 2, height: '100%' }}>
            <Box sx={{ mt: 0 }}>
        {/* 화면모드 설정 (user_settings.theme: dark | white) */}
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography
              variant="h6"
              gutterBottom
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
            >
              <DarkModeIcon sx={{ fontSize: '1.05rem' }} />
              화면모드 설정
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Light 모드는 밝은 화면, Dark 모드는 어두운 화면입니다.
            </Typography>
            <RadioGroup
              row
              value={settings.theme === 'white' || themeMode === 'white' ? 'white' : 'dark'}
              onChange={handleThemeModeChange}
            >
              <FormControlLabel
                value="white"
                control={<Radio disabled={loading} />}
                label="Light 모드"
              />
              <FormControlLabel
                value="dark"
                control={<Radio disabled={loading} />}
                label="Dark 모드"
              />
            </RadioGroup>
          </CardContent>
        </Card>

        <Divider sx={{ my: 3 }} />

        {/* 계좌번호 + 국내 수수료·거래세 */}
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography
              variant="h6"
              gutterBottom
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
            >
              <CreditCardIcon sx={{ fontSize: '1.05rem' }} />
              키움증권 계좌번호 설정
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              자동매매에 사용할 키움증권 계좌번호를 입력하세요.
            </Typography>

            <TextField
              fullWidth
              label="계좌번호"
              margin="normal"
              value={settings.kiwoomAccountNo || ''}
              onChange={(e) => setSettings({ ...settings, kiwoomAccountNo: e.target.value })}
              placeholder="예: 12345678-01"
            />

            <Typography
              variant="h6"
              gutterBottom
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, mt: 3 }}
            >
              <CreditCardIcon sx={{ fontSize: '1.05rem' }} />
              KR 수수료·거래세
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' },
                gap: 2,
                mt: 1,
              }}
            >
              <TextField
                label="매수 수수료 (%)"
                type="number"
                inputProps={{ step: '0.0001', min: 0 }}
                value={
                  settings.buyFeeRate != null
                    ? Math.round(Number(settings.buyFeeRate) * 1000000) / 10000
                    : 0.0125
                }
                onChange={(e) => {
                  const pct = e.target.value;
                  setSettings({
                    ...settings,
                    buyFeeRate: pct === '' ? '' : Number(pct) / 100,
                  });
                }}
              />
              <TextField
                label="매도 수수료 (%)"
                type="number"
                inputProps={{ step: '0.0001', min: 0 }}
                value={
                  settings.sellFeeRate != null
                    ? Math.round(Number(settings.sellFeeRate) * 1000000) / 10000
                    : 0.0125
                }
                onChange={(e) => {
                  const pct = e.target.value;
                  setSettings({
                    ...settings,
                    sellFeeRate: pct === '' ? '' : Number(pct) / 100,
                  });
                }}
              />
              <TextField
                label="증권거래세 (%)"
                type="number"
                inputProps={{ step: '0.01', min: 0 }}
                value={
                  settings.sellTaxRate != null
                    ? Math.round(Number(settings.sellTaxRate) * 1000000) / 10000
                    : 0.18
                }
                onChange={(e) => {
                  const pct = e.target.value;
                  setSettings({
                    ...settings,
                    sellTaxRate: pct === '' ? '' : Number(pct) / 100,
                  });
                }}
              />
            </Box>

            <Typography
              variant="h6"
              gutterBottom
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, mt: 3 }}
            >
              <CreditCardIcon sx={{ fontSize: '1.05rem' }} />
              US 수수료·거래세
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' },
                gap: 2,
                mt: 1,
              }}
            >
              <TextField
                label="매수 수수료 (%)"
                type="number"
                inputProps={{ step: '0.0001', min: 0 }}
                value={
                  settings.usBuyFeeRate != null
                    ? Math.round(Number(settings.usBuyFeeRate) * 1000000) / 10000
                    : 0
                }
                onChange={(e) => {
                  const pct = e.target.value;
                  setSettings({
                    ...settings,
                    usBuyFeeRate: pct === '' ? '' : Number(pct) / 100,
                  });
                }}
              />
              <TextField
                label="매도 수수료 (%)"
                type="number"
                inputProps={{ step: '0.0001', min: 0 }}
                value={
                  settings.usSellFeeRate != null
                    ? Math.round(Number(settings.usSellFeeRate) * 1000000) / 10000
                    : 0
                }
                onChange={(e) => {
                  const pct = e.target.value;
                  setSettings({
                    ...settings,
                    usSellFeeRate: pct === '' ? '' : Number(pct) / 100,
                  });
                }}
              />
              <TextField
                label="거래세 (%)"
                type="number"
                inputProps={{ step: '0.0001', min: 0 }}
                value={
                  settings.usSellTaxRate != null
                    ? Math.round(Number(settings.usSellTaxRate) * 1000000) / 10000
                    : 0
                }
                onChange={(e) => {
                  const pct = e.target.value;
                  setSettings({
                    ...settings,
                    usSellTaxRate: pct === '' ? '' : Number(pct) / 100,
                  });
                }}
              />
            </Box>

            <Button
              variant="contained"
              onClick={async () => {
                if (!settings.kiwoomAccountNo) {
                  setMessage({
                    type: 'error',
                    text: '계좌번호를 입력해주세요.',
                  });
                  return;
                }

                setLoading(true);
                setMessage({ type: '', text: '' });

                try {
                  const rateToPct = (rate) =>
                    Math.round(Number(rate) * 1000000) / 10000;
                  await apiClient.post('/settings/account-no', {
                    accountNo: settings.kiwoomAccountNo,
                    buyFeePercent: rateToPct(settings.buyFeeRate),
                    sellFeePercent: rateToPct(settings.sellFeeRate),
                    sellTaxPercent: rateToPct(settings.sellTaxRate),
                    usBuyFeePercent: rateToPct(settings.usBuyFeeRate),
                    usSellFeePercent: rateToPct(settings.usSellFeeRate),
                    usSellTaxPercent: rateToPct(settings.usSellTaxRate),
                  });
                  setMessage({
                    type: 'success',
                    text: '계좌·수수료 설정이 저장되었습니다.',
                  });
                  await fetchSettings();
                } catch (error) {
                  setMessage({
                    type: 'error',
                    text: error.response?.data?.error || '계좌·수수료 저장 중 오류가 발생했습니다.',
                  });
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading}
              sx={{ mt: 2 }}
            >
              저장
            </Button>
          </CardContent>
        </Card>

        <Divider sx={{ my: 3 }} />

        {/* KRX/US 관심종목 이름 설정 (user_settings.group_name1~8) */}
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography
              variant="h6"
              gutterBottom
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
            >
              <StarIcon sx={{ fontSize: '1.05rem' }} />
              KRX/US 관심종목 이름 설정
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              자동매매 Ver.2 관심종목1 ~ 관심종목8 이름을 설정합니다.
            </Typography>

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                gap: 2,
              }}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <TextField
                  key={n}
                  fullWidth
                  margin="normal"
                  label={`관심종목${n}`}
                  value={settings[`groupName${n}`] || ''}
                  inputProps={{ maxLength: 50 }}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSettings((prev) => ({
                      ...prev,
                      [`groupName${n}`]: value,
                    }));
                  }}
                />
              ))}
            </Box>

            <Button
              variant="contained"
              onClick={handleSaveGroupNames}
              disabled={loading}
              sx={{ mt: 2 }}
            >
              이름 저장
            </Button>
          </CardContent>
        </Card>

        <Divider sx={{ my: 3 }} />

        {/* App Key/Secret 설정 */}
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography
              variant="h6"
              gutterBottom
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
            >
              <KeyIcon sx={{ fontSize: '1.05rem' }} />
              키움증권 App Key/Secret 설정
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              키움증권 개발자 포털에서 발급받은 App Key와 App Secret을 입력하세요.
            </Typography>

            <TextField
              fullWidth
              label="App Key"
              margin="normal"
              value={settings.kiwoomAppKey || ''}
              onChange={handleAppKeyChange}
              placeholder="키움증권에서 발급받은 App Key를 입력하세요"
            />

            <TextField
              fullWidth
              label="App Secret"
              margin="normal"
              type={showSecret ? 'text' : 'password'}
              value={settings.kiwoomAppSecret === '***' ? '' : (settings.kiwoomAppSecret || '')}
              onChange={handleAppSecretChange}
              placeholder={
                settings.hasAppSecret
                  ? '새로운 App Secret을 입력하거나 비워두세요'
                  : '키움증권에서 발급받은 App Secret을 입력하세요'
              }
              helperText={
                settings.hasAppSecret && settings.kiwoomAppSecret === '***'
                  ? '기존 App Secret이 저장되어 있습니다. 변경하려면 새 값을 입력하세요.'
                  : ''
              }
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowSecret(!showSecret)}
                      edge="end"
                    >
                      {showSecret ? <VisibilityOffIcon /> : <VisibilityIcon />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />

            <Button
              variant="contained"
              onClick={handleSaveCredentials}
              disabled={loading}
              sx={{ mt: 2 }}
            >
              저장
            </Button>
          </CardContent>
        </Card>

        <Divider sx={{ my: 3 }} />

        {/* 액세스 토큰 관리 */}
        <Card>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <Typography
                variant="h6"
                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
              >
                <VpnKeyIcon sx={{ fontSize: '1.05rem' }} />
                액세스 토큰 관리
              </Typography>
              <Chip 
                label="매 06시 자동갱신" 
                size="small" 
                color="info" 
                variant="outlined"
                sx={{ fontSize: '0.75rem', height: '24px' }}
              />
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              App Key/Secret을 저장한 후, 자동매매에 사용할 액세스 토큰을 발급받으세요.
            </Typography>

            {settings.hasAccessToken ? (
              <Box>
                {settings.isTokenExpired || settings.tokenStatus === 'expired' ? (
                  <Alert severity="warning" sx={{ mb: 2 }}>
                    액세스 토큰이 만료되었습니다. 토큰을 재발급받으세요.
                    {settings.tokenExpiresAt && (
                      <Typography variant="body2" sx={{ mt: 1 }}>
                        만료일: {new Date(settings.tokenExpiresAt).toLocaleString('ko-KR')}
                      </Typography>
                    )}
                  </Alert>
                ) : (
                <Alert severity="success" sx={{ mb: 2 }}>
                  액세스 토큰이 발급되어 있습니다.
                  {settings.tokenExpiresAt && (
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="body2">
                      만료일: {new Date(settings.tokenExpiresAt).toLocaleString('ko-KR')}
                    </Typography>
                        {(() => {
                          const remainingTime = getTokenRemainingTime();
                          const expiresAt = new Date(settings.tokenExpiresAt);
                          const now = new Date();
                          const diffMs = expiresAt - now;
                          const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                          const isExpiringSoon = diffHours < 1 && diffMs > 0;
                          
                          return remainingTime && (
                            <Typography 
                              variant="body2" 
                              color={isExpiringSoon ? 'warning.main' : 'text.secondary'}
                              sx={{ mt: 0.5 }}
                            >
                              남은 시간: {remainingTime}
                            </Typography>
                          );
                        })()}
                      </Box>
                  )}
                </Alert>
                )}
                <Box sx={{ display: 'flex', gap: 2 }}>
                  <Button
                    variant="contained"
                    color="primary"
                    onClick={handleGenerateToken}
                    disabled={loading}
                  >
                    토큰 재발급
                  </Button>
                  <Button
                    variant="outlined"
                    color="error"
                    startIcon={<DeleteIcon />}
                    onClick={handleDeleteToken}
                    disabled={loading}
                  >
                    토큰 삭제
                  </Button>
                </Box>
              </Box>
            ) : (
              <Box>
                <Alert severity="info" sx={{ mb: 2 }}>
                  액세스 토큰이 발급되지 않았습니다. App Key/Secret을 저장한 후 토큰을 발급받으세요.
                </Alert>
                <Button
                  variant="contained"
                  onClick={handleGenerateToken}
                  disabled={loading || !settings.kiwoomAppKey || !settings.hasAppSecret}
                >
                  토큰 발급
                </Button>
              </Box>
            )}
          </CardContent>
        </Card>

        {/* 관리자 전용: 종목명 업데이트 · 회원관리 — username === admin 만 표시 */}
        {user?.username?.trim().toLowerCase() === 'admin' && (
          <>
            <Divider sx={{ my: 3 }} />

            <Card>
              <CardContent>
                <Typography
                  variant="h6"
                  gutterBottom
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
                >
                  <UpdateIcon sx={{ fontSize: '1.05rem' }} />
                  KRX 종목명 업데이트
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  키움증권의 KRX종목 목록을 가져와 종목명을 업데이트합니다 (NXT은 import 작업필요).
                </Typography>
                <Button
                  variant="outlined"
                  color="secondary"
                  onClick={async () => {
                    try {
                      setMessage({ type: '', text: '' });
                      setLoading(true);
                      await apiClient.post('/watchlist-v2/update-stock-list');
                      setStockUpdateResultDialog({
                        open: true,
                        type: 'success',
                        text: '종목 목록이 업데이트되었습니다.',
                      });
                    } catch (error) {
                      console.error('[종목 목록 업데이트] 실패:', error);
                      setStockUpdateResultDialog({
                        open: true,
                        type: 'error',
                        text: error.response?.data?.error || '종목 목록 업데이트 중 오류가 발생했습니다.',
                      });
                    } finally {
                      setLoading(false);
                    }
                  }}
                  disabled={loading}
                  fullWidth
                >
                  KRX 종목명 업데이트
                </Button>
              </CardContent>
            </Card>

            <Card sx={{ mt: 3 }}>
              <CardContent>
                <Typography
                  variant="h6"
                  gutterBottom
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
                >
                  <UpdateIcon sx={{ fontSize: '1.05rem' }} />
                  미국 종목명 업데이트
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  키움증권 미국주식 종목리스트(usa10099)를 가져와 us_stock_list에 저장합니다.
                </Typography>
                <Button
                  variant="outlined"
                  color="secondary"
                  onClick={async () => {
                    try {
                      setMessage({ type: '', text: '' });
                      setLoading(true);
                      const response = await apiClient.post('/watchlist-v2/update-us-stock-list');
                      setStockUpdateResultDialog({
                        open: true,
                        type: 'success',
                        text:
                          response.data?.message ||
                          `미국 종목 목록이 업데이트되었습니다. (${response.data?.totalCount ?? 0}건)`,
                      });
                    } catch (error) {
                      console.error('[미국 종목 목록 업데이트] 실패:', error);
                      setStockUpdateResultDialog({
                        open: true,
                        type: 'error',
                        text:
                          error.response?.data?.error ||
                          error.response?.data?.message ||
                          '미국 종목 목록 업데이트 중 오류가 발생했습니다.',
                      });
                    } finally {
                      setLoading(false);
                    }
                  }}
                  disabled={loading}
                  fullWidth
                >
                  미국 종목명 업데이트
                </Button>
              </CardContent>
            </Card>

          </>
        )}
      </Box>
          </Paper>
        </Grid>
      </Grid>

      {/* 종목명 업데이트 결과 다이얼로그 */}
      <Dialog
        open={stockUpdateResultDialog.open}
        onClose={() => {
          setStockUpdateResultDialog(prev => ({ ...prev, open: false }));
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          {stockUpdateResultDialog.type === 'success' ? '업데이트 성공' : '업데이트 실패'}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {stockUpdateResultDialog.text}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setStockUpdateResultDialog(prev => ({ ...prev, open: false }));
            }}
            variant="contained"
          >
            확인
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default Settings;


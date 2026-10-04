import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
import apiClient from '../utils/axios';

const AuthContext = createContext();

/** express-validator `{ errors: [{ msg }] }` 및 `{ error }` / `{ message }` 공통 추출 */
const getApiErrorMessage = (error, fallback) => {
  if (error?.code === 'ERR_NETWORK' || error?.message?.includes('Network Error')) {
    return '서버에 연결할 수 없습니다. 백엔드 서버가 실행 중인지 확인하세요.';
  }
  const data = error?.response?.data;
  const validationMsgs = Array.isArray(data?.errors)
    ? data.errors.map((e) => e.msg).filter(Boolean)
    : [];
  if (validationMsgs.length > 0) {
    return validationMsgs.join('\n');
  }
  if (data?.error) return data.error;
  if (data?.message) return data.message;
  if (error?.message) return error.message;
  return fallback;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  const logout = useCallback(async () => {
    try {
      // 백엔드에 로그아웃 요청 (로그 기록을 위해)
      if (token) {
        try {
          await apiClient.post('/auth/logout', { client: 'web' });
        } catch (error) {
          // 로그아웃 API 호출 실패해도 로컬 로그아웃은 진행
          console.error('로그아웃 API 호출 실패:', error);
        }
      }
    } catch (error) {
      console.error('로그아웃 오류:', error);
    } finally {
      // 로컬 상태 정리
      setToken(null);
      setUser(null);
      localStorage.removeItem('token');
    }
  }, [token]);

  const fetchUser = useCallback(async () => {
    try {
      const response = await apiClient.get('/auth/me');
      setUser(response.data);
    } catch (error) {
      console.error('사용자 정보 조회 실패:', error);
      // Network Error인 경우에만 로그아웃하지 않음 (서버가 꺼져있을 수 있음)
      if (error.code !== 'ERR_NETWORK' && !error.message.includes('Network Error')) {
        logout();
      }
    } finally {
      setLoading(false);
    }
  }, [logout]);

  useEffect(() => {
    if (token) {
      fetchUser();
    } else {
      setLoading(false);
    }
  }, [token, fetchUser]);

  const login = async (email, password) => {
    try {
      const response = await apiClient.post('/auth/login', {
        email,
        password,
        client: 'web',
      });
      const { token: newToken } = response.data;
      setToken(newToken);
      localStorage.setItem('token', newToken);
      await fetchUser();
      return { success: true };
    } catch (error) {
      console.error('로그인 오류:', error);
      const errorMessage = getApiErrorMessage(error, '로그인에 실패했습니다.');

      // 이메일 인증이 필요한 경우
      if (error.response?.status === 403 && error.response?.data?.requiresVerification) {
        return {
          success: false,
          error: errorMessage,
          requiresVerification: true,
        };
      }
      
      return {
        success: false,
        error: errorMessage,
      };
    }
  };

  const value = {
    user,
    token,
    loading,
    login,
    logout,
    fetchUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};


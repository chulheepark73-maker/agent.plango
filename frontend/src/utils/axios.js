import axios from 'axios';

// 프로덕션 환경에서는 Nginx 프록시를 통해 /api 사용
// 개발 환경에서는 환경 변수 또는 현재 호스트 기반으로 설정
const getApiUrl = () => {
  // 프로덕션 빌드에서 환경 변수가 설정되어 있으면 사용
  if (process.env.REACT_APP_API_URL) {
    return process.env.REACT_APP_API_URL;
  }
  
  // 프로덕션 환경이고 환경 변수가 없으면 상대 경로 사용 (Nginx 프록시)
  if (process.env.NODE_ENV === 'production') {
    return '/api';
  }
  
  // 개발 환경: 현재 호스트 기반으로 자동 설정 (CORS 문제 방지)
  // 브라우저에서 실행 중이므로 window.location 사용 가능
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const port = '3001';
    
    // localhost가 아닌 경우 (공개 IP 등) 서버 IP 사용
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return `${protocol}//${hostname}:${port}/api`;
    }
  }
  
  // 로컬 개발 환경 기본값
  return 'http://localhost:3001/api';
};

export const API_URL = getApiUrl();

export const AGENT_STATUS_CHANGED_EVENT = 'plango:agent-status-changed';

// axios instance 생성
const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
    'X-Client': 'web',
  },
});

// Request interceptor: 토큰 자동 추가
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor: 에러 처리
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // Network Error 처리
    if (error.code === 'ERR_NETWORK' || error.message.includes('Network Error')) {
      console.error('서버에 연결할 수 없습니다. 백엔드 서버가 실행 중인지 확인하세요.');
    }
    
    const errorData = error.response?.data;
    const isOwnerMismatch =
      error.response?.status === 403 && errorData?.code === 'AGENT_OWNER_MISMATCH';
    const isAccountBlocked =
      error.response?.status === 403 && errorData?.code === 'ACCOUNT_BLOCKED';

    // 서버 미등록·등록 해제 — 로그인은 유지하고 화면이 등록 상태를 다시 읽게 한다
    if (error.response?.status === 403 && errorData?.code === 'AGENT_NOT_REGISTERED') {
      window.dispatchEvent(new Event(AGENT_STATUS_CHANGED_EVENT));
    }

    // 401 Unauthorized / 이 에이전트 사용자가 아닌 토큰 / 계정 정지
    if (error.response?.status === 401 || isOwnerMismatch || isAccountBlocked) {
      if (errorData?.code === 'SESSION_EXPIRED' || isOwnerMismatch || isAccountBlocked) {
        localStorage.removeItem('token');
        if (window.location.pathname !== '/login') {
          alert(errorData?.error || '로그인이 만료되었습니다. 다시 로그인해주세요.');
          window.location.href = '/login';
        }
      } else {
        // 일반적인 인증 실패
        localStorage.removeItem('token');
        // 로그인 페이지로 리다이렉트 (단, 이미 로그인 페이지가 아닌 경우에만)
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
      }
    }
    
    return Promise.reject(error);
  }
);

export default apiClient;


/** 중앙 서버 웹 (회원가입·구독·개인정보 관리) */
export const CENTRAL_WEB_URL = String(
  process.env.REACT_APP_CENTRAL_WEB_URL || 'https://plango.today'
).replace(/\/+$/, '');

export const centralUrl = (path = '') => `${CENTRAL_WEB_URL}${path}`;

/** Auth 웹 (계정 만들기·비밀번호 찾기) */
export const AUTH_WEB_URL = String(
  process.env.REACT_APP_AUTH_WEB_URL || 'https://auth.plango.today'
).replace(/\/+$/, '');

export const authUrl = (path = '') => `${AUTH_WEB_URL}${path}`;

export const openCentral = (path = '') => {
  window.open(centralUrl(path), '_blank', 'noopener,noreferrer');
};

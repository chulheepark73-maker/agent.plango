/** 중앙 서버 웹 (회원가입·구독·개인정보 관리) */
export const CENTRAL_WEB_URL = String(
  process.env.REACT_APP_CENTRAL_WEB_URL || 'https://plango.today'
).replace(/\/+$/, '');

export const centralUrl = (path = '') => `${CENTRAL_WEB_URL}${path}`;

export const openCentral = (path = '') => {
  window.open(centralUrl(path), '_blank', 'noopener,noreferrer');
};

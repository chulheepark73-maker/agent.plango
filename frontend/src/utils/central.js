/** Auth 웹 (계정 만들기·비밀번호 찾기) */
export const AUTH_WEB_URL = String(
  process.env.REACT_APP_AUTH_WEB_URL || 'https://auth.plango.today'
).replace(/\/+$/, '');

export const authUrl = (path = '') => `${AUTH_WEB_URL}${path}`;

/**
 * 실행 위치 기준 경로
 * - 개발(node server.js): backend/ 폴더 기준
 * - 단일 실행파일(Node SEA): 실행파일이 있는 폴더 기준 (data/, log/, build/, .env 를 옆에 둔다)
 */
const path = require('path');

const isSea = (() => {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
})();

const APP_ROOT = isSea ? path.dirname(process.execPath) : path.join(__dirname, '..');

/** SEA 에 함께 묶은 asset 을 문자열로 읽는다 (개발 환경에서는 null) */
const readSeaAsset = (name) => {
  if (!isSea) return null;
  return require('node:sea').getAsset(name, 'utf8');
};

module.exports = {
  isSea,
  APP_ROOT,
  DATA_DIR: path.join(APP_ROOT, 'data'),
  LOG_DIR: path.join(APP_ROOT, 'log'),
  ENV_FILE: path.join(APP_ROOT, '.env'),
  FRONTEND_BUILD_DIR: isSea ? path.join(APP_ROOT, 'build') : path.join(APP_ROOT, '..', 'frontend', 'build'),
  readSeaAsset,
};

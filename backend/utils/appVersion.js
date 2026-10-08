/**
 * 에이전트 버전 — 루트 package.json 기준 (backend 단독 배포 시 backend/package.json)
 */
let appVersion = '0.0.0';
try {
  appVersion = require('../../package.json').version || appVersion;
} catch {
  try {
    appVersion = require('../package.json').version || appVersion;
  } catch {
    /* ignore */
  }
}

module.exports = { appVersion: String(appVersion).trim() };

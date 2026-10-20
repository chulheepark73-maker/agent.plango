/**
 * 에이전트 자동 업데이트 (리눅스 단일 실행파일 + pm2 기준)
 *
 * 1. 로그인 시 중앙(auth)의 최신 버전 확인 → 현재보다 높으면 화면에 안내
 * 2. 배포본(tar.gz)을 내려받아 sha256 확인 후 실행 폴더의 agent_latest/ 에 풀어 둔다
 * 3. 로그아웃 직후(국내·미국 장이 모두 닫혀 있을 때만) 또는 매일 07:55:00 (KST) 에
 *    실행파일 → <이름>_bak, build/ → build_bak/ 으로 백업하고 agent_latest 의 파일로 교체
 * 4. pm2 restart <PM2_APP_NAME> 로 새 버전 실행
 *
 * .env, data/, log/ 는 건드리지 않는다. 개발 환경(node server.js)에서는 확인·안내만 한다.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const axios = require('axios');
const cron = require('node-cron');
const central = require('./centralClient');
const { appVersion } = require('../utils/appVersion');
const { isSea, APP_ROOT, FRONTEND_BUILD_DIR } = require('../utils/appPaths');

const LOG = '[업데이트]';
const RELEASE_EXE_NAME = 'plango-agent';
const STAGE_DIR = path.join(APP_ROOT, 'agent_latest');
const STAGE_TARBALL = path.join(APP_ROOT, 'agent_latest.tar.gz');
const STAGE_META = path.join(STAGE_DIR, 'version.json');
const PM2_APP_NAME = process.env.PM2_APP_NAME || 'plango-agent';
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const canSelfUpdate = isSea && process.platform === 'linux';

const state = {
  latestVersion: null,
  downloadUrl: null,
  sha256: null,
  notes: null,
  /** idle | downloading | ready | failed | applying */
  status: 'idle',
  error: null,
  checkedAt: null,
};

let checkPromise = null;
let downloadPromise = null;

/** '1.0.10' > '1.0.9' 처럼 점 단위 숫자 비교. a>b 면 양수 */
const compareVersions = (a, b) => {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
};

const isNewer = (v) => !!v && compareVersions(v, appVersion) > 0;

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} 실패: ${stderr || err.message}`)) : resolve(stdout)
    );
  });

const exists = (p) => fsp.access(p).then(() => true, () => false);

const readStageMeta = async () => {
  try {
    return JSON.parse(await fsp.readFile(STAGE_META, 'utf8'));
  } catch {
    return null;
  }
};

/** 압축을 푼 배포본에서 실행파일이 있는 폴더 (tar 최상위가 plango-agent/ 인 경우 포함) */
const findStagedRoot = async () => {
  for (const root of [path.join(STAGE_DIR, RELEASE_EXE_NAME), STAGE_DIR]) {
    try {
      if ((await fsp.stat(path.join(root, RELEASE_EXE_NAME))).isFile()) return root;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
};

const downloadTo = async (url, dest) => {
  const res = await axios.get(url, { responseType: 'stream', timeout: DOWNLOAD_TIMEOUT_MS, maxRedirects: 5 });
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.data.on('data', (chunk) => hash.update(chunk));
    res.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.data.pipe(out);
  });
  return hash.digest('hex');
};

const download = async () => {
  const { latestVersion: version, downloadUrl, sha256 } = state;
  if (!/^https:\/\//i.test(String(downloadUrl || ''))) {
    throw new Error(`다운로드 주소가 https 가 아닙니다: ${downloadUrl || '-'}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(String(sha256 || ''))) {
    throw new Error('중앙에 sha256 이 등록되지 않아 내려받지 않습니다.');
  }

  state.status = 'downloading';
  state.error = null;
  console.log(`${LOG} v${version} 내려받기 시작: ${downloadUrl}`);

  const part = `${STAGE_TARBALL}.part`;
  const digest = await downloadTo(downloadUrl, part);
  if (digest.toLowerCase() !== String(sha256).toLowerCase()) {
    await fsp.rm(part, { force: true });
    throw new Error(`sha256 불일치 (받은 파일 ${digest})`);
  }
  await fsp.rename(part, STAGE_TARBALL);

  await fsp.rm(STAGE_DIR, { recursive: true, force: true });
  await fsp.mkdir(STAGE_DIR, { recursive: true });
  await run('tar', ['-xzf', STAGE_TARBALL, '-C', STAGE_DIR]);
  await fsp.rm(STAGE_TARBALL, { force: true });

  const root = await findStagedRoot();
  if (!root) throw new Error(`배포본에 ${RELEASE_EXE_NAME} 실행파일이 없습니다.`);
  await fsp.chmod(path.join(root, RELEASE_EXE_NAME), 0o755);
  await fsp.writeFile(STAGE_META, JSON.stringify({ version, sha256, downloadedAt: new Date().toISOString() }));

  state.status = 'ready';
  console.log(`${LOG} v${version} 준비 완료 (${STAGE_DIR}) — 로그아웃 또는 07:55 에 교체`);
};

const ensureDownloaded = () => {
  if (!canSelfUpdate || !isNewer(state.latestVersion)) return Promise.resolve();
  if (downloadPromise) return downloadPromise;
  downloadPromise = (async () => {
    const meta = await readStageMeta();
    if (meta?.version === state.latestVersion && (await findStagedRoot())) {
      state.status = 'ready';
      return;
    }
    await download();
  })()
    .catch((err) => {
      state.status = 'failed';
      state.error = err.message;
      console.error(`${LOG} 내려받기 실패:`, err.message);
    })
    .finally(() => {
      downloadPromise = null;
    });
  return downloadPromise;
};

/** 중앙 최신 버전 확인 → 새 버전이면 배경에서 내려받기 시작 */
const checkForUpdate = () => {
  if (checkPromise) return checkPromise;
  checkPromise = (async () => {
    const data = await central.getLatestAgentVersion();
    state.checkedAt = new Date().toISOString();
    state.latestVersion = data?.version ? String(data.version).trim() : null;
    state.downloadUrl = data?.downloadUrl || null;
    state.sha256 = data?.sha256 || null;
    state.notes = data?.notes || null;
    if (!state.latestVersion) {
      console.log(`${LOG} auth 서버에 현재 등록된 최신버전이 없습니다. (현재 v${appVersion})`);
      return;
    }
    console.log(`${LOG} auth 서버에 등록된 최신버전은 v${state.latestVersion} 입니다. (현재 v${appVersion})`);
    if (isNewer(state.latestVersion)) {
      console.log(`${LOG} 새 버전 v${state.latestVersion} 이 있습니다.`);
      ensureDownloaded();
    } else {
      console.log(`${LOG} 현재 최신버전으로 실행 중입니다.`);
    }
  })()
    .catch((err) => {
      console.warn(`${LOG} 최신 버전 확인 실패:`, err.message);
    })
    .finally(() => {
      checkPromise = null;
    });
  return checkPromise;
};

/** 화면 안내용 상태 (진행 중인 확인이 있으면 최대 5초 기다린다) */
const getUpdateStatus = async () => {
  if (checkPromise) {
    await Promise.race([checkPromise, new Promise((r) => setTimeout(r, 5000))]);
  }
  const updateAvailable = isNewer(state.latestVersion);
  return {
    currentVersion: appVersion,
    latestVersion: state.latestVersion,
    updateAvailable,
    autoUpdate: canSelfUpdate,
    status: state.status,
    error: state.error,
    message: updateAvailable
      ? canSelfUpdate
        ? `agent 프로그램에 최신버전(v${state.latestVersion})이 있습니다. 다음번 실행시 최신버전으로 자동 실행됩니다.`
        : `agent 프로그램에 최신버전(v${state.latestVersion})이 있습니다.`
      : null,
  };
};

const restartWithPm2 = () => {
  // pm2 로 띄운 프로세스에는 pm_id 가 있다. 아니면 교체만 해 두고 다음 실행 때 적용된다.
  if (process.env.pm_id == null) {
    console.log(`${LOG} pm2 로 실행 중이 아니어서 재시작하지 않습니다. 다음 실행 시 새 버전이 실행됩니다.`);
    return;
  }
  console.log(`${LOG} pm2 restart ${PM2_APP_NAME}`);
  const child = spawn('pm2', ['restart', PM2_APP_NAME], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => console.error(`${LOG} pm2 실행 실패:`, err.message));
  child.unref();
};

/** 국내(NXT 프리·정규·시간외·애프터) 또는 미국(프리·정규·애프터) 세션 중이면 true */
const isAnyMarketSessionOpen = () => {
  const {
    isKRXSessionOpen,
    isNXTTradingHours,
    isPreMarketWarmup,
    isUsTradingHours,
  } = require('../utils/stockUtils');
  return isKRXSessionOpen() || isNXTTradingHours() || isPreMarketWarmup() || isUsTradingHours();
};

/**
 * 준비된 새 버전으로 실행파일·build 교체 후 pm2 재시작
 * @param {string} reason
 * @param {{ onlyWhenMarketClosed?: boolean }} [opts] true 면 장중에는 교체하지 않는다 (trailing·주문 상태가 메모리에 있음)
 */
const applyUpdateIfReady = async (reason, { onlyWhenMarketClosed = false } = {}) => {
  if (!canSelfUpdate || state.status === 'applying') return false;
  const meta = await readStageMeta();
  const root = meta ? await findStagedRoot() : null;
  if (!meta || !root || !isNewer(meta.version)) return false;
  if (onlyWhenMarketClosed && isAnyMarketSessionOpen()) {
    console.log(`${LOG} v${meta.version} 준비됨 — 장중이라 ${reason} 교체를 미룹니다 (07:55 또는 장 종료 후 로그아웃 시 교체)`);
    return false;
  }

  state.status = 'applying';
  const exePath = process.execPath;
  const exeBak = `${exePath}_bak`;
  const buildBak = `${FRONTEND_BUILD_DIR}_bak`;
  const stagedExe = path.join(root, RELEASE_EXE_NAME);
  const stagedBuild = path.join(root, 'build');
  const hasStagedBuild = await exists(stagedBuild);
  const done = [];

  console.log(`${LOG} v${appVersion} → v${meta.version} 교체 시작 (${reason})`);
  try {
    await fsp.rm(exeBak, { force: true });
    await fsp.rename(exePath, exeBak);
    done.push(() => fsp.rename(exeBak, exePath));
    await fsp.rename(stagedExe, exePath);
    done.push(() => fsp.rename(exePath, stagedExe));

    if (hasStagedBuild) {
      await fsp.rm(buildBak, { recursive: true, force: true });
      if (await exists(FRONTEND_BUILD_DIR)) {
        await fsp.rename(FRONTEND_BUILD_DIR, buildBak);
        done.push(() => fsp.rename(buildBak, FRONTEND_BUILD_DIR));
      }
      await fsp.rename(stagedBuild, FRONTEND_BUILD_DIR);
    }
  } catch (err) {
    console.error(`${LOG} 교체 실패, 원래대로 되돌립니다:`, err.message);
    for (const undo of done.reverse()) {
      await undo().catch((e) => console.error(`${LOG} 되돌리기 실패:`, e.message));
    }
    state.status = 'failed';
    state.error = err.message;
    return false;
  }

  await fsp.rm(STAGE_DIR, { recursive: true, force: true }).catch(() => {});
  console.log(`${LOG} 교체 완료 — 이전 버전: ${path.basename(exeBak)}${hasStagedBuild ? ', build_bak/' : ''}`);
  restartWithPm2();
  return true;
};

let started = false;

const startAgentUpdater = () => {
  if (started) return;
  started = true;
  // 08:00 NXT 프리마켓 전
  cron.schedule(
    '0 55 7 * * *',
    () => {
      applyUpdateIfReady('07:55').catch((e) => console.error(`${LOG} 07:55 교체 오류:`, e.message));
    },
    { timezone: 'Asia/Seoul' }
  );
  // 이전 실행에서 받아 둔 같은/낮은 버전 배포본 정리
  readStageMeta().then((meta) => {
    if (meta && !isNewer(meta.version)) fsp.rm(STAGE_DIR, { recursive: true, force: true }).catch(() => {});
  });
  console.log(
    `${LOG} 시작 (현재 v${appVersion}, 자동 교체 ${canSelfUpdate ? `사용 · pm2 ${PM2_APP_NAME}` : '안 함(개발/비리눅스)'})`
  );
};

module.exports = {
  startAgentUpdater,
  checkForUpdate,
  getUpdateStatus,
  applyUpdateIfReady,
  compareVersions,
};

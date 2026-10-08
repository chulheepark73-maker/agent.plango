/**
 * 백엔드를 Node SEA 단일 실행파일로 만든다.
 *   node scripts/build-sea.js [출력폴더]
 *
 * 1) esbuild 로 server.js 를 dist/server.bundle.js 한 파일로 묶는다
 * 2) sea-config.json 작성 (db/trading_schema.sql 은 asset 으로 포함)
 * 3) node --build-sea 로 실행파일 생성
 *
 * 실행파일은 빌드한 OS/CPU 에서만 돈다 (우분투 x64 에서 빌드 → 리눅스 x64 용).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const BACKEND_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(BACKEND_DIR, 'dist');
const OUT_DIR = path.resolve(process.argv[2] || DIST_DIR);
const BUNDLE = path.join(DIST_DIR, 'server.bundle.js');
const SEA_CONFIG = path.join(DIST_DIR, 'sea-config.json');
const EXE_NAME = process.platform === 'win32' ? 'plango-agent.exe' : 'plango-agent';
const EXE_PATH = path.join(OUT_DIR, EXE_NAME);

const main = async () => {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 25) {
    throw new Error(`node --build-sea 는 Node 25.5+ 필요 (현재 ${process.version})`);
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(BACKEND_DIR, 'server.js')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${major}`,
    logLevel: 'warning',
  });
  console.log(`[build-sea] bundle: ${BUNDLE}`);

  const seaConfig = {
    main: BUNDLE,
    output: EXE_PATH,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    assets: {
      'trading_schema.sql': path.join(BACKEND_DIR, 'db', 'trading_schema.sql'),
    },
  };
  fs.writeFileSync(SEA_CONFIG, JSON.stringify(seaConfig, null, 2));

  execFileSync(process.execPath, ['--build-sea', SEA_CONFIG], { stdio: 'inherit' });
  if (process.platform !== 'win32') fs.chmodSync(EXE_PATH, 0o755);
  console.log(`[build-sea] executable: ${EXE_PATH}`);
};

main().catch((err) => {
  console.error('[build-sea] 실패:', err.message);
  process.exit(1);
});

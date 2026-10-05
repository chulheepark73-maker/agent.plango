/**
 * 매매 store 의 SQL 을 SQLite 스키마에 대고 prepare 해 본다 (실행하지 않음).
 *
 *   node scripts/check_trading_sql.js [파일...]
 *   인자 없으면 tradingDb 를 쓰는 utils/routes/services 전부
 *
 * 템플릿 리터럴의 ${...} 는 1 로 바꿔 검사하므로 동적 SQL 은 일부 오탐이 날 수 있다.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.TRADING_DB_PATH = path.join(os.tmpdir(), `check_trading_sql_${process.pid}.db`);
const { db, translateSql } = require('../utils/tradingDb');

const ROOT = path.join(__dirname, '..');

const listTargets = () => {
  const out = [];
  for (const dir of ['utils', 'routes', 'services']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.js')) continue;
      const rel = `${dir}/${f}`;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (/require\(['"](\.\/|\.\.\/utils\/)tradingDb['"]\)/.test(src) && rel !== 'utils/tradingDb.js') out.push(rel);
    }
  }
  return out;
};

/** .query( 바로 뒤의 문자열 리터럴 추출 */
const extractSql = (src) => {
  const found = [];
  const re = /\.query\(\s*/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    const q = src[i];
    if (q !== '`' && q !== "'" && q !== '"') continue;
    const line = src.slice(0, i).split('\n').length;
    let j = i + 1;
    let text = '';
    let depth = 0;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') {
        text += src[j + 1];
        j += 2;
        continue;
      }
      if (q === '`' && c === '$' && src[j + 1] === '{') {
        depth = 1;
        j += 2;
        while (j < src.length && depth > 0) {
          if (src[j] === '{') depth += 1;
          else if (src[j] === '}') depth -= 1;
          j += 1;
        }
        text += '1';
        continue;
      }
      if (c === q) break;
      text += c;
      j += 1;
    }
    found.push({ line, sql: text });
  }
  return found;
};

const targets = process.argv.slice(2).length ? process.argv.slice(2) : listTargets();
let errors = 0;
let total = 0;
for (const rel of targets) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const { line, sql } of extractSql(src)) {
    const trimmed = sql.trim();
    if (!trimmed || /^(BEGIN|COMMIT|ROLLBACK)$/i.test(trimmed)) continue;
    total += 1;
    const { sql: translated } = translateSql(trimmed);
    try {
      db.prepare(translated);
    } catch (e) {
      errors += 1;
      console.log(`\n${rel}:${line}  ${e.message}`);
      console.log(`  ${translated.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }
}
console.log(`\n검사 ${total}개 SQL, 오류 ${errors}개 (${targets.length}개 파일)`);
db.close();
try {
  fs.unlinkSync(process.env.TRADING_DB_PATH);
} catch {
  /* ignore */
}
process.exit(errors ? 1 : 0);

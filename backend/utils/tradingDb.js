/**
 * 매매 DB (SQLite, Node 내장 node:sqlite — 네이티브 모듈 없이 단일 실행파일로 배포 가능)
 *
 * 기존 store 코드가 쓰던 pg Pool 과 같은 모양을 제공한다.
 *   query(sql, params) → Promise<{ rows, rowCount }>
 *   connect()          → Promise<client>  (client.query / client.release, 트랜잭션은 직렬화)
 *
 * SQL 은 PostgreSQL 문법 일부를 자동 변환한다.
 *   $1        → @p1
 *   NOW() · CURRENT_TIMESTAMP → ISO-8601 UTC 문자열
 *   ILIKE     → LIKE,  = ANY($n) → IN (json_each),  FOR UPDATE 제거
 *   UPDATE t a SET → UPDATE t AS a SET,  TRIM(LEADING 'x' FROM e) → LTRIM(e, 'x')
 *   NOW() - INTERVAL 'n unit' → strftime(..., '-n units'),  LEFT(col, n) → SUBSTR(col, 1, n)
 *   ::int 등 단순 캐스트 제거
 * 그 밖의 INTERVAL · DATE_TRUNC · AT TIME ZONE · DISTINCT ON 등은 각 store 에서 SQLite 문법으로 직접 쓴다.
 * KST 날짜는 date(col, '+9 hours') 로 구한다 (시각은 UTC ISO 로 저장).
 *
 * 값 변환
 *   바인딩: boolean → 1/0, Date → ISO 문자열, 객체/배열 → JSON 문자열
 *   결과:   BOOLEAN 선언 컬럼 → true/false, JSON 선언 컬럼 → 객체, ISO 시각 문자열 → Date
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, readSeaAsset } = require('./appPaths');

const DB_PATH = process.env.TRADING_DB_PATH || path.join(DATA_DIR, 'trading.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'trading_schema.sql');
const SCHEMA_ASSET = 'trading_schema.sql';

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CAST_TYPES =
  'integer|int|int4|int8|bigint|smallint|numeric|decimal|real|float8|float|double precision|' +
  'text|varchar|character varying|char|bpchar|jsonb|json|boolean|bool|timestamptz|timestamp|' +
  'timestamp without time zone|timestamp with time zone';
const CAST_RE = new RegExp(`::(?:${CAST_TYPES})(?:\\(\\d+(?:,\\s*\\d+)?\\))?(?:\\[\\])?`, 'gi');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH, { timeout: 5000 });
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(readSeaAsset(SCHEMA_ASSET) ?? fs.readFileSync(SCHEMA_PATH, 'utf8'));

/** CREATE TABLE IF NOT EXISTS 는 기존 테이블에 컬럼을 더하지 않으므로, 이후 추가된 컬럼은 여기서 보강한다 */
const ADDED_COLUMNS = [
  ['broker_accounts', 'trading_mode', "TEXT NOT NULL DEFAULT 'live' CHECK (trading_mode IN ('live', 'mock'))"],
  ['broker_account_credentials', 'mock_app_key', 'TEXT'],
  ['broker_account_credentials', 'mock_app_secret', 'TEXT'],
  ['broker_account_credentials', 'mock_access_token', 'TEXT'],
  ['broker_account_credentials', 'mock_access_token_expires_at', 'TEXT'],
  ['user_settings', 'holdings_rotate_sec', 'INTEGER NOT NULL DEFAULT 10'],
];
for (const [table, column, ddl] of ADDED_COLUMNS) {
  const exists = db.prepare(`PRAGMA table_info("${table}")`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${ddl}`);
}

const boolColumns = new Set();
const jsonColumns = new Set();
{
  const types = new Map();
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const col of db.prepare(`PRAGMA table_info("${name}")`).all()) {
      const t = String(col.type || '').toUpperCase();
      if (!types.has(col.name)) types.set(col.name, new Set());
      types.get(col.name).add(t);
    }
  }
  for (const [name, set] of types) {
    if (set.size !== 1) continue;
    if (set.has('BOOLEAN')) boolColumns.add(name);
    if (set.has('JSON')) jsonColumns.add(name);
  }
}

/* ---------- SQL 변환 ---------- */

const translated = new Map();

const translateSql = (sql) => {
  const cached = translated.get(sql);
  if (cached) return cached;
  const params = new Set();
  const out = sql
    .replace(CAST_RE, '')
    .replace(/=\s*ANY\s*\(\s*\$(\d+)\s*\)/gi, (_, n) => `IN (SELECT value FROM json_each($${n}))`)
    .replace(/<>\s*ALL\s*\(\s*\$(\d+)\s*\)/gi, (_, n) => `NOT IN (SELECT value FROM json_each($${n}))`)
    .replace(/\$(\d+)/g, (_, n) => {
      params.add(Number(n));
      return `@p${n}`;
    })
    .replace(
      /\b(?:NOW\(\)|CURRENT_TIMESTAMP)\s*([-+])\s*INTERVAL\s*'(\d+(?:\.\d+)?)\s*(second|minute|hour|day|month|year)s?'/gi,
      (_, sign, n, unit) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','${sign}${n} ${unit.toLowerCase()}s')`
    )
    .replace(/\bLEFT\(\s*([\w.]+)\s*,\s*(\d+|@p\d+)\s*\)/gi, 'SUBSTR($1, 1, $2)')
    .replace(/\bNOW\(\)/gi, `(${NOW_SQL})`)
    .replace(/\bCURRENT_TIMESTAMP\b/gi, `(${NOW_SQL})`)
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/\bFOR UPDATE( OF \w+)?( SKIP LOCKED| NOWAIT)?/gi, '')
    .replace(/\bUPDATE\s+("?\w+"?)\s+(?!SET\b|AS\b)(\w+)\s+SET\b/gi, 'UPDATE $1 AS $2 SET')
    .replace(/\bTRIM\(\s*LEADING\s+('[^']*')\s+FROM\s+([^()]+?)\)/gi, 'LTRIM($2, $1)')
    .replace(/\bTRIM\(\s*TRAILING\s+('[^']*')\s+FROM\s+([^()]+?)\)/gi, 'RTRIM($2, $1)');
  const result = { sql: out, params: [...params] };
  translated.set(sql, result);
  return result;
};

const toBindValue = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
};

/** node:sqlite 행은 null-prototype 객체 — 일반 객체로 옮기며 값 변환 */
const fromRow = (raw) => {
  const row = {};
  for (const key of Object.keys(raw)) {
    let v = raw[key];
    if (v === null) {
      row[key] = v;
      continue;
    }
    if (v instanceof Uint8Array) v = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    else if (boolColumns.has(key) && (v === 0 || v === 1)) v = v === 1;
    else if (jsonColumns.has(key) && typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch {
        /* 문자열 그대로 */
      }
    } else if (typeof v === 'string' && ISO_RE.test(v)) v = new Date(v);
    row[key] = v;
  }
  return row;
};

/** @type {Map<string, { stmt: import('node:sqlite').StatementSync, reader: boolean }>} */
const statements = new Map();

const prepare = (sql) => {
  let entry = statements.get(sql);
  if (!entry) {
    const stmt = db.prepare(sql);
    // 결과 컬럼이 있으면 조회문 (SELECT · PRAGMA · ... RETURNING)
    entry = { stmt, reader: stmt.columns().length > 0 };
    statements.set(sql, entry);
  }
  return entry;
};

/** SQLite 확장 오류 코드 → 이름 */
const SQLITE_ERRCODE_NAMES = {
  2067: 'SQLITE_CONSTRAINT_UNIQUE',
  1555: 'SQLITE_CONSTRAINT_PRIMARYKEY',
  787: 'SQLITE_CONSTRAINT_FOREIGNKEY',
  1299: 'SQLITE_CONSTRAINT_NOTNULL',
  275: 'SQLITE_CONSTRAINT_CHECK',
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
};

/** pg 오류 코드 호환 (unique 위반 23505 등) */
const mapError = (error, sql) => {
  const code = SQLITE_ERRCODE_NAMES[error.errcode] || String(error.code || '');
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') error.code = '23505';
  else if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') error.code = '23503';
  else if (code === 'SQLITE_CONSTRAINT_NOTNULL') error.code = '23502';
  else if (code === 'SQLITE_CONSTRAINT_CHECK') error.code = '23514';
  error.sqliteCode = code;
  error.sql = sql;
  return error;
};

const runQuery = (text, values = []) => {
  const { sql, params } = translateSql(text);
  try {
    if (!params.length && !values.length && /;\s*\S/.test(sql.trim().replace(/;\s*$/, ''))) {
      db.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const { stmt, reader } = prepare(sql);
    const bind = {};
    for (const n of params) bind[`p${n}`] = toBindValue(values[n - 1]);
    if (reader) {
      const rows = (params.length ? stmt.all(bind) : stmt.all()).map(fromRow);
      return { rows, rowCount: rows.length };
    }
    const info = params.length ? stmt.run(bind) : stmt.run();
    // DDL·BEGIN 등은 sqlite3_changes() 가 직전 DML 값으로 남아 있으므로 0
    const isDml = /^\s*(?:WITH\b[\s\S]*?\b)?(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
    return { rows: [], rowCount: isDml ? Number(info.changes) : 0, lastInsertRowid: Number(info.lastInsertRowid) };
  } catch (error) {
    throw mapError(error, sql);
  }
};

/* ---------- 트랜잭션 (pool.connect 호환) ---------- */

let txQueue = Promise.resolve();

const connect = () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const acquired = txQueue.then(() => client);
  txQueue = txQueue.then(() => held);

  let released = false;
  const client = {
    query: async (text, values) => runQuery(text, values),
    release: () => {
      if (released) return;
      released = true;
      if (db.isTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
      }
      release();
    },
  };
  return acquired;
};

const query = async (text, values) => runQuery(text, values);

/** 동기 트랜잭션 헬퍼 (새 코드용) — 이미 트랜잭션 중이면 SAVEPOINT 로 중첩 */
let savepointSeq = 0;
const transaction = (fn) => {
  if (db.isTransaction) {
    const name = `sp_${(savepointSeq += 1)}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
};

const close = () => db.close();

module.exports = { db, query, connect, transaction, close, translateSql, DB_PATH, NOW_SQL };

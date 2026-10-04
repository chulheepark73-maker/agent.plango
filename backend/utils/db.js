const path = require('path');
const { Pool } = require('pg');

// backend/scripts 등 하위 경로에서 실행해도 backend/.env 로드
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const dbPassword =
  process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : undefined;

if (dbPassword === undefined) {
  console.warn(
    '[db] DB_PASSWORD가 설정되지 않았습니다. backend/.env 파일을 확인하세요.'
  );
}

// PostgreSQL 연결 풀 생성
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'kiwoom_trading',
  user: process.env.DB_USER || 'postgres',
  ...(dbPassword !== undefined ? { password: dbPassword } : {}),
  max: 20, // 최대 연결 수
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 연결 에러 핸들링
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;


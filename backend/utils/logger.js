const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('./appPaths');

// 로그 폴더 생성
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 서버 시작 시점의 타임스탬프로 로그 파일명 생성
const getServerStartTimestamp = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
};

// 서버 시작 시점의 로그 파일명 (서버 시작 시 한 번만 생성)
const SERVER_START_TIMESTAMP = getServerStartTimestamp();
const LOG_FILE_NAME = path.join(LOG_DIR, `server_${SERVER_START_TIMESTAMP}.log`);

// 서버 시작 시 로그 파일 초기화 (서버 시작 메시지 기록)
const initLogFile = () => {
  try {
    const startMessage = `\n${'='.repeat(80)}\n서버 시작: ${SERVER_START_TIMESTAMP}\n${'='.repeat(80)}\n\n`;
    fs.writeFileSync(LOG_FILE_NAME, startMessage, 'utf8');
  } catch (error) {
    console.error('[Logger] 로그 파일 초기화 실패:', error.message);
  }
};

// 로그 파일명 반환 (서버 시작 시점의 파일명 사용)
const getLogFileName = () => {
  return LOG_FILE_NAME;
};

// 로그 파일 초기화
initLogFile();

// 타임스탬프 포맷
const getTimestamp = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
};

// 키 이름(소문자, -/_ 제거)이 이 패턴으로 끝나면 값을 *** 로 가린다 (hasToken 같은 boolean 은 유지)
const SENSITIVE_KEY = /(secret|password|passwd|token|appkey|authorization|cookie)(encrypted)?$/;
const isSensitiveKey = (key) => SENSITIVE_KEY.test(String(key).toLowerCase().replace(/[-_]/g, ''));

const maskString = (s) =>
  s
    .replace(/(Bearer\s+)[^\s"',]+/gi, '$1***')
    .replace(/([?&](?:token|access_token)=)[^&\s"']+/gi, '$1***');

// axios 에러를 그대로 직렬화하면 요청 헤더(authorization)·본문(appkey/secretkey)이 포함된다
const summarizeAxiosError = (err) => ({
  name: 'AxiosError',
  message: err.message,
  code: err.code,
  status: err.response?.status,
  method: err.config?.method ? String(err.config.method).toUpperCase() : undefined,
  url: String(err.config?.url || '').split('?')[0] || undefined,
  data: err.response?.data,
});

const sanitize = (value, seen = new WeakSet(), depth = 0) => {
  if (typeof value === 'string') return maskString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth > 8) return '[Object]';
  seen.add(value);

  if (value.isAxiosError) return sanitize(summarizeAxiosError(value), seen, depth + 1);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => sanitize(v, seen, depth + 1));

  const out = {};
  if (value instanceof Error) {
    out.name = value.name;
    out.message = maskString(String(value.message || ''));
  }
  for (const key of Object.keys(value)) {
    const v = value[key];
    out[key] =
      isSensitiveKey(key) && v != null && typeof v !== 'boolean'
        ? '***'
        : sanitize(v, seen, depth + 1);
  }
  return out;
};

// 로그 파일에 쓰기
const writeToFile = (level, ...rawArgs) => {
  try {
    const logFile = getLogFileName();
    const timestamp = getTimestamp();
    const args = rawArgs.map((arg) => sanitize(arg));
    const message = args.map(arg => {
      if (typeof arg === 'object') {
        return JSON.stringify(arg, null, 2);
      }
      return String(arg);
    }).join(' ');
    
    const logEntry = `[${timestamp}] [${level}] ${message}\n`;
    
    // 비동기로 파일에 쓰기 (블로킹 방지)
    fs.appendFile(logFile, logEntry, (err) => {
      if (err) {
        // 파일 쓰기 실패 시 콘솔에만 출력
        console.error('[Logger] 파일 쓰기 실패:', err.message);
      }
    });
  } catch (error) {
    // 로그 파일 쓰기 중 오류 발생 시 무시 (무한 루프 방지)
  }
};

// 원본 console 메서드 저장
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug,
};

// 콘솔 출력에 타임스탬프 추가
const formatConsoleMessage = (level, ...args) => {
  const timestamp = getTimestamp();
  const prefix = `[${timestamp}] [${level}]`;
  
  if (args.length === 0) {
    return prefix;
  }
  
  // 각 인자를 포맷팅
  const formattedArgs = args.map((rawArg) => {
    const arg = sanitize(rawArg);
    if (typeof arg === 'object' && arg !== null) {
      // JSON을 예쁘게 포맷팅 (2칸 들여쓰기)
      return JSON.stringify(arg, null, 2);
    }
    return String(arg);
  });
  
  // 첫 번째 인자
  const firstArg = formattedArgs[0];
  const restArgs = formattedArgs.slice(1);
  
  // 첫 번째 인자가 여러 줄인 경우 (JSON 포맷팅된 경우)
  if (typeof firstArg === 'string' && firstArg.includes('\n')) {
    const lines = firstArg.split('\n');
    // 첫 줄에 타임스탬프 추가, 나머지 줄은 들여쓰기
    const firstLine = `${prefix} ${lines[0]}`;
    const remainingLines = lines.slice(1).map(line => `  ${line}`).join('\n');
    const result = remainingLines ? `${firstLine}\n${remainingLines}` : firstLine;
    
    // 나머지 인자가 있으면 추가
    if (restArgs.length > 0) {
      return `${result}\n${restArgs.map(arg => {
        // 나머지 인자도 여러 줄일 수 있음
        if (typeof arg === 'string' && arg.includes('\n')) {
          return arg.split('\n').map(line => `  ${line}`).join('\n');
        }
        return `  ${arg}`;
      }).join('\n')}`;
    }
    return result;
  }
  
  // 일반적인 경우 (한 줄)
  const message = formattedArgs.join(' ');
  return `${prefix} ${message}`;
};

// console.log 오버라이드
console.log = function(...args) {
  const formattedMessage = formatConsoleMessage('LOG', ...args);
  originalConsole.log(formattedMessage);
  writeToFile('LOG', ...args);
};

// console.error 오버라이드
console.error = function(...args) {
  const formattedMessage = formatConsoleMessage('ERROR', ...args);
  originalConsole.error(formattedMessage);
  writeToFile('ERROR', ...args);
};

// console.warn 오버라이드
console.warn = function(...args) {
  const formattedMessage = formatConsoleMessage('WARN', ...args);
  originalConsole.warn(formattedMessage);
  writeToFile('WARN', ...args);
};

// console.info 오버라이드
console.info = function(...args) {
  const formattedMessage = formatConsoleMessage('INFO', ...args);
  originalConsole.info(formattedMessage);
  writeToFile('INFO', ...args);
};

// console.debug 오버라이드
console.debug = function(...args) {
  const formattedMessage = formatConsoleMessage('DEBUG', ...args);
  originalConsole.debug(formattedMessage);
  writeToFile('DEBUG', ...args);
};

// 로그인/로그아웃 전용 로그 파일명
const LOGIN_LOG_FILE = path.join(LOG_DIR, 'login.log');

// 로그인/로그아웃 로그 기록 함수
// client: 'web' | 'app' | 기타
const logLogin = (action, userId, username, ip, success = true, message = '', client = '') => {
  try {
    const timestamp = getTimestamp();
    const status = success ? 'SUCCESS' : 'FAILED';
    const clientPart = client ? `, Client: ${client}` : '';
    const messagePart = message ? `, Message: ${message}` : '';
    const logEntry = `[${timestamp}] [${status}] ${action} - UserID: ${userId || 'N/A'}, Username: ${username || 'N/A'}, IP: ${ip || 'N/A'}${clientPart}${messagePart}\n`;
    
    fs.appendFile(LOGIN_LOG_FILE, logEntry, (err) => {
      if (err) {
        originalConsole.error('[Logger] 로그인 로그 파일 쓰기 실패:', err.message);
      }
    });
  } catch (error) {
    // 로그 파일 쓰기 중 오류 발생 시 무시
  }
};

// 초기화 메시지
console.log(`[Logger] 로그 파일 저장 시작: ${LOG_DIR}`);
console.log(`[Logger] 로그인 로그 파일: ${LOGIN_LOG_FILE}`);

module.exports = {
  getLogFileName,
  LOG_DIR,
  logLogin
};


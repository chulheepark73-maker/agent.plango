// 로거 초기화 (가장 먼저 로드)
require('./utils/logger');
const { ENV_FILE, FRONTEND_BUILD_DIR } = require('./utils/appPaths');
require('dotenv').config({ path: ENV_FILE });

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const marketRoutes = require('./routes/market');
const settingsRoutes = require('./routes/settings');
const indicatorTradingRoutes = require('./routes/indicatorTrading');
const holdingsRoutes = require('./routes/holdings');
const tradingV2Routes = require('./routes/tradingV2');
const watchlistV2Routes = require('./routes/watchlistV2');
const logoRoutes = require('./routes/logo');
const { attachWatchlistPriceWebSocket } = require('./services/watchlistPriceWsHub');
const { startAutoTradingWsMonitorV2 } = require('./services/autoTradingWsMonitor_v2');
const { startIndicatorWsMonitor } = require('./services/indicatorWsMonitor');
const { startIndicatorSellMonitor } = require('./services/indicatorSellMonitor');
const { startInfiniteTradeScheduler } = require('./utils/infiniteTradeScheduler');
const { ensureTradingV2Tables } = require('./utils/tradingV2Store');
const { requireRegisteredAgent } = require('./middleware/auth');

if (!process.env.CENTRAL_API_URL) {
  console.warn('⚠️  CENTRAL_API_URL 미설정 — 기본값 https://auth.plango.today 사용');
}

const app = express();
const server = http.createServer(app);
// 개발 시 프론트 dev 서버(3000)가 3001 을 가정하므로 기본값은 3001
const PORT = Number(process.env.PORT) || 3001;

// 프록시를 통한 실제 클라이언트 IP 추출을 위한 설정
// Nginx, 로드밸런서, 리버스 프록시 등을 통해 접근할 때 필요
app.set('trust proxy', true);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', requireRegisteredAgent);
app.use('/api/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/indicator-trading', indicatorTradingRoutes);
app.use('/api/holdings', holdingsRoutes);
app.use('/api/trading-v2', tradingV2Routes);
app.use('/api/watchlist-v2', watchlistV2Routes);
app.use('/api/logo', logoRoutes);
app.use('/api/subscription', require('./routes/subscription'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: '키움증권 자동매매 서버가 정상 작동 중입니다.' });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// 프론트엔드 빌드 (개발 시에는 CRA dev 서버가 따로 띄우므로 build 가 없을 수 있다)
const FRONTEND_INDEX = path.join(FRONTEND_BUILD_DIR, 'index.html');
if (fs.existsSync(FRONTEND_INDEX)) {
  app.use(express.static(FRONTEND_BUILD_DIR, { index: false }));
  app.get('*', (req, res) => {
    res.sendFile(FRONTEND_INDEX);
  });
  console.log(`[Server] 프론트엔드 제공: ${FRONTEND_BUILD_DIR}`);
} else {
  console.warn(`[Server] 프론트엔드 build 없음 — API 만 제공 (${FRONTEND_BUILD_DIR})`);
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: '서버 오류가 발생했습니다.',
    message: err.message 
  });
});

// 거래시간 상태 캐시 (최적화를 위해)
let tradingHoursCache = {
  isKRXTime: false,
  isNXTTime: false,
  lastCheckMinute: -1, // 마지막으로 체크한 분 (0-59)
  lastCheckHour: -1    // 마지막으로 체크한 시간 (0-23)
};

// 거래시간 변경 시점 (분 단위로 체크)
const TRADING_HOUR_CHANGE_POINTS = [
  { hour: 8, minute: 0 },   // NXT 시작 (08:00)
  { hour: 8, minute: 50 },   // NXT 종료 (08:50)
  { hour: 9, minute: 0 },     // KRX 시작 (09:00)
  { hour: 15, minute: 30 },  // KRX 정규장 종료 / 장후 시간외 종가 시작 (15:30)
  { hour: 16, minute: 0 },   // 시간외 종가 종료 / KRX 애프터마켓 시작 (16:00)
  { hour: 20, minute: 0 }    // KRX 애프터 종료 (20:00)
];

// 거래시간 상태를 체크해야 하는지 확인
const shouldCheckTradingHours = () => {
  const now = new Date();
  const koreaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const currentHour = koreaTime.getHours();
  const currentMinute = koreaTime.getMinutes();
  
  // 마지막 체크와 같은 분이면 체크 불필요
  if (tradingHoursCache.lastCheckHour === currentHour && 
      tradingHoursCache.lastCheckMinute === currentMinute) {
    return false;
  }
  
  // 거래시간 변경 시점인지 확인
  const isChangePoint = TRADING_HOUR_CHANGE_POINTS.some(
    point => point.hour === currentHour && point.minute === currentMinute
  );
  
  // 변경 시점이거나 아직 한 번도 체크하지 않았으면 체크 필요
  return isChangePoint || tradingHoursCache.lastCheckMinute === -1;
};

// 거래시간 상태 업데이트
const updateTradingHoursCache = () => {
  const { isNXTTradingHours, isKRXSessionOpen } = require('./utils/stockUtils');
  const now = new Date();
  const koreaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  
  tradingHoursCache.isKRXTime = isKRXSessionOpen();
  tradingHoursCache.isNXTTime = isNXTTradingHours();
  tradingHoursCache.lastCheckHour = koreaTime.getHours();
  tradingHoursCache.lastCheckMinute = koreaTime.getMinutes();
};

// ========== 공통 함수 (중복 코드 제거) ==========

attachWatchlistPriceWebSocket(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다. (0.0.0.0:${PORT})`);

  ensureTradingV2Tables().catch((err) => {
    console.error('[TradingV2] 기동 시 준비 실패:', err.message);
  });
  
  // 초기 거래시간 상태 체크
  updateTradingHoursCache();
  
  // Trading V2 — trading_plans(active) 감시 (분할/무한)
  startAutoTradingWsMonitorV2();
  // 지표기반매매 — 조건검색·트래킹·틱 매도 (레거시 auto 모니터 대체)
  startIndicatorWsMonitor();
  // 무한매매 단계별 배수 스케줄 매수 (플랜별 매수시간 KST, 기본 KR 19:00 / ETF 15:00 / US 04:00)
  startInfiniteTradeScheduler();

  // 지표기반매매 익절·손절·트레일링 자동매도 (REST 폴백 등)
  startIndicatorSellMonitor();
  
  // 토큰 자동 발급 스케줄러 시작 (매일 07:50 KST)
  const { startScheduler: startTokenScheduler } = require('./utils/tokenAutoRenewalScheduler');
  startTokenScheduler();

  // 중앙 서버 구독 동기화 (10분 간격, 구독 종료 시 자동매매 OFF)
  const { startScheduler: startSubscriptionSyncScheduler } = require('./utils/subscriptionSyncScheduler');
  startSubscriptionSyncScheduler();

  // 지표기반매매 — 장마감 미체결 매도 → open 복귀 (KRX 15:35, 전장 20:05)
  const { startScheduler: startIndicatorEodUnfilledSellScheduler } = require('./utils/indicatorEodUnfilledSellScheduler');
  startIndicatorEodUnfilledSellScheduler();

  // Trading V2 — 15:30/20:05 미체결 취소·감시원복, 16:00 애프터 세션 갱신
  const { startTradingV2EodUnfilledScheduler } = require('./utils/tradingV2EodUnfilledScheduler');
  startTradingV2EodUnfilledScheduler();

  // 지표기반매매 — 매수시간 시작 시 tracking/조건 종목 일괄 매수
  const { startScheduler: startIndicatorBuyTimeStartScheduler } = require('./utils/indicatorBuyTimeStart');
  startIndicatorBuyTimeStartScheduler();

  // 지표기반매매 — 매수종료 시 미체결 취소 후 시장가 매수
  const { startScheduler: startIndicatorBuyEndMarketFillScheduler } = require('./utils/indicatorBuyEndMarketFill');
  startIndicatorBuyEndMarketFillScheduler();

  // 지표기반매매 — 트래킹 장전 정리(08:00) + 당일 조건식 스냅샷(08:58)
  const { startScheduler: startIndicatorTrackingDailyRefresh } = require('./utils/indicatorTrackingDailyRefresh');
  startIndicatorTrackingDailyRefresh();

  // 거래시간 상태 체크 (1분마다 업데이트)
  setInterval(() => {
    updateTradingHoursCache();
  }, 60000); // 1분마다 체크
});

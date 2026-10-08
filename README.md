# 키움증권 웹 기반 자동매매 시스템

키움증권 REST API를 활용한 웹 기반 주식 자동매매 프로그램입니다.

## 주요 기능

- 📊 실시간 주식 시세 조회
- 💰 자동 매수/매도 주문
- 📈 자동매매 전략 설정 및 실행
- 📋 거래 내역 조회
- 🔐 안전한 인증 및 API 키 관리

## 기술 스택

- **Frontend**: React, Material-UI
- **Backend**: Node.js, Express
- **API**: 키움증권 REST API

## 설치 방법

1. 의존성 설치
```bash
npm run install-all
```

2. 환경 변수 설정
- `backend/.env` 파일 생성 및 중앙 서버(CENTRAL_API_URL) 설정
- `frontend/.env` 파일 생성 및 Auth 웹 URL 설정

3. 개발 서버 실행
```bash
npm run dev
```

## 환경 변수 설정

### backend/.env
```
PORT=3001
# 중앙 서버 (Auth Server). 로컬: http://localhost:3011
CENTRAL_API_URL=https://auth.plango.today
```

키움 App Key/Secret 은 환경설정 화면에서 입력하며, 텔레그램 봇 설정은 Auth Server 에만 둡니다.

### frontend/.env
```
# Auth 웹 (계정 만들기·비밀번호 찾기). 로컬: http://localhost:3010
REACT_APP_AUTH_WEB_URL=https://auth.plango.today
```

## 실행파일 배포 (Node SEA)

우분투 빌드 서버(Node 25.5+)에서 소스를 받은 뒤:

```bash
bash scripts/build-release.sh
```

`release/plango-agent-<버전>-linux-<arch>.tar.gz` 가 만들어진다. 고객 서버에서는 Node 설치 없이:

```bash
tar -xzf plango-agent-*.tar.gz && cd plango-agent
cp .env.example .env
./plango-agent
```

- 실행파일 하나가 API 와 프론트엔드(`build/`)를 같은 포트(`PORT`, 기본 3001)로 제공한다.
- `data/`(DB·agent.json), `log/` 는 실행파일 옆에 생긴다. 업데이트 시 실행파일과 `build/` 만 교체한다.
- 실행파일은 빌드한 OS/CPU 전용이다 (리눅스 x64 에서 빌드 → 리눅스 x64 고객 서버).

## 프로젝트 구조

```
kiwoom-auto-trading/
├── backend/                 # 백엔드 서버
│   ├── middleware/         # 인증 미들웨어
│   ├── routes/             # API 라우트
│   ├── services/           # 키움증권 API 서비스
│   ├── utils/              # 유틸리티 함수
│   └── server.js           # 서버 진입점
├── frontend/               # 프론트엔드 React 앱
│   ├── public/             # 정적 파일
│   └── src/
│       ├── components/     # React 컴포넌트
│       ├── contexts/       # Context API
│       └── pages/          # 페이지 컴포넌트
└── package.json            # 루트 패키지 설정
```

## 사용 방법

1. 웹 브라우저에서 `http://localhost:3000` 접속
2. 회원가입 또는 로그인 (회원가입 시 키움증권 액세스 토큰 필요)
3. 자동매매 전략 설정
4. 전략 활성화하여 자동매매 시작

## API 엔드포인트

### 인증
- `POST /api/auth/register` - 회원가입
- `POST /api/auth/login` - 로그인
- `GET /api/auth/me` - 사용자 정보 조회

### 계좌
- `GET /api/account/info` - 계좌 정보 조회
- `GET /api/account/balance` - 잔고 조회

### 시장

### 주문
- `POST /api/order/place` - 주문 실행
- `GET /api/order/history` - 주문 내역 조회

### 전략
- `GET /api/strategy` - 전략 목록 조회
- `POST /api/strategy` - 전략 생성
- `PUT /api/strategy/:id` - 전략 수정
- `DELETE /api/strategy/:id` - 전략 삭제
- `PATCH /api/strategy/:id/toggle` - 전략 활성화/비활성화

## 주의사항

⚠️ **중요**
- 실제 거래 전 충분한 테스트를 진행하세요
- API 키는 절대 공개하지 마세요
- 투자에 따른 손실은 본인의 책임입니다
- 현재 버전은 개발/테스트용이며, 실제 운영 환경에서는 데이터베이스 연동이 필요합니다
- 키움증권 REST API의 실제 엔드포인트와 인증 방식은 키움증권 공식 문서를 참고하여 수정이 필요할 수 있습니다

## 향후 개선 사항

- [ 0 ] 데이터베이스 연동 (SQLite, Node 내장 node:sqlite — Node 22.5+ 필요)
- [ ] 실시간 시세 웹소켓 연동
- [ ] 자동매매 전략 실행 엔진 구현
- [ ] 백테스팅 기능
- [ ] 알림 기능 (이메일, SMS)
- [ ] 차트 및 분석 도구



@@ 액세스 토큰 관리 에서 토큰 발급시 API 요청시퍠 에러

[0] [키움증권 API] 토큰 발급 요청: {
[0]   url: 'https://openapi.koreainvestment.com:9443/oauth2/tokenP',
[0]   appKey: '83zD...',
[0]   hasAppSecret: true
[0] }
[0] [키움증권 API] 토큰 발급 실패: {
[0]   message: 'Request failed with status code 403',
[0]   status: 403,
[0]   statusText: 'Forbidden',
[0]   data: { error_description: '유효하지 않은 AppKey입니다.', error_code: 'EGW00103' },
[0]   code: 'ERR_BAD_REQUEST'
[0] }
[0] [토큰 발급 API] 에러: {
[0]   status: 403,
[0]   message: '유효하지 않은 AppKey입니다.',
[0]   data: { error_description: '유효하지 않은 AppKey입니다.', error_code: 'EGW00103' }
[0] }




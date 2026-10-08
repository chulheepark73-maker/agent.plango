#!/usr/bin/env bash
# PlanGo Agent 배포본 만들기 (우분투 빌드 서버에서 실행, Node 25.5+ 필요)
#
#   bash scripts/build-release.sh
#
# 결과: release/plango-agent-<버전>-linux-<arch>.tar.gz
#   plango-agent/
#   ├── plango-agent   단일 실행파일 (Node 설치 불필요)
#   ├── build/         프론트엔드
#   └── .env.example   고객 서버에서 .env 로 복사해 사용
# data/, log/ 는 첫 실행 시 실행파일 옆에 자동 생성된다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
ARCH="$(uname -m)"
RELEASE_DIR="$ROOT/release"
OUT="$RELEASE_DIR/plango-agent"
TARBALL="$RELEASE_DIR/plango-agent-$VERSION-linux-$ARCH.tar.gz"

echo "[release] PlanGo Agent $VERSION (node $(node -v), $ARCH)"

rm -rf "$RELEASE_DIR"
mkdir -p "$OUT"

echo "[release] backend 의존성 설치"
(cd backend && npm ci --no-audit --no-fund)

echo "[release] frontend 빌드"
(cd frontend && npm ci --no-audit --no-fund && GENERATE_SOURCEMAP=false npm run build)

echo "[release] 실행파일 생성"
node backend/scripts/build-sea.js "$OUT"

cp -r frontend/build "$OUT/build"

cat > "$OUT/.env.example" <<'EOF'
# 이 파일을 .env 로 복사해 사용
PORT=3001
CENTRAL_API_URL=https://auth.plango.today
EOF

tar -czf "$TARBALL" -C "$RELEASE_DIR" plango-agent

echo "[release] 완료: $TARBALL"

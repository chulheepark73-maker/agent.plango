# Git 변경사항 커밋 및 Push 스크립트

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Git Commit & Push 시작" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 현재 시간
$commitTime = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# ----------------------------------------
# 1. Git Status
# ----------------------------------------
Write-Host "[1/4] Git Status 확인 중..." -ForegroundColor Yellow

git status

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "❌ Git status 실패" -ForegroundColor Red
    exit 1
}

Write-Host "✓ Git status 완료" -ForegroundColor Green
Write-Host ""

# ----------------------------------------
# 2. Git Add
# ----------------------------------------
Write-Host "[2/4] 변경사항을 Git에 추가하는 중..." -ForegroundColor Yellow

git add .

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "❌ Git add 실패" -ForegroundColor Red
    exit 1
}

Write-Host "✓ Git add 완료" -ForegroundColor Green
Write-Host ""

# ----------------------------------------
# 3. Git Commit
# ----------------------------------------
Write-Host "[3/4] Commit 중..." -ForegroundColor Yellow
Write-Host "Commit 메시지: $commitTime" -ForegroundColor Gray

git commit -m "$commitTime"

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "❌ Git commit 실패" -ForegroundColor Red
    exit 1
}

Write-Host "✓ Git commit 완료" -ForegroundColor Green
Write-Host ""

# ----------------------------------------
# 4. Git Push
# ----------------------------------------
Write-Host "[4/4] GitHub에 Push 중..." -ForegroundColor Yellow

git push

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "❌ Git push 실패" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " ✅ GitHub 업로드 완료!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Commit 시간: $commitTime" -ForegroundColor Cyan
Write-Host ""

# 최종 상태 확인
Write-Host "최종 Git 상태:" -ForegroundColor Yellow
git status

Write-Host ""
Write-Host "모든 작업이 완료되었습니다." -ForegroundColor Green
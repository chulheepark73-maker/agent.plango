# PlanGo Agent Windows release build (Node 25.5+ required)
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
#
# Output: release\plango-agent-<version>-win-<arch>.zip
#   plango-agent\
#   +-- plango-agent.exe   single executable (no Node install needed)
#   +-- build\             frontend
#   +-- .env.example       copy to .env on the customer PC
# data\ and log\ are created next to the executable on first run.
# Messages are ASCII on purpose: Windows PowerShell 5.1 misreads BOM-less UTF-8.
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Invoke-Step([string]$Label, [scriptblock]$Block) {
  Write-Host "[release] $Label"
  & $Block
  if ($LASTEXITCODE -ne 0) { throw "[release] failed: $Label (exit $LASTEXITCODE)" }
}

$Version = (node -p "require('./package.json').version").Trim()
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$ReleaseDir = Join-Path $Root 'release'
$Out = Join-Path $ReleaseDir 'plango-agent'
$Zip = Join-Path $ReleaseDir "plango-agent-$Version-win-$Arch.zip"

Write-Host "[release] PlanGo Agent $Version (node $(node -v), $Arch)"

if (Test-Path $ReleaseDir) { Remove-Item -Recurse -Force $ReleaseDir }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Invoke-Step 'backend npm ci' {
  Push-Location backend
  npm ci --no-audit --no-fund
  Pop-Location
}

$env:GENERATE_SOURCEMAP = 'false'
try {
  Invoke-Step 'frontend build' {
    Push-Location frontend
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -eq 0) { npm run build }
    Pop-Location
  }
} finally {
  Remove-Item Env:GENERATE_SOURCEMAP -ErrorAction SilentlyContinue
}

Invoke-Step 'build executable' { node backend/scripts/build-sea.js $Out }

Copy-Item -Recurse (Join-Path $Root 'frontend\build') (Join-Path $Out 'build')

@(
  '# Copy this file to .env',
  'PORT=3001',
  'CENTRAL_API_URL=https://auth.plango.today'
) | Set-Content -Encoding ascii (Join-Path $Out '.env.example')

Compress-Archive -Path $Out -DestinationPath $Zip -Force

Write-Host "[release] done: $Zip"

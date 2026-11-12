# start-worker.ps1 - Start the persistent Kilo Bridge worker.
# Requires workerEnabled=true (set explicitly after reviewing the security model).
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-worker.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $root "dist/cli.js"))) {
    Write-Host "dist/cli.js not found - building first..."
    pnpm build
    if ($LASTEXITCODE -ne 0) { Write-Error "build failed."; exit 1 }
}

# Surface the worker-enabled state before starting.
$cfg = node dist/cli.js configure --json | ConvertFrom-Json
if (-not $cfg.workerEnabled) {
    Write-Warning "workerEnabled is false. The worker will refuse to start."
    Write-Warning "After reviewing docs/security-model.md, enable it with:"
    Write-Warning "  node dist/cli.js configure set workerEnabled true"
}

Write-Host "Starting Kilo Bridge worker (Ctrl+C to stop gracefully)..."
node dist/cli.js start
exit $LASTEXITCODE
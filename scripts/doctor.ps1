# doctor.ps1 - Run environment / authentication readiness checks.
#   powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $root "dist/cli.js"))) {
    Write-Host "dist/cli.js not found - building first..."
    pnpm build
    if ($LASTEXITCODE -ne 0) { Write-Error "build failed."; exit 1 }
}

node dist/cli.js doctor
exit $LASTEXITCODE
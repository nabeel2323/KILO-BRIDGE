# stop-worker.ps1 - Request graceful shutdown of the running worker.
# The worker finishes the current cycle, releases leases/lock, then exits.
#   powershell -ExecutionPolicy Bypass -File .\scripts\stop-worker.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

node dist/cli.js stop
$code = $LASTEXITCODE
if ($code -eq 0) {
    Write-Host "Shutdown requested. Check state with: node dist/cli.js status"
}
exit $code
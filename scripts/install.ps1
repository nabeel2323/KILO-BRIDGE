# install.ps1 - Install dependencies, build, and initialize Kilo Bridge.
# Windows PowerShell 5.1+ compatible. Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Kilo Bridge install - root: $root"

function Require-Command($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Error "$name not found on PATH. $hint"
        exit 1
    }
}

Require-Command "node" "Install Node.js >= 22 from https://nodejs.org."
Require-Command "pnpm" "Install pnpm: npm install -g pnpm."
Require-Command "git"  "Install Git for Windows."

Write-Host "node: $(node --version)"
Write-Host "pnpm: $(pnpm --version)"
Write-Host "git:  $(git --version)"

Write-Host "`n[1/3] Installing dependencies..."
pnpm install
if ($LASTEXITCODE -ne 0) { Write-Error "pnpm install failed."; exit 1 }

Write-Host "`n[2/3] Building..."
pnpm build
if ($LASTEXITCODE -ne 0) { Write-Error "build failed."; exit 1 }

Write-Host "`n[3/3] Initializing Bridge..."
node dist/cli.js init
if ($LASTEXITCODE -ne 0) { Write-Error "init failed."; exit 1 }

Write-Host "`nInstall complete. Next:"
Write-Host "  .\scripts\doctor.ps1                 # verify environment"
Write-Host "  gh auth login                        # authenticate GitHub"
Write-Host "  node dist/cli.js projects add examples/projects/scs-platform.json"
Write-Host "  node dist/cli.js github bootstrap scs-platform"
Write-Host "  node dist/cli.js configure set workerEnabled true   # after review"
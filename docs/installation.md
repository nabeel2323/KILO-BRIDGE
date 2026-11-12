# Installation Guide

## Prerequisites

- Windows 11
- Node.js >= 22 (verified with v26.4.0)
- pnpm (verified with 9.15.9)
- Git (verified with 2.45.2)
- GitHub CLI (`gh`) — installed and authenticated
- Kilo CLI (`@kilocode/cli`) — installed and authenticated

## Install tools

```powershell
# GitHub CLI (if missing)
winget install --id GitHub.cli --silent --accept-package-agreements --accept-source-agreements

# Kilo CLI (if missing)
npm install -g @kilocode/cli

# Authenticate
gh auth login          # GitHub.com → HTTPS → browser
kilo auth login        # follow the Kilo provider flow
```

> If `gh` is installed but not on your current session's PATH, open a new terminal, or set `GH_BIN` to the full path (e.g. `C:\Program Files\GitHub CLI\gh.exe`). The Bridge also auto-detects the default install path.

## Install Kilo Bridge

```powershell
cd C:\TAIF\KILO-BRIDGE
pnpm install
pnpm build
node dist/cli.js init
node dist/cli.js doctor
```

Or use the PowerShell helper:

```powershell
.\scripts\install.ps1
```

`init` creates `data/`, `logs/`, `reports/`, the SQLite database, and `bridge.config.json`. `doctor` verifies node, git, gh (+auth), kilo, and the database.

## Register your first project

```powershell
node dist/cli.js projects add examples/projects/scs-platform.json
node dist/cli.js projects validate examples/projects/scs-platform.json
node dist/cli.js github bootstrap scs-platform
```

## Enable the worker (explicit, after review)

```powershell
# Review the security model first: docs/security-model.md
node dist/cli.js configure set workerEnabled true
node dist/cli.js start
```

Until `workerEnabled` is explicitly set to `true`, `start` and `worker start` (without `--dry-run`) refuse to run.

## Verify the installation

```powershell
pnpm test          # full automated suite
node dist/cli.js worker start --dry-run    # safe discovery, no execution
```

## Uninstall

Remove the `C:\TAIF\KILO-BRIDGE` directory. Project worktrees live under each project's configured `worktreeRoot` (e.g. `C:\TAIF\_kilo-worktrees\<project>`); remove them with `git worktree remove` from the project repository if desired. The Bridge never modifies your project repositories' main working trees.
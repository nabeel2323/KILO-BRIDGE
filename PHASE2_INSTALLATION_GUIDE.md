# Kilo Bridge V1.0 — Installation Guide

## Prerequisites

| Tool | Minimum Version | Installation |
|---|---|---|
| Node.js | v22+ | https://nodejs.org/ |
| npm | bundled with Node | bundled |
| pnpm | v9+ | `npm install -g pnpm` |
| git | v2+ | https://git-scm.com/ |
| gh CLI | v2+ | https://cli.github.com/ |
| kilo CLI | v7+ | https://kilo.ai/ |

## Installation Steps

### 1. Clone or Copy the Repository

```powershell
# Kilo Bridge is already at:
C:\TAIF\KILO-BRIDGE
```

### 2. Install Dependencies

```powershell
cd C:\TAIF\KILO-BRIDGE
pnpm install
```

### 3. Build

```powershell
pnpm run build
pnpm run build:test
```

### 4. Install gh CLI and Authenticate

```powershell
# Download and install gh CLI
# Then authenticate:
gh auth login
```

Verify authentication:
```powershell
gh auth status
gh api user --jq .login
```

Expected output: `nabeel2323`

### 5. Install kilo CLI and Configure

```powershell
# Install kilo CLI (see https://kilo.ai/)
kilo --version
kilo auth list
```

### 6. Initialize Kilo Bridge

```powershell
# Set the bridge root (default: C:\TAIF\KILO-BRIDGE)
$env:KILO_BRIDGE_ROOT = "C:\TAIF\KILO-BRIDGE"

# Initialize bridge (creates data/logs/reports directories, SQLite DB, config)
node dist\cli.js init
```

Expected output:
```
Kilo Bridge initialized.
Bridge root: C:\TAIF\KILO-BRIDGE
Run 'kilo-bridge doctor' to verify the environment.
```

### 7. Verify Installation

```powershell
node dist\cli.js doctor
```

Expected output:
```
Kilo Bridge doctor:
  [OK ] node: v26.4.0
  [OK ] git: git version 2.45.2.windows.1
  [OK ] gh: gh version 2.61.0
  [OK ] kilo: 7.8.27
  [OK ] sqlite: database open
All checks passed.
```

Note: `gh` and `kilo` may show as not installed if not on PATH. This is non-fatal.

### 11. Security Configuration (Critical — Required Before Autonomous Execution)

The Bridge writes deny-by-default permission configs, but Kilo's global
configuration (`~/.config/kilo/config.json`) may override them with
`bash: "allow"`. Before enabling the worker, you MUST configure kilo's
automation permissions.

#### Create automation-only Kilo configuration

The Bridge provides `config/kilo-automation.jsonc` (deny-by-default).
The Bridge sets `KILO_CONFIG` to point to it when spawning kilo
subprocesses. This does NOT modify your ordinary VS Code Kilo global
configuration.

Verify the file exists:
```powershell
Get-Content config\kilo-automation.jsonc
```

It must contain `"bash": "deny"`, `"external_directory": "deny"`, and
`"*"`: `"deny"`.

#### Verify effective permissions

Run kilo config check from the Bridge directory with the automation env:
```powershell
$env:KILO_CONFIG = "C:\TAIF\KILO-BRIDGE\config\kilo-automation.jsonc"
$env:KILO_NO_DAEMON = "1"
kilo config check
```

Note: `kilo debug config` may still show the global config in kilo v7.8.27
(`kilo debug config` does not reflect `KILO_CONFIG` in this version).
The Bridge sets `KILO_CONFIG` and `KILO_NO_DAEMON` explicitly on every
Kilo subprocess.

#### Do not enable worker until security is verified

`workerEnabled` is `false` by default. Do NOT set it to `true` until you
have confirmed:
1. `config/kilo-automation.jsonc` exists with `"bash": "deny"`
2. `kilo-bridge github bootstrap <project>` has created kilo:* labels
3. A free or paid kilo model is available for execution

### 12. Register a Project

Create a project configuration JSON:

```json
{
  "id": "my-project",
  "name": "My Project",
  "repository": "owner/my-repo",
  "localPath": "C:\\TAIF\\my-project",
  "baseBranch": "develop",
  "releaseBranch": "main",
  "worktreeRoot": "C:\\TAIF\\_kilo-worktrees\\my-project",
  "branchPrefix": "ai/kilo",
  "allowedAuthors": ["owner"],
  "verificationCommands": ["pnpm lint", "pnpm typecheck", "pnpm test:unit", "pnpm build"],
  "advisoryCommands": ["pnpm format:check"],
  "state": "active"
}
```

Register it:
```powershell
node dist\cli.js projects add '<json>'
```

Or use a template:
```powershell
node dist\cli.js projects template node
```

### 9. Bootstrap GitHub Labels

```powershell
node dist\cli.js github bootstrap scs-platform
```

This creates the kilo:* labels (`kilo:ready`, `kilo:claimed`, `kilo:running`, `kilo:report-ready`, `kilo:publish-approved`, `kilo:published`, `kilo:failed`).

### 10. Enable Worker (When Ready)

```powershell
node dist\cli.js configure set workerEnabled true
```

**WARNING**: Do not enable the worker until security remediation is complete (see Security Audit Report).

## Directory Structure After Init

```
C:\TAIF\KILO-BRIDGE\
├── dist/                 # Compiled CLI output
├── dist-test/            # Compiled test output
├── src/                  # TypeScript source
├── tests/                # Test source
├── data/
│   └── kilo-bridge.sqlite
├── logs/
│   ├── kilo-bridge-debug.log
│   ├── kilo-bridge-info.log
│   ├── kilo-bridge-warn.log
│   └── kilo-bridge-error.log
├── reports/
│   └── verification/
├── bridge.config.json
└── data/
    └── worker.lock       # Created when worker runs
```

## Commands Reference

| Command | Description |
|---|---|
| `kilo-bridge init` | Initialize bridge (db, dirs, config) |
| `kilo-bridge doctor` | Verify environment |
| `kilo-bridge configure set <key> <value>` | Set config key |
| `kilo-bridge start` | Start continuous worker |
| `kilo-bridge stop` | Stop worker |
| `kilo-bridge status` | Show worker and project status |
| `kilo-bridge worker start [--once|--dry-run|--continuous] [--project <id>]` | Run worker poll |
| `kilo-bridge worker stop` | Stop worker |
| `kilo-bridge github bootstrap <project>` | Bootstrap GitHub labels |
| `kilo-bridge github test <project>` | Test GitHub auth |
| `kilo-bridge tasks [project] [status]` | List tasks |
| `kilo-bridge task <id>` | Show task details |
| `kilo-bridge logs <id>` | Show task logs |
| `kilo-bridge reports <id>` | Show task reports |
| `kilo-bridge verify --project <id>` | Run verification |
| `kilo-bridge projects list|add|validate|enable|disable|inspect|template` | Project management |

All commands support `--json` for structured output.
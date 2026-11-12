# Windows Configuration Guide

## Bridge root

The Bridge lives in `C:\TAIF\KILO-BRIDGE`. Relocate it by setting `KILO_BRIDGE_ROOT` before running any command:

```powershell
$env:KILO_BRIDGE_ROOT = "D:\kilo-bridge"
node dist/cli.js init
```

## Configuration file

`bridge.config.json` (created by `init`):

```json
{
  "dataDir": "C:\\TAIF\\KILO-BRIDGE\\data",
  "dbPath": "C:\\TAIF\\KILO-BRIDGE\\data\\kilo-bridge.sqlite",
  "logsDir": "C:\\TAIF\\KILO-BRIDGE\\logs",
  "reportsDir": "C:\\TAIF\\KILO-BRIDGE\\reports",
  "worktreeRoot": "C:\\TAIF\\_kilo-worktrees",
  "pollIntervalMs": 30000,
  "defaultTaskTimeoutMs": 21600000,
  "ghEnabled": false,
  "kiloEnabled": false,
  "workerEnabled": false
}
```

Edit safely with:

```powershell
node dist/cli.js configure set workerEnabled true
node dist/cli.js configure set pollIntervalMs 60000
node dist/cli.js configure set defaultTaskTimeoutMs 7200000
```

Keys are validated; unknown keys and invalid values are rejected.

## Environment variables

| Variable | Purpose |
|---|---|
| `KILO_BRIDGE_ROOT` | Override the Bridge root directory |
| `GH_BIN` | Full path to `gh.exe` if not on PATH |
| `KILO_BIN` | Full path to the Kilo executable if not on PATH |

## PATH notes (Windows)

- `gh` installed via winget lands in `C:\Program Files\GitHub CLI\`. The machine PATH is updated, but **already-open terminals do not see it**. Open a new terminal, or set `GH_BIN`. The Bridge auto-falls-back to the default install path.
- `kilo` and `pnpm` are npm `.cmd` shims. The Bridge uses `cross-spawn`, which resolves them correctly without a shell.

## PowerShell

All scripts are PowerShell-compatible (Windows PowerShell 5.1+). Use `;` not `&&` as a statement separator. Example:

```powershell
node dist/cli.js init; node dist/cli.js doctor
```

## Long paths

Worktree paths can get deep (`C:\TAIF\_kilo-worktrees\<project>\<project>-ai-kilo-issue-N`). If you hit Windows path-length limits, enable long paths:

```powershell
# Administrator
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1
git config --system core.longpaths true
```

## Dedicated worker account (recommended for production)

For stronger isolation, run the worker under a dedicated standard Windows account with no production credentials and restricted filesystem permissions. See [security model](security-model.md). Worktrees alone are **not** OS-level isolation.
# Kilo Bridge V1.0 — Operations Guide

## Worker Lifecycle

### Starting the Worker

```powershell
# Start continuous worker (detached process, runs in background)
node dist\cli.js start

# Start single poll (mock mode)
node dist\cli.js worker start --once

# Start dry-run (discover + validate, no Kilo execution)
node dist\cli.js worker start --dry-run

# Start continuous worker for specific project
node dist\cli.js worker start --continuous --project scs-project
```

### Stopping the Worker

```powershell
# Request graceful shutdown
node dist\cli.js stop

# Or via worker subcommand
node dist\cli.js worker stop
```

### Checking Status

```powershell
# Show worker state and project list
node dist\cli.js status

# JSON output
node dist\cli.js status --json
```

Example output:
```
Worker: RUNNING (pid=12345, workerId=bridge-worker, heartbeat=2026-11-13T01:00:00.000Z)
Projects:
  [active] scs-platform (nabeel2323/scs-platform) @ C:\TAIF\scs-platform
Total: 1
```

## Worker Behavior

### Polling Interval

The worker polls at the interval configured in `bridge.config.json`:
- Default: 30,000 ms (30 seconds)
- Configure: `node dist\cli.js configure set pollIntervalMs 60000`

### Worker Lock

A file-based lock (`data/worker.lock`) prevents concurrent workers:
- Contains PID, workerId, and heartbeat
- Stale locks (older than 30 minutes) are auto-recovered
- Lock is released on graceful shutdown

### Task Flow

1. **Discovery**: Polls GitHub for issues labeled `kilo:ready`
2. **Claim**: Claims task with 10-minute TTL lease
3. **Execution**: Creates isolated worktree, runs Kilo CLI
4. **Verification**: Runs project verification commands
5. **Report**: Generates markdown report, posts to GitHub issue
6. **Publishing** (optional): If `kilo:publish-approved` label, commits and pushes feature branch, opens draft PR

### Task Statuses

| Status | Meaning |
|---|---|
| READY | Discovered, waiting to be claimed |
| CLAIMED | Claimed by worker, lease active |
| RUNNING | Kilo execution in progress |
| REPORT_READY | Execution complete, report generated |
| CHANGES_REQUESTED | Correction requested, awaiting re-execution |
| PUBLISH_APPROVED | Publishing approved |
| PUBLISHED | Feature branch pushed, draft PR opened |
| DONE | Task complete |
| FAILED | Execution failed |
| BLOCKED | Task blocked |

## GitHub Integration

### Label Bootstrap

```powershell
node dist\cli.js github bootstrap scs-platform
```

Creates these labels:
- `kilo:ready` — Task ready for processing
- `kilo:claimed` — Task claimed by worker
- `kilo:running` — Kilo execution in progress
- `kilo:report-ready` — Report generated
- `kilo:publish-approved` — Publishing approved
- `kilo:published` — Published to feature branch
- `kilo:failed` — Execution failed

### Creating a Task

1. Create an issue in the GitHub repository
2. Add the `kilo:ready` label
3. Ensure the issue author is in the project's `allowedAuthors`
4. The worker will discover and execute the task on the next poll

### Corrections

To request changes to a completed task:
1. Add a comment to the issue
2. Add the `kilo:changes-requested` label
3. The worker will detect the new comment and re-execute the task

## Security

### Worker is Disabled by Default

`workerEnabled` is `false` in `bridge.config.json`. Do not set it to `true` until:
1. `config/kilo-automation.jsonc` exists with `"bash": "deny"` (deny-by-default)
2. GitHub labels are bootstrapped (`kilo-bridge github bootstrap <project>`)
3. A kilo model is available for execution

### Enable Worker

```powershell
node dist\cli.js configure set workerEnabled true
```

### Disable Worker

```powershell
node dist\cli.js configure set workerEnabled false
```

### Kilo Permission Configuration

The Bridge uses two permission configurations:

| File | Purpose | Set By |
|---|---|---|
| `config/kilo-automation.jsonc` | Automation-only deny-by-default config, passed via `KILO_CONFIG` env var | Bridge (pre-built) |
| `WORKTREE_PATH\.kilo\kilo.jsonc` | Project-level permission config written to each worktree | Bridge (during task execution) |

Both use deny-by-default: `"*"`: `"deny"`, `"bash": "deny"`,
`"external_directory": "deny"`, with explicit allows for `read`,
`glob`, `grep`, `edit`, `write`, `apply_patch`, `lsp`, `todoread`,
`todowrite`.

The Bridge does NOT modify the user's ordinary VS Code Kilo global
configuration (`~/.config/kilo/config.json`). The global config may
contain `"bash": "allow"` which overrides project-level settings in
kilo v7.8.27 (`kilo debug config` does not reflect `KILO_CONFIG`).
The Bridge sets `KILO_CONFIG` and `KILO_NO_DAEMON=1` on every Kilo
subprocess to direct it to the automation config.

### Secret Protection

Protected patterns (blocked from publishing and Kilo access):
- `.env`, `.env.*`
- `*.pem`, `*.key`
- `test-token.txt`
- `secrets/**`
- `credentials/**`
- `bridge.config.json`
- `data/kilo-bridge.sqlite`
- `.git/**`
- `node_modules/**`

Secret redaction in all persisted logs: `ghp_*`, `github_pat_*`,
`sk-*` tokens are redacted; git SHAs are preserved.

### Verification Engine Command Deny-List

The Bridge independently runs verification commands (outside Kilo).
The following are always denied:
- `db:migrate`, `db:seed`, `db:reset`
- `infra:up`, `infra:down`
- `git push`, `git commit`, `git merge`
- `gh auth login`
- `rm -rf`

The Bridge invokes `SecurityManager.isCommandDenied()` before every
verification command execution.

## Logs

Logs are written to `logs/kilo-bridge-<level>.log`:

| File | Contents |
|---|---|
| kilo-bridge-debug.log | Debug messages |
| kilo-bridge-info.log | Informational messages |
| kilo-bridge-warn.log | Warnings |
| kilo-bridge-error.log | Errors |

Read recent logs:
```powershell
# Not available via CLI yet; read files directly
Get-Content logs\kilo-bridge-error.log -Tail 50
```

## Recovery

### Expired Lease Recovery

If a worker crashes mid-task, leases expire after 10 minutes. On the next poll:
1. Expired CLAIMED/RUNNING tasks are recovered to READY
2. Tasks with `attempt >= MAX_TASK_ATTEMPTS` (default 3) are marked FAILED
3. Recovered tasks are re-executed

### Stale Lock Recovery

If the worker.lock file exists but the heartbeat is older than 30 minutes, the lock is considered stale and a new worker can acquire it.

## Windows-Specific Notes

- Process termination uses `taskkill /F /T /PID <pid>`
- Path resolution uses Windows drive letters (e.g., `C:\TAIF\...`)
- File locking uses simple file existence (no OS-level locking)
- PowerShell is used for notifications (disabled by default)

## Troubleshooting

| Issue | Solution |
|---|---|
| `gh: command not found` | Install GitHub CLI and add to PATH |
| `kilo: command not found` | Install Kilo CLI and add to PATH |
| `worker is disabled` | Set `workerEnabled: true` in bridge.config.json |
| `worker already running` | Wait for lock to expire (30 min) or delete `data/worker.lock` |
| `GitHub not authenticated` | Run `gh auth login` |
| `Kilo CLI not installed` | Install Kilo CLI |
| `PROJECT_NOT_FOUND` | Register the project first with `projects add` |
| `WORKTREE_NOT_ISOLATED` | Ensure localPath and worktreeRoot don't contain each other |
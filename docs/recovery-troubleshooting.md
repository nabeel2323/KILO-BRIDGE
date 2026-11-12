# Recovery & Troubleshooting

## Diagnostic first steps

```powershell
node dist/cli.js doctor            # environment + auth checks
node dist/cli.js status            # worker / projects / task counts
node dist/cli.js task <id>         # where is the task stuck?
node dist/cli.js logs <id>         # execution + verification detail
```

`doctor` checks: node, git, gh (+ default-install-path fallback), gh-auth, kilo, sqlite, worker-enabled.

## Common issues

### `gh` not recognized
The GitHub CLI install dir (`C:\Program Files\GitHub CLI\`) is on the machine PATH but not in already-open terminals. Open a new terminal, or set `GH_BIN`. The Bridge auto-falls-back to the default install path.

### `GH_NOT_AUTHENTICATED`
Run `gh auth login` (GitHub.com → HTTPS → browser). Verify with `gh auth status` and `node dist/cli.js github test <project>`.

### `KILO_NOT_FOUND`
`kilo` is an npm `.cmd` shim. Ensure it is on PATH or set `KILO_BIN` to the full `.cmd` path.

### Kilo run fails with 402 / 404
- **402 "Paid Model – Credits Required"** — the Kilo Gateway account has no credits. Add credits or use a free model (`kilo/kilo-auto/free`).
- **404 "Function not found for account"** — the default NVIDIA provider model is unavailable. Set a working `kiloModel`.
- Check `kilo models` and `kilo auth list`.

### Task is `BLOCKED`
A precondition failed. Read the transition reason (`task <id>`):
- `ORIGIN_MISMATCH` — the local repo's `remote.origin.url` does not match the registered repository. Fix the remote or the config.
- `PERMISSION_DENIALS_MISSING` / `PERMISSION_CHECK_FAILED` — the worktree `kilo.json` failed verification. Do not bypass; investigate tampering or a Kilo schema change.
- Worktree/branch conflict — a previous attempt's branch or worktree still exists. Remove the stale worktree (`git worktree remove`) and branch, then retry.

### Task is `FAILED`
Kilo exited non-zero or timed out. `logs <id>` shows the exit code, duration, and error. A failure report is still posted to the issue. Fix the cause and re-trigger (authorized comment + `kilo:changes-requested`, or let lease recovery re-queue it).

### Report is `PARTIAL`
Required verification did not all pass, or no files changed. This is intentional — the Bridge never claims COMPLETE when required tests failed or did not run. Inspect `logs <id>` and the verification output files under `reports/verification/<taskId>/`.

### Worker won't start: `WORKER_ALREADY_RUNNING`
Another worker holds `data/worker.lock`. If it crashed, the lock is stale (heartbeat older than 2× poll interval) and is taken over automatically. To force-clear a dead lock, delete `data/worker.lock` only after confirming no worker process is alive.

### Worker won't start: `WORKER_DISABLED`
Expected. Enable explicitly after review: `configure set workerEnabled true`. (`worker start --dry-run` works while disabled.)

## Crash recovery

State is persisted on every write, so a crash or reboot loses nothing:

- On the next poll, `recoverExpiredLeases` returns expired `CLAIMED`/`RUNNING` tasks to `READY` (attempt < 3) or `FAILED` (attempt ≥ 3).
- Idempotency keys prevent duplicate tasks on re-discovery.
- The singleton lock's heartbeat allows stale-lock takeover.

No manual database surgery is required for normal crash recovery.

## Windows-specific notes

- **libuv exit assertion** — the CLI sets `process.exitCode` and lets the event loop drain instead of calling `process.exit()` during pending pipe writes (avoids `UV_HANDLE_CLOSING` / `0xC0000409`).
- **git dubious ownership** — the Bridge passes `-c safe.directory=<dir>` per command; it never modifies stored git config.
- **Long paths** — enable `LongPathsEnabled` and `git config --system core.longpaths true` if worktree paths exceed limits.
- **Process-tree kill** — timeouts use `taskkill /F /T /PID` so child shells are not orphaned.

## Getting more detail

- Event logs: `<worktree>/.kilo-bridge/kilo-events-*.json` (reasoning removed, secrets redacted).
- Verification output: `reports/verification/<taskId>/<id>.stdout.txt` / `.stderr.txt`.
- Reports: `reports/<taskId>/attempt-<n>-<execId>.md`.
- Audit trail: `audit_log` table (discovery, rejection, claim, failure, recovery, config changes).
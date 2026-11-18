# Operations Manual

Day-to-day operation of the Kilo Bridge worker on Windows.

## First-time setup (checklist)

1. Install prerequisites — see [installation](installation.md).
2. `node dist/cli.js init`
3. `node dist/cli.js doctor` — resolve every `[FAIL]`.
4. `gh auth login` — see [GitHub authentication](github-authentication.md).
5. Register only the intended project — `node dist/cli.js projects add <your-project-config.json>`.
6. `node dist/cli.js github bootstrap <project-id>` — creates the ten `kilo:*` labels.
7. Review the [security model](security-model.md).
8. **Explicitly** enable the worker: `node dist/cli.js configure set workerEnabled true`.

The worker never starts unattended processing merely because the app was installed. `workerEnabled` defaults to `false` and must be set deliberately. The separate `githubIntakeEnabled` gate also defaults to `false`; it is not the generic worker and must remain disabled until its dedicated intake service has passed its own release verification.

## Running the worker

### Persistent (production)

```powershell
node dist/cli.js start
# or
.\scripts\start-worker.ps1
```

Runs the polling loop until stopped. Singleton lock at `data/worker.lock` (pid + heartbeat); a second worker refuses to start (`WORKER_ALREADY_RUNNING`) unless the lock is stale.

### Single poll (manual / scheduled)

```powershell
node dist/cli.js worker start                 # one real poll across active projects
node dist/cli.js worker start --project <project-id>
node dist/cli.js worker start --dry-run       # discover only, no execution (works even when disabled)
node dist/cli.js worker start --mock          # mock Kilo + permission check skipped
```

`worker start` (without `--dry-run`) requires `workerEnabled=true`.

## Stopping

```powershell
node dist/cli.js stop          # writes data/worker.stop; worker exits after the current cycle
# or
.\scripts\stop-worker.ps1
```

`Ctrl+C` (SIGINT) / SIGTERM also trigger graceful shutdown. The worker finishes the in-flight cycle, releases leases and the lock, then exits. It never leaves a task mid-transition.

## Monitoring

```powershell
node dist/cli.js status                 # worker running? projects? task counts by status
node dist/cli.js tasks                  # all tasks
node dist/cli.js task <id>              # one task + transition history
node dist/cli.js logs <id>              # executions + verification results
node dist/cli.js reports <id>           # report files + posted comment ids
node dist/cli.js status --json          # machine-readable
```

Logs are JSON lines under `logs/` (per level). Windows balloon notifications fire on task completion when enabled.

## Polling & rate limits

- Default interval: **30 s** (`pollIntervalMs`). Change with `configure set pollIntervalMs 60000`.
- The provider classifies GitHub rate-limit responses (`RATE_LIMITED`); the worker backs off and retries next poll. Check quota with `github test <project> --json`.

## Re-running verification

```powershell
node dist/cli.js verify --project <project-id>
```

Re-runs the configured suite against the latest `REPORT_READY` task's worktree and stores fresh verification records. Never trusts prior agent results.

## Publishing (controlled)

Publishing is off by default. To allow it for a project:

1. Set `publishingEnabled: true` in the project config and re-register.
2. On a `REPORT_READY` issue whose required verification passed, add the `kilo:publish-approved` label.
3. The next poll commits, pushes the feature branch, and opens a **draft** PR to the base branch, then comments the PR URL and labels `kilo:published`.

The Bridge never merges, never pushes `main`/`develop`/release, and refuses if prohibited files are present. See [security model](security-model.md).

## Configuration reference

`bridge.config.json` keys editable via `configure set`: `workerEnabled`, `githubIntakeEnabled`, `githubIntakeAllowedRepositories` (JSON array of exact `owner/repo` strings), `pollIntervalMs`, `defaultTaskTimeoutMs`, `ghEnabled`, `kiloEnabled`. The intake gate defaults to false and the allowlist defaults to empty. The two switches are independent. See [Windows configuration](windows-configuration.md).

## Operational boundaries

- No public HTTP server, tunnel, or webhook listener. GitHub Issues/Comments are the transport.
- Polling is a persistent handoff, not live streaming.
- The worker should run under a dedicated standard Windows account in production.
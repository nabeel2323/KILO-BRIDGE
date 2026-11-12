# Task Lifecycle Reference

A task is one GitHub issue processed for one project. Its lifecycle is a state machine persisted in SQLite, with every transition recorded and every claim protected by a lease.

## States

`READY → CLAIMED → RUNNING → REPORT_READY → (CHANGES_REQUESTED → RUNNING)* → PUBLISH_APPROVED → PUBLISHED → DONE`

Terminal/side states: `BLOCKED`, `FAILED`.

| State | Meaning | GitHub label |
|---|---|---|
| `READY` | Discovered, authorized, not yet claimed | `kilo:ready` |
| `CLAIMED` | A worker holds a lease | `kilo:claimed` |
| `RUNNING` | Kilo is executing in a worktree | `kilo:running` |
| `REPORT_READY` | Report posted; awaiting review/correction/publish | `kilo:report-ready` |
| `BLOCKED` | A precondition failed (origin, permissions, worktree) | `kilo:blocked` |
| `FAILED` | Execution failed or timed out | `kilo:failed` |
| `CHANGES_REQUESTED` | Authorized follow-up received; new attempt starting | `kilo:changes-requested` |
| `PUBLISH_APPROVED` | Publishing authorized and gates passed | `kilo:publish-approved` |
| `PUBLISHED` | Draft PR opened | `kilo:published` |
| `DONE` | Closed out | `kilo:done` |

## Allowed transitions

Enforced by `LifecycleManager` (`ILLEGAL_TRANSITION` otherwise):

```
(new)            → READY
READY            → CLAIMED
CLAIMED          → RUNNING
RUNNING          → REPORT_READY | BLOCKED | FAILED
REPORT_READY     → CHANGES_REQUESTED | PUBLISH_APPROVED | DONE
CHANGES_REQUESTED→ RUNNING
PUBLISH_APPROVED → PUBLISHED
PUBLISHED        → DONE
BLOCKED          → RUNNING        (retry after fix)
FAILED           → RUNNING        (retry after fix)
CLAIMED          → READY | FAILED (lease recovery)
RUNNING          → READY | FAILED (lease recovery)
```

Every transition is appended to `task_transitions` (from, to, reason, actor, timestamp) and the task row is updated and persisted immediately.

## Idempotency

`idempotencyKey = sha256(projectId + ":" + issueNumber)`. Discovery skips any issue whose key already exists, so re-polling never creates duplicate tasks. The same issue number in two projects yields two distinct keys.

## Leases

- TTL: **10 minutes** (`LEASE_TTL_MS`).
- `claimTask` sets `leaseHolder` + `leaseExpiresAt` and transitions `READY → CLAIMED`.
- A valid lease held by **another** worker is never stolen (`LEASE_HELD`).
- Re-claiming your own valid lease is idempotent (returns the task).
- `releaseLease` clears the holder in a `finally` block after every execution — success or failure.

## Attempts and corrections

- Attempt 1 is the initial execution. `claimTask` does **not** bump the attempt counter.
- An authorized follow-up comment on a `REPORT_READY` issue labeled `kilo:changes-requested` triggers `beginCorrection`: `REPORT_READY → CHANGES_REQUESTED → RUNNING`, attempt + 1, a **new branch/worktree** (`ai/kilo/issue-N-attempt-K`). Previous reports are preserved.
- Only comments from `allowedAuthors`, newer than `lastCommentId`, and not Bridge-authored (no `[kilo-bridge-report]` marker) are accepted. Unauthorized comments are audited and ignored.

## Crash recovery

Before claiming new work each poll, `recoverExpiredLeases` scans `CLAIMED`/`RUNNING` tasks whose lease expired:

- attempt `< MAX_TASK_ATTEMPTS` (3) → back to `READY` for re-execution.
- attempt `>= 3` → `FAILED` (no infinite retry).

Because every mutation is persisted to disk immediately, leases and transitions survive a process crash or machine reboot.

## Report status vs task status

The **report** status (`COMPLETE` / `PARTIAL` / `BLOCKED` / `FAILED`) is computed independently of the agent:

- `FAILED` — Kilo timed out or exited non-zero.
- `PARTIAL` — required verification did not all pass, **or** no files changed.
- `COMPLETE` — exit 0 **and** every required verification passed **and** changes exist.

The **task** then moves to `REPORT_READY` (for COMPLETE/PARTIAL) or `FAILED`. A task is never `COMPLETE` when required tests failed or did not run.

## Inspecting a task

```powershell
node dist/cli.js tasks                 # all tasks
node dist/cli.js tasks scs-platform    # one project
node dist/cli.js task <taskId>         # state + full transition history
node dist/cli.js logs <taskId>         # executions + verification results
node dist/cli.js reports <taskId>      # report files + posted comment ids
```
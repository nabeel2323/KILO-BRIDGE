# Architecture Overview

Kilo Bridge is a configuration-driven, multi-project coordinator. Components are independent and wired through explicit interfaces so the GitHub transport can later be replaced by an authenticated MCP integration without rewriting the execution engine.

## Components

| Component | File | Responsibility |
|---|---|---|
| Project Registry | `src/components/registry.ts` | Register/validate/enable/disable/inspect projects; structural validation; config templates |
| GitHub Communication Provider | `src/components/github.ts` | Authenticated `gh api` transport: issues, comments, labels, draft PRs, rate limits |
| Task Queue & Lifecycle Manager | `src/components/lifecycle.ts` | Atomic transitions, persistent leases, idempotency keys, correction attempts, lease recovery |
| Local Worker | `src/components/worker.ts` | Legacy polling loop, execution pipeline, corrections, publishing orchestration, singleton lock, graceful shutdown |
| Kilo CLI Adapter | `src/components/kilo.ts` | Preflight (detect/help/auth/model/agent), safe argv construction, event parsing, session capture, redaction |
| Git Worktree Manager | `src/components/worktree.ts` | Origin verification, base SHA recording, isolated worktrees, change inventory, Bridge-owned commit/push |
| Security & Permission Manager | `src/components/security.ts` | Deny-by-default `kilo.json` generation, denial verification, Bridge command policy, path guards, redaction |
| Independent Verification Engine | `src/components/verification.ts` | Config-driven command suites, required/advisory/conditional checks, timeouts, prohibited-command blocking |
| Report Generator | `src/components/report.ts` | Per-execution Markdown reports, GitHub comment bodies, COMPLETE gating |
| SQLite Persistence Layer | `src/db.ts` | sql.js (WASM SQLite) with persist-on-write, migrations, audit log |
| CLI Administration | `src/cli.ts`, `src/app.ts` | Human + `--json` output, all admin commands |
| Logging & Notifications | `src/components/logging.ts` | JSON line logs per level, Windows balloon notifications |
| Publishing Manager | `src/components/publishing.ts` | Approval enforcement, prohibited-file scan, commit/push/draft PR |
| Process Runner | `src/components/process.ts` | cross-spawn execution, capture, timeout, process-tree kill |

## Data flow (one task)

1. **Discover**: worker polls `GET repos/{o}/{r}/issues?state=open&labels=kilo:ready` via `gh api --paginate`. PRs are filtered out; only authorized authors pass.
2. **Claim**: idempotency key `sha256(projectId:issueNumber)` prevents duplicates; a persistent lease (10 min TTL) prevents concurrent execution. Transition `READY → CLAIMED` is recorded in SQLite and persisted immediately.
3. **Isolate**: fetch `origin/<baseBranch>`, record base SHA, create `ai/kilo/issue-N[-attempt-K]` and a worktree under the project's worktree root. Conflicts stop safely.
4. **Secure**: write `kilo.json` (deny-by-default) + `bridge.command-policy.json` into the worktree; verify required denials; run `kilo config check`. Refuse execution on any failure.
5. **Execute**: `kilo run --auto --format json --dir <worktree> --title "GitHub Issue #N" "<spec>"` as a child process with explicit argv, captured stdout/stderr, configurable timeout, process-tree kill.
6. **Verify**: run the project's configured verification commands independently of the agent. Record command, start/end, exit code, duration, output paths.
7. **Report**: write a per-execution Markdown report, post a compact comment (with `[kilo-bridge-report]` marker) to the issue, transition to `REPORT_READY` (or `BLOCKED`/`FAILED`), sync labels.
8. **Follow-up**: authorized comments + `kilo:changes-requested` trigger a new attempt (new branch/worktree, previous reports preserved).
9. **Publish**: only with `kilo:publish-approved` + project `publishingEnabled` + passing required verification + clean prohibited-file scan. The Bridge commits, pushes the feature branch, opens a **draft** PR to the configured base branch. Never merges.

## Persistence

SQLite via `sql.js` (WASM). Mutations are persisted to disk on writes. Schema migrations are versioned via `PRAGMA user_version` (currently v4). Tables: `projects`, `tasks`, `task_transitions`, `executions`, `verifications`, `reports`, `security_policies`, `audit_log`, `meta`.

## Transport abstraction

`GitHubProvider` is the only component that knows about GitHub. The worker depends on its method surface (issues/comments/labels/PRs), not on `gh` specifics. A future MCP transport can implement the same surface.

## What V1 deliberately does NOT do

- No public HTTP server, tunnel, webhook listener, or remote execution endpoint.
- No live streaming claims — polling is a persistent handoff mechanism.
- No OS-level isolation claims — worktrees are filesystem isolation, not a sandbox. The worker should eventually run under a dedicated standard Windows account (see [security model](security-model.md)).

## GitHub intake and Control Center roadmap status

The configuration schema now defines two separate operational controls:

- `workerEnabled`: existing generic worker gate; unchanged.
- `githubIntakeEnabled`: dedicated autonomous intake gate; defaults to `false`.
- `githubIntakeAllowedRepositories`: exact `owner/repo` allowlist; defaults to an empty array.

The dedicated intake service and Control Center are still under implementation. Configuring either intake value does not start polling today. The service must remain disabled until its own implementation and runtime acceptance are complete. See the [implementation plan](github-control-center-implementation-plan.md) and [progress tracker](github-control-center-implementation-progress.md).

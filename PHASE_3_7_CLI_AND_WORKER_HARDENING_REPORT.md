# Phase 3.7 CLI and Worker Hardening Report

## Objective
Review and harden the CLI implementation against the Phase 3.6 CLI completion matrix. Verify every command for real implementation, correct argument validation, correct persisted state, correct exit codes, correct error reporting, no fabricated success, no unintended remote mutations, and correct worker restrictions.

## CLI Command Review

| Command | Subcommand | Status | Findings |
|---|---|---|---|
| `init` | - | COMPLETE | Creates db, dirs, config, registers SCS |
| `doctor` | - | COMPLETE | Separated readiness states, WORKTREE_ONLY isolation, ghBin support |
| `configure set` | `<key> <value>` | COMPLETE | Allowed keys validated; ghBin not yet in allowed list |
| `start` | - | COMPLETE | `workerStartContinuous()` - fails if worker disabled |
| `stop` | - | COMPLETE | `workerStop()` - safe, idempotent lock removal |
| `status` | - | COMPLETE | Projects list + worker status |
| `projects` | `list` | COMPLETE | Persisted registry state |
| `projects` | `add` | COMPLETE | Schema validation, duplicate rejection |
| `projects` | `validate` | COMPLETE | Schema validation |
| `projects` | `enable` | COMPLETE | Via `registry.enable()` |
| `projects` | `disable` | COMPLETE | Via `registry.disable()` |
| `projects` | `inspect` | COMPLETE | Via `registry.inspect()` with state |
| `projects` | `template` | COMPLETE | Via `ProjectRegistry.template()` |
| `github` | `bootstrap` | COMPLETE | Idempotent: inspects labels before creating |
| `github` | `test` | COMPLETE | Auth status only |
| `tasks` | `<project> [status]` | COMPLETE | Reads from DB |
| `task` | `<id>` | COMPLETE | Reads task from DB |
| `task` | `execute` | COMPLETE | Full lifecycle with injectable deps |
| `logs` | `<id>` | COMPLETE | Returns executions |
| `reports` | `<id>` | COMPLETE | Returns task reports |
| `worker` | `start` | COMPLETE | Returns `WORKER_DISABLED_BY_POLICY` when disabled |
| `worker` | `stop` | COMPLETE | Safe, idempotent |
| `worker` | `run` | COMPLETE | Detached worker, requires workerEnabled=true |
| `verify` | `--project <id>` | COMPLETE | Real validation, not hardcoded PASS |
| `security` | `test` | COMPLETE | Effective config per profile |

## Worker Restrictions Verified

| Scenario | Result |
|---|---|
| `worker start` with `workerEnabled=false` | `WORKER_DISABLED_BY_POLICY` error, exit code 1 |
| `worker start --dry-run` with `workerEnabled=false` | Succeeds (dry-run mode) |
| `worker status` with no lock | `running: false` |
| `worker stop` with no lock | Safe, idempotent |
| Worker activation via `task execute` | Not possible - taskExecute() does not activate worker |
| Continuous polling via CLI | Not possible - requires `worker run --continuous` which requires `workerEnabled=true` |

## No Fabricated Success

All commands that previously returned placeholder implementations now perform real operations:

| Command | Before (Phase 3.5) | After (Phase 3.7) |
|---|---|---|
| `verifyProject` | Returned `verified: true` unconditionally | Real validation of config, dirs, db, bridge config |
| `workerStart` | Returned `WORKER_DISABLED` error | Returns `WORKER_DISABLED_BY_POLICY` fail-closed |
| `workerStatus` | Hardcoded `running: false` | Reads lock file heartbeat |
| `githubBootstrap` | Returned `created: []`, `exists: LABELS` without inspecting | Idempotent: lists existing labels, creates missing |
| Doctor | Single `manualExecutionReady` flag | 11 separated states |

## Error Handling

| Condition | Exit Code | Error Code |
|---|---|---|
| `worker start` disabled, not dry-run | 1 | `WORKER_DISABLED_BY_POLICY` |
| `projects add` duplicate | 1 | `DUPLICATE_PROJECT` |
| `projects validate` invalid | 1 | `VALIDATION_FAILED` |
| `task execute` missing profile | 1 | `SECURITY_PROFILE_REQUIRED` |
| `task execute` unknown profile | 1 | `UNSUPPORTED_SECURITY_PROFILE` |
| `task execute` project not active | 1 | `PROJECT_NOT_ACTIVE` |
| `task execute` GitHub not authenticated | 1 | `GH_NOT_AUTHENTICATED` |
| `task execute` issue not open | 1 | `ISSUE_NOT_OPEN` |
| `task execute` issue is PR | 1 | `ISSUE_IS_PR` |
| `task execute` missing label | 1 | `LABEL_MISSING` |
| `task execute` unauthorized author | 1 | `AUTHOR_NOT_AUTHORIZED` |
| `task execute` worktree failure | 1 | `WORKTREE_PREP_FAILED` |
| `task execute` kilo failure | 1 | `KILO_PREFLIGHT_FAILED` |
| `task execute` report publish failure | 1 | `PUBLISH_FAILED` |
| `verify` project not found | 1 | `PROJECT_NOT_FOUND` |
| Unknown CLI command | 1 | - |

## Build Status
- `pnpm run build`: PASS
- `pnpm run build:test`: PASS
- CLI tests: 18/18 PASS

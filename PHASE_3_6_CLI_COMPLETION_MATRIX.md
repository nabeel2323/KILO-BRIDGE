# Phase 3.6 CLI Completion Matrix

## CLI Command Completion Status

| Command | Subcommand | Status | Implementation | Notes |
|---|---|---|---|---|
| `init` | - | COMPLETE | `app.init()` | Creates db, dirs, config, registers SCS |
| `doctor` | - | COMPLETE | `app.doctor()` | Separated readiness states, WORKTREE_ONLY isolation |
| `configure set` | `<key> <value>` | COMPLETE | Direct file write | Allowed keys: pollIntervalMs, defaultTaskTimeoutMs, ghEnabled, kiloEnabled, workerEnabled |
| `start` | - | COMPLETE | `app.workerStartContinuous()` | Fails if worker disabled |
| `stop` | - | COMPLETE | `app.workerStop()` | Safe, idempotent lock removal |
| `status` | - | COMPLETE | `app.projectsList()` + `app.workerStatus()` | Reports actual worker state |
| `projects` | `list` | COMPLETE | `app.projectsList()` | Returns persisted registry state |
| `projects` | `add` | COMPLETE | `app.projectsAdd()` | Validates schema, rejects duplicates |
| `projects` | `validate` | COMPLETE | `app.projectsValidate()` | Validates project config schema |
| `projects` | `enable` | COMPLETE | `app.projectsEnable()` | Via `registry.enable()` |
| `projects` | `disable` | COMPLETE | `app.projectsDisable()` | Via `registry.disable()` |
| `projects` | `inspect` | COMPLETE | `app.projectsInspect()` | Via `registry.inspect()` with state |
| `projects` | `template` | COMPLETE | `app.projectsTemplate()` | Via `ProjectRegistry.template()` |
| `github` | `bootstrap` | COMPLETE | `app.githubBootstrap()` | Idempotent: inspects labels before creating |
| `github` | `test` | COMPLETE | `app.githubTest()` | Auth status only, no remote mutations |
| `tasks` | `<project> [status]` | COMPLETE | `app.tasksList()` | Reads from DB |
| `task` | `<id>` | COMPLETE | `app.taskGet()` | Reads task from DB |
| `task` | `execute` | COMPLETE | `app.taskExecute()` | Full lifecycle with injectable deps |
| `logs` | `<id>` | COMPLETE | `app.taskLogs()` | Returns executions |
| `reports` | `<id>` | COMPLETE | `app.taskReports()` | Returns task reports |
| `worker` | `start` | COMPLETE | `app.workerStart()` | Returns WORKER_DISABLED_BY_POLICY when disabled |
| `worker` | `stop` | COMPLETE | `app.workerStop()` | Safe, idempotent |
| `worker` | `run` | COMPLETE | Internal detached worker | Requires workerEnabled=true |
| `verify` | `--project <id>` | COMPLETE | `app.verifyProject()` | Real validation, not hardcoded PASS |
| `security` | `test` | COMPLETE | `app.securityTest()` | Effective config per profile |

## Stub/Placeholder Elimination

| Previously Stubbed | Before | After |
|---|---|---|
| `verifyProject` | Returned `verified: true` unconditionally | Real validation of config, dirs, db, bridge config |
| `workerStart` | Returned `WORKER_DISABLED` error | Returns `WORKER_DISABLED_BY_POLICY` fail-closed |
| `workerStatus` | Hardcoded `running: false` | Reads lock file heartbeat, reports actual state |
| `githubBootstrap` | Returned `created: []`, `exists: LABELS` without inspecting | Idempotent: lists existing labels, creates missing |
| Doctor states | Single `manualExecutionReady` flag | 11 separated states |

## Commands That Return Non-Zero Without Working

| Command | Condition | Exit Code | Message |
|---|---|---|---|
| `worker start` | workerEnabled=false, not dry-run | 1 | `WORKER_DISABLED_BY_POLICY` |
| `projects add` | Duplicate project id | 1 | `DUPLICATE_PROJECT` |
| `projects validate` | Invalid config | 1 | `VALIDATION_FAILED` |
| `task execute` | Missing security profile | 1 | `SECURITY_PROFILE_REQUIRED` |
| `task execute` | Unknown security profile | 1 | `UNSUPPORTED_SECURITY_PROFILE` |
| `task execute` | Project not active | 1 | `PROJECT_NOT_ACTIVE` |
| `verify` | Project not found | 1 | `PROJECT_NOT_FOUND` |

## Test Results
- `cli.test.ts`: 18/18 PASS
- Full suite: 177/177 PASS

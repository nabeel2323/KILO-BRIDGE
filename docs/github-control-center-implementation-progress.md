# GitHub Control Center and Intake — Implementation Progress

**Tracker version:** 1.0  
**Status:** IN PROGRESS — Phase 0 safety hardening is CI-verified; Phase 1 config, schema-v5 claims, intake service, and SQL.js stale-snapshot protection are committed; integration and runtime proof remain open  
**Repository:** `nabeel2323/KILO-BRIDGE`  
**Branch:** `v1-implementation`  
**Baseline commit reviewed:** `e3ecd61d5eb77befcb8169069019d9f44b7cf769`  
**Related Issue:** [#1 — GitHub-Centric Control Center and Isolated GitHub Intake](https://github.com/nabeel2323/KILO-BRIDGE/issues/1)  
**Last updated:** 2026-11-19

> This is the active implementation record. A checkbox is marked complete only when its evidence is recorded. Source inspection, code authoring, automated tests, integration tests, and real runtime verification are tracked separately.

## 1. Overall status

| Phase | Description | Status | Completion |
|---|---|---|---:|
| 0 | Repository boundary, baseline, and safety remediation | PARTIAL | 85% |
| 1 | Configuration and durable data contracts | IN PROGRESS | 70% |
| 2 | Dedicated GitHub intake service | PARTIAL | 35% |
| 3 | Shared execution, evidence, and GitHub reconciliation | IN PROGRESS | 10% |
| 4 | Control Center backend and security | IN PROGRESS | 45% |
| 5 | Control Center UI and live operations | PARTIAL | 30% |
| 6 | Integration, hardening, and independent verification | PARTIAL | 10% |
| 7 | Documentation and release readiness | NOT STARTED | 0% |

**Overall completion:** approximately 30% (repository safety remediation, independent intake gate, schema-v5 durable claims, fail-closed intake source, SQL.js stale-snapshot protection, authenticated loopback Control Center server, database-backed read APIs, initial browser UI, CLI setup/start commands, operations documentation, and regression tests are committed. Database and Control Center tests are authored but the new commits do not yet have verified CI execution evidence. No end-to-end GitHub intake dispatch or generalized Sandbox task execution is complete).

## 2. Confirmed repository baseline

- [x] Confirmed repository identity: `nabeel2323/KILO-BRIDGE`.
- [x] Confirmed implementation branch: `v1-implementation`.
- [x] Recorded branch baseline commit: `e3ecd61d5eb77befcb8169069019d9f44b7cf769`.
- [x] Inspected `AGENTS.md`, `package.json`, `src/config.ts`, `src/app.ts`, `src/db.ts`, `src/types.ts`, `src/cli.ts`, `src/components/worker.ts`, `src/components/github.ts`, and `src/components/lifecycle.ts`.
- [x] Confirmed the database uses `sql.js`; schema migration v5 now adds durable repository/Issue/assignment-generation claims.
- [x] Confirmed `githubIntakeEnabled` and an explicit empty-by-default repository allowlist are now in the configuration schema.
- [x] Confirmed the existing worker combines GitHub discovery/label changes with correction and execution workflows.
- [x] Confirmed the repository already has Node `node:test` suites for worker/database behavior.
- [x] Created the phased implementation plan and this tracker.

## 3. Active findings / risks

| ID | Severity | Finding | Required action | Status |
|---|---|---|---|---|
| KB-IMPL-001 | CRITICAL | `KiloBridgeApp.init()` previously defaulted `registerScs=true`; CLI initialization enabled registration for the default Bridge root and contained a hard-coded `scs-platform` mapping. SCS-specific example and operational references also existed in Kilo Bridge. | Remove implicit project registration; make init neutral; preserve existing project records; never open the SCS path. | SOURCE + REGRESSION TESTS VERIFIED IN CI |
| KB-IMPL-002 | HIGH | Dedicated intake gate and repository trust allowlist were absent from the configuration schema. | Add false-by-default gate, empty-by-default allowlist, and independent tests. | CONFIG SOURCE + GATE REGRESSION VERIFIED IN CI; INTAKE END-TO-END OPEN |
| KB-IMPL-003 | HIGH | Existing `Worker` combines polling, claim labels, correction processing, and execution. | Extract shared execution from discovery; do not use Worker as the new intake service. | OPEN — execution pipeline extraction still required |
| KB-IMPL-004 | CRITICAL | `SqliteStore` uses in-memory `sql.js` snapshots. A stale process could previously export over newer file state even with a unique claim index. | Serialize file replacement with an exclusive lock, compare the on-disk SHA-256 with the loaded snapshot, atomically replace via a same-directory temporary file, and invalidate stale instances on conflict. Add true child-process and restart tests before enabling intake. | CODE + REGRESSION TEST COMMITTED (`b3af31f`, `3be9bea`); WINDOWS CI / MULTI-PROCESS RUNTIME EVIDENCE PENDING |
| KB-IMPL-007 | CRITICAL | `launchWindowsSandbox()` is a fixed fixture-based smoke harness, while `Worker.executeTask()` launches Kilo directly on the host. No production task execution is currently wired through a generalized Windows Sandbox runner. | Implement a per-execution Windows Sandbox task runner, secure provider connectivity, guest evidence validation, artifact/diff collection, and fail-closed behavior. Until then, production isolated auto-execution is NOT READY. | OPEN |
| KB-IMPL-008 | HIGH | The hosted Windows CI runner does not have the user's configured native Kilo installation or a provisioned Windows Sandbox runtime. Five environment-dependent tests skip; green CI is not evidence of a real guest task. | Preserve skips as skips; run native Kilo and real Sandbox verification on the user's Windows machine after general task runner implementation, using only a disposable test repo. | OPEN |
| KB-IMPL-005 | HIGH | No local Control Center existed in the inspected baseline. | Add authenticated loopback server, read APIs, UI, audited settings APIs, and live updates. | LOOPBACK SERVER + READ APIs + INITIAL UI + CLI + TEST SOURCE COMMITTED; TEST EXECUTION / SETTINGS MUTATIONS / SSE OPEN |
| KB-IMPL-006 | MEDIUM | GitHub source access does not execute arbitrary commands on the operator's Windows machine. | Use Windows CI for code regression and reserve actual native Kilo/Sandbox verification for the user's machine. | CI path established; host verification still open |

## 4. Phase 0 checklist — safety and baseline

- [x] Confirm repository and branch boundary.
- [x] Inspect initialization, config, storage, worker, GitHub provider, and CLI source.
- [x] Identify implicit SCS registration path without accessing the SCS workspace.
- [x] Remove implicit SCS registration from app and CLI initialization (source change committed; runtime test pending).
- [x] Add CLI regression assertions for an empty registry after init and no SCS doctor check (verified by Windows CI).
- [x] Add a hard `workerEnabled` guard at the beginning of public `Worker.pollOnce()` before lease recovery, GitHub access, or task changes.
- [x] Guard `Worker.startContinuous()` so it refuses to start when `workerEnabled=false`.
- [x] Add regression test proving one-shot polling and continuous startup produce zero GitHub calls, zero Kilo launches, and zero new tasks when disabled.
- [x] Audit and close the correction-execution bypass: correction processing is reachable only after the guarded poll entry point.
- [x] Remove the SCS-specific sample project configuration from Kilo Bridge; generic Node/Django/Laravel/etc. project examples remain.
- [ ] Confirm fixtures use only disposable local repositories and fake GitHub endpoints.
- [x] Run Windows GitHub Actions CI: typecheck passed; full suite passed with 250 pass, 0 fail, 5 skipped, 255 total (run `44413204159`). Skips are environment-dependent native Kilo checks; they are not counted as runtime passes.
- [ ] Run the generalized Sandbox task executor on the user's Windows host after implementation; hosted CI is not a substitute.

## 5. Phase implementation checklists

### Phase 1 — Configuration and durable data contracts

- [x] Add `githubIntakeEnabled: false` to schema/defaults (commit `219caa4`).
- [x] Add explicit `githubIntakeAllowedRepositories`, default empty, with owner/repo validation and duplicate rejection.
- [x] Keep `workerEnabled` unchanged and separately exposed; CLI tests assert intake configuration does not enable the worker.
- [x] Add CLI configuration support for the boolean gate and JSON-array repository allowlist.
- [x] Add forward-only DB migration v5 for durable repository + Issue + assignment-generation claim identity (commit `d1f1ebc`).
- [x] Add durable claim state, owner/token, lease, task association, and reconciliation status persistence (commit `d1f1ebc`).
- [x] Add intake poll lock, stale-owner reconciliation, unique-claim index, and unit coverage (commits `34a958f`, `d1f1ebc`, `076e599`).
- [x] Add SQL.js file-level writer lock, SHA-256 snapshot compare, temp-file atomic replacement, and stale-store invalidation (commit `b3af31f`).
- [x] Add stale-snapshot regression test authored (commit `3be9bea`); execution evidence is pending.
- [x] Add a true child-process writer test using Node `-e`, with independent PID and database module (commit `0d57999`).
- [x] Add a separate-PID child-process regression test for stale snapshot protection (commit `0d57999`).
- [ ] Run full Windows CI for database persistence commits and capture the exact test/build result.

### Phase 2 — Dedicated GitHub intake

- [x] Add an independent `GitHubIntakeService` source implementation with a dedicated `githubIntakeEnabled` gate (commit `076e599`).
- [x] Filter to explicit repository allowlist and exactly one active project mapping per repository.
- [x] Enforce open Issue, PR exclusion, ready label, author allowlist, bounded title/body, canonical GitHub Issue URL, and fresh Issue re-fetch before claim.
- [x] Persist claim before GitHub label mutation; move uncertain failures to `RECONCILIATION_REQUIRED`.
- [x] Refuse automatic relaunch when a claim already exists or a dispatch outcome is uncertain.
- [x] Add disabled-gate, execution-readiness, eligibility, and worker-gate-independence unit tests (commits `076e599`, `8d6c9eb`).
- [ ] Wire the service into `KiloBridgeApp` / CLI lifecycle using a real production-isolated dispatcher; current dispatcher is an interface injected by a caller and no runtime wiring has been verified.
- [ ] Reconcile terminal execution outcomes, report comments, correction requests, and report-marker filtering.
- [ ] Verify automatic polling end-to-end on a disposable repository only after the generalized sandbox task runner is ready.

### Phase 3 — Shared execution and feedback

- [ ] Extract shared execution service from generic worker.
- [ ] Preserve Kilo policy, worktree, verification, and Windows Sandbox code paths.
- [ ] Persist execution ID and stage evidence durably.
- [ ] Reconcile labels/comments after terminal outcomes and restarts.
- [ ] Add failure, timeout, incomplete-guest-evidence, and comment-post recovery tests.
- [ ] Ensure no implicit publish, merge, or deployment.

### Phase 4 — Control Center backend/security

- [x] Add explicit loopback-only HTTP server bound to `127.0.0.1` (commit `197cea3`).
- [x] Add first-run one-time bootstrap token, scrypt password derivation, server-side sessions, and logout (commit `197cea3`).
- [x] Add exact Host/Origin validation and per-session CSRF enforcement (commit `197cea3`).
- [x] Add request-size limits, login throttling, CSP/security headers, safe errors, and non-loopback rejection (commits `197cea3`, `fdc1716`).
- [x] Add data APIs for dashboard, projects, task pages/detail, executions, verifications, intake claims, settings view, and audit read model (commit `197cea3`; bounded task-page DB method `3a18cd4`).
- [x] Omit local filesystem paths, claim tokens, raw audit detail, and secret-like error values from read models.
- [ ] Add audited operator configuration mutation APIs and route-specific authorization policy.
- [ ] Execute the Control Center security tests on Windows CI and verify cookie/browser behavior on the local Windows host.

### Phase 5 — Control Center UI/live operations

- [x] Implement initial dashboard with actual persisted project/task/claim counts and independent gate state (commit `d20a938`).
- [x] Implement project and trusted-author read view (filesystem paths omitted).
- [x] Implement persisted GitHub intake claim queue.
- [x] Implement task detail with body, lifecycle, execution, verification, and report summaries.
- [x] Implement read-only review center and audit view.
- [x] Implement read-only settings view that states intake runtime is unavailable and does not enable either gate.
- [ ] Implement audited project/trust configuration changes and intake gate settings after dispatcher safeguards are in place.
- [ ] Implement SSE or replay-safe polling/live updates; initial UI currently refreshes on demand.
- [ ] Verify empty, failed, blocked, report-ready, large-list, and responsive states on a browser.

### Phase 6 — Integration and independent verification

- [x] Author Control Center tests for one-time token, password hashing, session issuance, loopback bind, authentication, Origin/CSRF, DB read models, path omission, and fail-closed settings mutation (`tests/control-center.test.ts`, commit `2502b05`).
- [x] Author separate-process SQL.js stale-writer regression (`tests/db.test.ts`, commit `0d57999`).
- [ ] Execute new Control Center/database tests and capture exact pass/fail/skip results.
- [ ] Add migration/restart/concurrency tests beyond current test coverage.
- [x] Add Windows CI workflow for typecheck/build/test (workflow run pending; no result claimed).
- [ ] Add prompt-injection and workspace-boundary tests.
- [ ] Test only against dedicated disposable GitHub repository or controlled fixtures.
- [ ] Run one actual native Kilo + generalized Windows Sandbox task in the disposable test environment. The existing fixed-fixture guest smoke harness is not acceptable as this evidence.
- [ ] Verify execution ID, guest stages, exit code, artifacts, and hashes.
- [ ] Run full typecheck/build/test suite and record exact counts.
- [ ] Verify both worker and intake gates remain false after test completion.

### Phase 7 — Documentation and release readiness

- [ ] Update architecture and developer guide.
- [ ] Update installation, configuration, and authentication instructions.
- [x] Add Control Center first-run, security, usage, limitations, and troubleshooting guide (`docs/control-center-operations.md`, commit `8ca8f0f`); link from README (commit `80a6e5e`).
- [ ] Update remaining operations, security, recovery, troubleshooting, and testing guides.
- [ ] Update release notes and operator enablement/disablement procedure.
- [ ] Record limitations, rollback, and recovery steps.
- [ ] Complete final release-gate report with separate implementation/test/runtime evidence.

## 6. Verification evidence log

| Date | Phase | Command / activity | Result | Evidence / notes |
|---|---|---|---|---|
| 2026-11-19 | 0 | GitHub repository and branch inspection | PASS | Repository `nabeel2323/KILO-BRIDGE`, branch `v1-implementation`, baseline `e3ecd61d5eb77befcb8169069019d9f44b7cf769`. |
| 2026-11-19 | 0 | Source inspection | PARTIAL | Key source files inspected; identified default SCS registration, missing intake gate, coupled worker flow, schema v4. |
| 2026-11-19 | 0/1/6 | Windows CI | PASS | Actions run `44413204159` on commit `c26b50ae42c1ccb63c8dcdec8148f70a5753378f`: install succeeded, TypeScript typecheck succeeded, full suite 255 tests / 250 pass / 0 fail / 5 skipped. The 5 skips are native Kilo host-dependent tests. |
| 2026-11-19 | 0 | Phase 0.1 source update | PARTIAL | Commit `d9fb2093c16d4ad74367f2900b62c032d2ca7d4f`: removed app-level SCS auto-registration and doctor check; removed CLI SCS defaults and updated CLI regression expectations. Runtime verification is pending CI. |
| 2026-11-19 | 1 | Intake gate + allowlist configuration | VERIFIED IN CI | Commit `219caa499c0c40d893dd737f611f74a8754fb2e0`: added false-by-default gate, empty repo allowlist, Zod validation, CLI configuration, doctor diagnostics, tests, and docs; suite green in Actions run `44413204159`. |
| 2026-11-19 | 0 | Worker disabled-state hardening | VERIFIED IN CI | Commit `c26b50ae42c1ccb63c8dcdec8148f70a5753378f`: direct polling now stops before any side effect and continuous start refuses disabled config; regression test passed in run `44413204159`. |
| 2026-11-19 | 6 | Windows CI workflow | PASS | Workflow `.github/workflows/ci.yml`; run `44413204159` succeeded with 250 pass / 0 fail / 5 skipped on commit `c26b50a`. This predates the latest intake and database-concurrency commits. |
| 2026-11-19 | 1/2 | Durable claims + fail-closed intake source | SOURCE COMMITTED | Schema-v5 claim table, repository-scoped unique key, intake poll lock, eligibility checks, claim-before-label ordering, reconciliation-required state, and gate-independence tests. Commits `d1f1ebc`, `34a958f`, `076e599`, `8d6c9eb`. |
| 2026-11-19 | 1 | SQL.js stale-snapshot persistence guard | SOURCE + TEST COMMITTED; TEST EXECUTION PENDING | Commits `b3af31f` and `3be9bea`: exclusive persistence lock, SHA-256 compare-and-swap guard, same-directory temp file + rename, no close-time snapshot export, stale-instance refusal, and stale-writer regression test. Connected GitHub status endpoint returned no statuses for latest commit and exposed no push-triggered workflow run; no local Windows execution was performed. |
| 2026-11-19 | 1 | Separate-process stale writer regression | TEST SOURCE COMMITTED; EXECUTION PENDING | Commit `0d57999` spawns a separate Node process against the same SQL.js file, writes through a distinct process snapshot, then verifies the parent stale writer is rejected and the child's committed value survives reopen. Windows CI result is not yet available through the connected status/run endpoints. |
| 2026-11-19 | 4/5 | Local Control Center backend and initial UI | SOURCE + TESTS + DOCS COMMITTED; TEST EXECUTION PENDING | Server/read-model/CLI/UI commits: `197cea3`, `fdc1716`, `8772b65`, `d20a938`, `1f8377e`; tests `2502b05`; task paging `3a18cd4`; operator guide `8ca8f0f`; README link `80a6e5e`. Auth is one-time-token + scrypt + in-memory session; loopback/Host/Origin/CSRF/request limit/CSP protections are implemented in source. UI is read-only and explicitly reports intake runtime unavailable. No CI/test execution is claimed for these commits. |

### Runtime evidence inherited from earlier operator verification

The earlier project conversation reported that native Kilo integration scenarios (read/write/edit/search) passed with a local test provider and that a real Windows Sandbox guest read scenario passed with structured guest evidence. This is historical operator-reported evidence, not a new run during the present implementation session. The earlier evidence did not establish that the new GitHub intake service or Control Center exists or is runtime-verified.

## 7. Change log

| Date | Change | Evidence |
|---|---|---|
| 2026-11-19 | Created phased implementation plan and progress tracker. | Plan and tracker files in `docs/`. |
| 2026-11-19 | Removed implicit SCS project registration and SCS CLI defaults. | `d9fb2093c16d4ad74367f2900b62c032d2ca7d4f`; CI verification pending. |
| 2026-11-19 | Added independent GitHub intake config gate and empty trusted-repository allowlist. | `219caa499c0c40d893dd737f611f74a8754fb2e0`; CLI/config tests authored, CI pending. |
| 2026-11-19 | Added Windows CI workflow and removed SCS-specific sample project config. | Workflow `6fe896474782150ccc33336b4113d94986c7f879`; sample removal `9e7c1c9af8e758dca4f6fba1afa41c138a351315`. |
| 2026-11-19 | Recorded findings KB-IMPL-001 through KB-IMPL-008. | Source inspection, CI evidence, and execution/isolation-path audit. |

## 8. Current next implementation slice

**Phase 3.1 — Implement the generalized Windows Sandbox task runner and a shared execution contract.**

The SQL.js writer guard and separate-process regression source are committed, but test execution evidence remains pending. Keep the intake gate false and do not wire a real dispatcher until this is verified.

The production-execution blocker remains `WindowsSandboxTaskRunner`: current `launchWindowsSandbox()` is a fixture smoke harness, while generic worker execution still launches Kilo on the host. The next slice must stage a real per-execution worktree and task spec, launch the native Kilo runtime in a disposable guest, provide narrowly scoped provider connectivity without copying long-lived credentials, validate a matching execution-ID result manifest and artifact hashes, import only safe workspace changes, and clean up fail-closed on any missing evidence.

The Control Center backend/UI are a read-only foundation. The next web slice after execution wiring is audited settings mutation, SSE/replay, and browser-level verification.

Required files likely include:
- `src/components/isolation.ts`
- new `src/components/taskSandbox.ts` / shared execution service
- `src/components/githubIntake.ts` and `src/app.ts` (only after a real dispatcher exists)
- `tests/` runtime/isolation and Control Center suites
- `docs/control-center-operations.md` and architecture/recovery docs

Implementation constraints:
- Remove the `registerScs` default behavior and hard-coded sample project creation.
- Keep normal initialization idempotent and neutral.
- Preserve any already persisted user projects rather than deleting records.
- Do not open, validate, enumerate, or modify the configured SCS local path.
- Add regression tests for both explicit custom Bridge roots and the default root.
- Run targeted tests/build on the Windows development environment before marking this slice complete.

## 9. Status definitions

- **NOT STARTED:** no implementation work has begun.
- **IN PROGRESS:** source changes are underway; exit criteria are not yet met.
- **BLOCKED:** a concrete dependency or safety issue prevents the next action.
- **PARTIAL:** implementation exists but evidence/acceptance criteria are incomplete.
- **COMPLETE:** all phase exit criteria are met and evidence is recorded.
- **DEFERRED:** intentionally postponed with an explicit rationale and owner decision.

A phase is never COMPLETE solely because a source file was edited or a report was written.

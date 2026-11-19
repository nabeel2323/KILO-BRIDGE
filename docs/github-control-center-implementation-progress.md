# GitHub Control Center and Isolated Intake — Progress Tracker

**Tracker version:** 2.0  
**Status:** SOURCE INTEGRATION IMPLEMENTED; WINDOWS CI GREEN; REAL GUEST ACCEPTANCE PENDING  
**Repository:** nabeel2323/KILO-BRIDGE  
**Branch:** v1-implementation  
**Implementation baseline reviewed:** d654e5f18c6e99ce136c613da727915cb21b7b17  
**CI evidence:** Windows CI run 44431059408  
**Related Issue:** #1 — GitHub-Centric Control Center and Isolated GitHub Intake  
**Last updated:** 2026-11-19

> Implementation, typechecking, automated testing, operator browser acceptance, and actual Windows Sandbox guest execution are recorded as separate evidence categories. A source commit or green hosted CI job does not imply that a real guest task has run.

## 1. Executive status

| Workstream | Source status | Automated evidence | Operator/runtime evidence |
|---|---|---|---|
| Repository boundary and safe defaults | Implemented | Windows CI green | Not applicable |
| Config schema and durable claims | Implemented | Windows CI green | No production claims processed |
| Dedicated GitHub intake | Implemented | Windows CI green | Gates off; no live intake run |
| Claim-bound Sandbox dispatcher | Implemented | Windows CI green | No live Issue dispatched |
| Generalized Windows Sandbox runner | Implemented with fail-closed checks | Windows CI green | Real guest task not yet verified |
| Control Center backend/security | Implemented | Windows CI green | Local browser acceptance pending |
| Control Center settings UI | Implemented | Windows CI green | Local browser acceptance pending |
| Operator runtime verification/attestation workflow | Not implemented | Not applicable | Blocking next release gate |
| Documentation synchronization | Updated in this commit | Not yet included in CI | Pending documentation commit |

The latest verified Windows CI run reports **295 tests, 290 passed, 0 failed, and 5 skipped**. Skipped checks are environment-dependent and are not counted as runtime passes.

## 2. Operational safety state

Fresh-install defaults remain:

- workerEnabled=false
- githubIntakeEnabled=false
- sandboxExecutionEnabled=false
- ghEnabled=false
- kiloEnabled=false
- githubIntakeAllowedRepositories=[]

The Control Center can prepare provider/runtime settings and repository trust, and can disable gates. It rejects attempts to enable workerEnabled, githubIntakeEnabled, or sandboxExecutionEnabled until a real guest-runtime verification/attestation workflow exists. Do not edit the config manually to bypass the restriction.

No production GitHub Issue was processed as part of this implementation work. No pull request, merge, or deployment was performed.

## 3. Phase overview

| Phase | Scope | Current status | Exit gap |
|---|---|---|---|
| 0 | Repository boundary, safe defaults, worker isolation safeguards | COMPLETE — source + CI | None for this scoped work |
| 1 | Configuration, schema-v5 claims, SQL.js concurrency protection | COMPLETE — source + CI | Operator DB runtime concurrency is not covered by hosted CI |
| 2 | Dedicated GitHub discovery, eligibility, durable claims, live gates | COMPLETE — source + CI | Live intake remains deliberately disabled |
| 3 | Claim-bound dispatcher, Sandbox execution contract, evidence and report lifecycle | PARTIAL — source + CI | Real guest task, runtime attestation, and recovery acceptance |
| 4 | Authenticated loopback Control Center backend and APIs | COMPLETE — source + CI | Local browser acceptance |
| 5 | Control Center UI, configuration, SSE refresh, operator controls | COMPLETE — source + CI | Local browser acceptance and future gate-activation UX |
| 6 | Integration hardening, tests, Windows CI | PARTIAL | Guest runtime and disposable-repository pilot |
| 7 | Architecture, execution, recovery, testing, operator documentation | IN PROGRESS | This documentation commit and continued synchronization |

No overall percentage is published. A percentage would conceal the remaining guest-runtime and operator acceptance blockers.

## 4. Implemented architecture

### 4.1 Intake and durable claims

- Dedicated intake is separate from the legacy generic worker.
- It considers only active registered projects inside the exact repository allowlist.
- Eligible Issues must be open, not pull requests, carry kilo:ready, have an allowed author, and satisfy title/body/URL constraints.
- The Issue is re-fetched immediately before claiming.
- A persistent repository/Issue/assignment-generation claim is written before the GitHub claim-label update.
- Claim identity includes owner, random token, lease, generation, and task association.
- Ambiguous failures move to RECONCILIATION_REQUIRED; the service does not blindly retry an uncertain dispatch.
- The service re-reads current config during polling. Turning off the intake gate, Sandbox gate, prerequisites, or trusted repositories stops future polling.

### 4.2 Dispatcher and worker integration

- SandboxGitHubIntakeDispatcher validates the persisted claim, task/Issue URL, current trust allowlist, exactly one active project mapping, and task lease.
- The dispatcher instantiates the existing worker for a single claim-bound task only.
- That Worker is constructed with workerEnabled=false and a configured WindowsSandboxTaskRunner.
- The Sandbox-only branch does not fall back to host Kilo.
- The shared task lifecycle continues through independent verification, durable execution record, report generation, GitHub comment, and terminal claim/task-state reconciliation.

### 4.3 Generalized Sandbox runner

- A per-execution Windows Sandbox configuration disables guest networking and clipboard/printer/audio/video redirection.
- Inbox is read-only; Outbox is writable; ProviderResponses is a separate read-only mapping.
- Native standalone kilo.exe and Node runtime are staged into the guest with a filtered task-worktree payload.
- The guest uses a loopback-only provider bridge. Host relay requests are bounded and validated; the API key is read only in the Bridge process; provider redirects are rejected.
- The guest returns an execution-UUID-bound manifest with stage status, Kilo exit/version, native tool-call evidence, and artifact SHA-256/size declarations.
- The host validates paths, manifest size/counts, evidence, and artifact hashes before applying the full change set transactionally.
- Rollback material is retained when rollback cannot complete.
- Bounded evidence is persisted under data/sandbox-evidence/<executionId>.json; prompts, provider request bodies, credentials, raw Kilo output, and reasoning are not persisted there.

### 4.4 Control Center

- The server binds to 127.0.0.1 only.
- Authentication uses a one-time setup token, scrypt password derivation, server-side expiring sessions, Origin/Host/CSRF checks, bounded request body, throttling, CSP/security headers, and logout cleanup.
- Read models are database-backed and omit sensitive filesystem paths, claim tokens, raw audit details, and credential values.
- Project and settings changes are audited.
- Authenticated SSE sends a change notification and operational revision; clients reload the authoritative view on connect/reconnect.
- Settings can configure the Kilo executable path, provider URL/model, API-key environment-variable name/header/prefix, GitHub/Kilo prerequisites, trusted repositories, and polling interval.
- The UI never accepts the API-key value. It reports only whether the configured environment variable exists and returns only the executable basename.

## 5. Windows CI evidence

| Field | Value |
|---|---|
| Workflow | Windows CI |
| Run | 44431059408 |
| Commit | d654e5f18c6e99ce136c613da727915cb21b7b17 |
| Dependency installation | PASS |
| Source/test TypeScript checks | PASS |
| Build | PASS |
| Tests | 295 total |
| Passed | 290 |
| Failed | 0 |
| Skipped | 5 |
| Conclusion | SUCCESS |

Hosted Windows CI validates compilation/build, automated fixtures, generated provider bridge syntax, guest path/XML construction, fail-closed gate behavior, claim-bound worker lifecycle, Control Center settings security/redaction, and test behavior. It does not have the operator's configured Kilo executable, upstream provider credentials, or a verified interactive Windows Sandbox runtime; it is not a real guest-run acceptance result.

## 6. Remaining critical release work

### 6.1 Operator-hosted runtime verification and attestation — BLOCKING

Implement a Control Center action for a one-time verification task that:

1. Runs in a disposable Bridge-owned verification directory, not a registered project or GitHub repository.
2. Uses the generalized runner with a temporary in-memory execution config; it does not persistently turn on the Sandbox or intake gate.
3. Asks guest Kilo to create a harmless marker file in the disposable workspace.
4. Requires a matching execution UUID, required guest/provider/Kilo stages, at least one native file-writing tool event, Kilo exit code zero, positive provider request count, valid marker SHA-256, and complete cleanup.
5. Persists a bounded local attestation atomically, without secrets or prompts.
6. Binds the attestation to the current Kilo executable hash, Windows Sandbox executable/version, provider URL/model, API-key environment-variable name/presence, and runner/config contract. A material change invalidates it.
7. Exposes accepted/expired/needs-retest status in Settings and an explicit operator action to enable the Sandbox and then dedicated intake gates only when the attestation matches.
8. Continues to reject enabling the legacy generic worker from the dedicated intake UI.

This feature has not been implemented. Until it exists and passes on the operator's actual machine, execution gates stay false.

### 6.2 Disposable repository pilot

After runtime attestation succeeds:

- Configure one dedicated disposable GitHub repository and one test author.
- Create one harmless Issue with the ready label.
- Explicitly activate dedicated intake and click Start in the Control Center.
- Verify one durable claim, one task/execution UUID, native Kilo tool evidence, expected artifact hashes, independent verification, report comment, labels, and terminal task/claim state.
- Verify no duplicate execution after poll restart or service restart.
- Stop intake and confirm gates remain in the intended state.
- Remove/discard the disposable repository resources after evidence is recorded.

Do not use a production business repository for the pilot.

### 6.3 Browser acceptance

On the operator's local Windows browser:

- Complete one-time setup/login/logout.
- Verify dashboard, project/task/claim views, provider settings, validation error handling, gate-off behavior, SSE refresh/reconnect, and responsive layout.
- Confirm no API-key value or full Kilo executable path appears in API responses, audit entries, or browser DOM.
- Verify no control enables automatic processing before a matching runtime attestation exists.

## 7. Documentation obligations

These documents are part of implementation acceptance and must be updated whenever relevant source behavior changes:

- docs/architecture.md
- docs/windows-configuration.md
- docs/windows-sandbox-execution.md
- docs/recovery-troubleshooting.md
- docs/testing-guide.md
- docs/control-center-operations.md
- docs/github-control-center-implementation-progress.md

Documentation must distinguish code-level CI proof from guest runtime proof and must not describe planned verification as implemented before it exists.

## 8. Change and verification log

| Date | Commit / run | Change or evidence | Result |
|---|---|---|---|
| 2026-11-19 | d654e5f18c6e99ce136c613da727915cb21b7b17 | Corrected Sandbox WSB test to compare the guest-mapped bootstrap path literally. | Source/test committed |
| 2026-11-19 | Windows CI 44431059408 | Dependency install, TypeScript, build, complete test suite. | PASS — 295 total, 290 passed, 0 failed, 5 skipped |
| 2026-11-19 | Operator-hosted Windows Sandbox guest execution | Generalized runner with disposable marker task. | NOT YET RUN |
| 2026-11-19 | Local browser acceptance | Operator browser walkthrough of Control Center. | NOT YET RUN |
| 2026-11-19 | Disposable GitHub Issue pilot | End-to-end claim → guest → artifacts → verification → report. | BLOCKED on runtime attestation |

## 9. Status definitions

- NOT STARTED: implementation has not begun.
- IN PROGRESS: source changes are underway; exit criteria remain open.
- PARTIAL: source exists but acceptance evidence is incomplete.
- BLOCKED: a concrete dependency prevents safe progress.
- COMPLETE: all stated exit criteria and evidence have been met.
- DEFERRED: intentionally postponed with a recorded reason.

A workstream is never marked COMPLETE solely because a source file was edited or a report was written.

# GitHub Control Center and Isolated Intake — Progress Tracker

**Tracker version:** 2.0  
**Status:** ATTESTATION WORKFLOW SOURCE + TESTS COMMITTED; CURRENT CI AND REAL GUEST ACCEPTANCE PENDING  
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
| Operator runtime verification/attestation workflow | Implemented in source; real run pending | Regression tests committed; latest CI pending | Blocking until operator-hosted verification succeeds |
| Documentation synchronization | Updated for attestation workflow | Current docs commit not yet included in verified CI | Operator/browser acceptance pending |

The latest verified Windows CI run reports **295 tests, 290 passed, 0 failed, and 5 skipped** on commit `d654e5f18c6e99ce136c613da727915cb21b7b17`. This run predates the attestation service, dispatcher enforcement, staged-gate API/UI, and the new attestation regression cases. The latest cross-process attestation regression test was corrected and committed as `672a3dd8abb58aeee6653fec42ab8d420dfd2396`; it spawns an independent Node process that owns the real intake poll lock. Additional runtime-setting lockout tests followed in `63db74b`, plus attestation request validation and settings URL redaction tests in `39abf9b` and `d5e0fa1`. The latest inspected source commit `d5e0fa1dec9c2ef57ef65dbb5f40cc1df365f5e4` returned no commit statuses and no workflow runs through the connected GitHub endpoints. Additional source/tests after the cross-process guard include runtime-setting lockout (`63db74b`), attestation request body rejection (`39abf9b`), and provider URL response redaction (`d5e0fa1`). These remain source-only until a new Windows CI run confirms them. Do not treat the older 295-test run as verification of the latest source. Skipped checks are environment-dependent and are not counted as runtime passes.

## 2. Operational safety state

Fresh-install defaults remain:

- workerEnabled=false
- githubIntakeEnabled=false
- sandboxExecutionEnabled=false
- ghEnabled=false
- kiloEnabled=false
- githubIntakeAllowedRepositories=[]

The Control Center can prepare provider/runtime settings and repository trust, run the one-time disposable guest verification, display a signed 24-hour attestation, and expose staged activation. It requires a current valid attestation before enabling sandboxExecutionEnabled; Github intake requires Sandbox already enabled, prerequisites and trust, and dispatcher readiness. The legacy workerEnabled gate remains blocked. The persistent defaults remain false, and no gate was enabled during implementation.

No production GitHub Issue was processed as part of this implementation work. No pull request, merge, or deployment was performed.

## 3. Phase overview

| Phase | Scope | Current status | Exit gap |
|---|---|---|---|
| 0 | Repository boundary, safe defaults, worker isolation safeguards | COMPLETE — source + CI | None for this scoped work |
| 1 | Configuration, schema-v5 claims, SQL.js concurrency protection | COMPLETE — source + CI | Operator DB runtime concurrency is not covered by hosted CI |
| 2 | Dedicated GitHub discovery, eligibility, durable claims, live gates | COMPLETE — source + CI | Live intake remains deliberately disabled |
| 3 | Claim-bound dispatcher, Sandbox execution contract, evidence and report lifecycle | PARTIAL — source + prior CI | Real guest task, successful attestation, and recovery acceptance |
| 4 | Authenticated loopback Control Center backend and APIs | COMPLETE — source + CI | Local browser acceptance |
| 5 | Control Center UI, configuration, SSE refresh, operator controls | COMPLETE — source; latest CI pending | Local browser acceptance of attestation and staged activation UX |
| 6 | Integration hardening, tests, Windows CI | PARTIAL | Latest branch CI, guest runtime, browser acceptance, disposable-repository pilot |
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

### 6.1 Operator-hosted runtime verification and attestation — SOURCE IMPLEMENTED; OPERATOR RUN BLOCKING

The following source path is now implemented and regression tests are committed:

1. `SandboxRuntimeAttestationService` uses a disposable Bridge-owned directory under `data/sandbox-runtime-verification`, never a registered project or GitHub repository.
2. It uses a temporary in-memory config override with only `sandboxExecutionEnabled=true`; worker, intake, and persistent config values remain disabled.
3. It asks guest Kilo to create an exact execution-ID/nonce marker through the native write tool.
4. It requires a matching execution UUID, guest/provider/Kilo stage evidence, Kilo exit code zero, at least one provider request, native write-tool evidence, exact marker content, one matching artifact SHA-256/size declaration, the runner's bounded evidence file, and full cleanup of both verification and runner staging directories.
5. It persists an HMAC-signed local attestation atomically, with a separately stored signing key, 24-hour expiry, and no prompt, nonce, provider request body, API-key value, or raw Kilo output.
6. The attestation fingerprint binds the Kilo executable hash/version, Windows Sandbox executable hash/version, provider URL/model and non-secret auth configuration identity, Node/OS/architecture, and runner contract. Expiry, tampering, missing key, or runtime drift invalidates it.
7. Authenticated Control Center routes expose status and start the one-time verification. Settings offers staged Sandbox then intake activation; enabling intake requires Sandbox already enabled, current attestation, GitHub/Kilo prerequisites, trusted repositories, and dispatcher readiness.
8. The app shares the same attestation service with `SandboxGitHubIntakeDispatcher`; actual dispatcher readiness and dispatch fail closed when the attestation is missing, expired, or mismatched. The generic worker gate remains unavailable from this workflow.

**Still blocking release:** run this verification on the operator's actual interactive Windows Sandbox, confirm status `VALID`, then perform local browser acceptance and only afterward conduct a disposable-repository GitHub pilot. Do not manually set any execution gate.

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
| 2026-11-19 | `5ee6673`, `89a27e8`, `d6d8acf` | Added non-secret runtime fingerprint, HMAC-signed 24-hour disposable Sandbox attestation service, failure-state reporting, and guaranteed cleanup. | SOURCE COMMITTED |
| 2026-11-19 | `656db4f`, `49d66fc`, `faf9413`, `d8c70e6`, `16dae79`, `7cfac35` | Added authenticated attestation API, required current proof in the claim dispatcher, shared service instance through the app/Control Center, and separated runtime prerequisites from the intake-enabled gate. | SOURCE COMMITTED |
| 2026-11-19 | `3acf7b5`, `81b86e8`, `cf07c7c`, `40e7f1c` | Added Settings verification status/action and staged gate controls; enforced Sandbox-first/intake-second dependency in the API; hid repeated verification while proof remains valid. | SOURCE COMMITTED |
| 2026-11-19 | `3fe40da`, `8737003`, `7344f5f`, `b09f50c` | Added five attestation-service tests and two Control Center API/gate tests, including no-rerun while a proof is still valid and order-of-operations guard. | TEST SOURCE COMMITTED; EXECUTION PENDING |
| 2026-11-19 | `7c444c6`, `cc82e49`, `672a3dd` | Attestation reserves the same cross-process GitHub intake poll lock for the full disposable guest run; the regression test uses a separate Node PID to hold/release the actual lock. | SOURCE + TEST COMMITTED; EXECUTION PENDING |
| 2026-11-19 | `6eb4671`, `946bee1`, `63db74b` | Runtime-bound Kilo/provider settings cannot be modified while Sandbox/intake would remain enabled or in the same activation request; tests cover both active-gate and bundled-activation bypass attempts. | SOURCE + TEST COMMITTED; EXECUTION PENDING |
| 2026-11-19 | `fdd5b3b`, `fee01d0` | Updated operator and architecture documentation for runtime settings lockout and retest requirements. | DOCS COMMITTED; LATEST CI PENDING |
| 2026-11-19 | `36c695c`, `39abf9b` | Attestation verify POST now consumes bounded JSON and rejects any caller-supplied task/runtime parameters. | SOURCE + TEST COMMITTED; EXECUTION PENDING |
| 2026-11-19 | `90c39ba`, `d5e0fa1` | Settings API strips provider URL user-info, query tokens, and fragments even if manually inserted into configuration; regression test verifies no URL secrets reach the browser response. | SOURCE + TEST COMMITTED; EXECUTION PENDING |
| 2026-11-19 | `351443a`, `ade84d4`, `c0205b6` | Updated operator, Sandbox, and architecture docs to explain cross-process intake exclusion and the current release gate. | DOCS COMMITTED; LATEST CI PENDING |
| 2026-11-19 | `87473f7`, `6d31292`, `1611f01`, `684d465` | Attestation holds the shared config-write lock as well as the intake poll lock; final post-run config/gate/runtime revalidation occurs before signing. Tests cover out-of-band gate mutation and blocked normal config writes during the guest run. | SOURCE + TEST COMMITTED; EXECUTION PENDING |
| 2026-11-19 | `36c695c`, `39abf9b` | Attestation verify POST consumes bounded JSON and rejects caller-supplied task/runtime parameters. | SOURCE + TEST COMMITTED; EXECUTION PENDING |
| 2026-11-19 | `90c39ba`, `d5e0fa1` | Settings API strips provider URL user-info, query tokens, and fragments even if manually inserted into config; regression test verifies no URL secrets reach the browser response. | SOURCE + TEST COMMITTED; EXECUTION PENDING |
| 2026-11-19 | `f2f1522`, `aea26bc`, `42958a9` | Updated operator, Sandbox, and architecture docs to describe config/intake locks and post-run revalidation before signing. | DOCS COMMITTED; LATEST CI PENDING |
| 2026-11-19 | Windows CI 44431059408 | Dependency install, TypeScript, build, complete test suite. | PASS — 295 total, 290 passed, 0 failed, 5 skipped |
| 2026-11-19 | Operator-hosted Windows Sandbox guest execution | Generalized runner with disposable marker task and signed attestation workflow. | NOT YET RUN — no operator runtime proof |
| 2026-11-19 | Local browser acceptance | Operator browser walkthrough of Control Center. | NOT YET RUN |
| 2026-11-19 | Disposable GitHub Issue pilot | End-to-end claim → guest → artifacts → verification → report. | BLOCKED until operator attestation and browser acceptance |

## 9. Status definitions

- NOT STARTED: implementation has not begun.
- IN PROGRESS: source changes are underway; exit criteria remain open.
- PARTIAL: source exists but acceptance evidence is incomplete.
- BLOCKED: a concrete dependency prevents safe progress.
- COMPLETE: all stated exit criteria and evidence have been met.
- DEFERRED: intentionally postponed with a recorded reason.

A workstream is never marked COMPLETE solely because a source file was edited or a report was written.

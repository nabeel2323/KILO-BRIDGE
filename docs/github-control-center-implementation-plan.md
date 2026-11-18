# GitHub Control Center and Intake — Implementation Plan

**Document version:** 1.0  
**Status:** ACTIVE — implementation roadmap approved by repository owner  
**Repository:** `nabeel2323/KILO-BRIDGE`  
**Implementation branch:** `v1-implementation`  
**Baseline commit reviewed:** `e3ecd61d5eb77befcb8169069019d9f44b7cf769`  
**Related implementation request:** [Issue #1](https://github.com/nabeel2323/KILO-BRIDGE/issues/1)  
**Last updated:** 2026-11-19

## 1. Objective

Deliver a secure, local-first Kilo Bridge Control Center and an independent, opt-in GitHub Issue intake service.

The operating workflow is:

```text
ChatGPT / Operator
       |
       v
GitHub Issue + authorized comments
       |
       v
Dedicated GitHub Intake (explicitly enabled)
       |
       v
Durable eligibility + claim + task record
       |
       v
Shared Kilo execution pipeline
       |
       v
Native Kilo + configured Windows Sandbox isolation
       |
       v
Evidence-backed report + GitHub status reconciliation
       |
       v
ChatGPT review / follow-up Issue or comment
```

GitHub remains the task instruction and review channel. Kilo Bridge's SQLite database remains the operational record for configured projects, tasks, assignments, claims, executions, verification, events, and audit history. The Control Center is an operational interface, not a competing task source of truth.

## 2. Non-negotiable implementation boundaries

1. Work only in this repository. Do not inspect, access, modify, or depend on `C:\TAIF\scs-platform` or any unrelated repository.
2. Keep `workerEnabled` independent and preserve its existing semantics.
3. Add a separate `githubIntakeEnabled` setting, defaulting to `false`. It must remain false through implementation, migrations, tests, and startup.
4. Do not start either service or process real GitHub work Issues as part of implementation.
5. Test with isolated local fixtures and a dedicated disposable GitHub test repository only.
6. Keep the initial Control Center bound to `127.0.0.1`; no LAN/public listener, webhook, tunnel, or reverse proxy.
7. Do not weaken the native Kilo / Windows Sandbox execution and evidence-validation path.
8. Do not bypass approval, review, publishing, or repository security controls.
9. The owner has subsequently authorized implementation commits directly to the existing `v1-implementation` branch. Do not create additional branches or pull requests, merge, publish releases, or deploy unless separately requested. Runtime acceptance remains a separate evidence requirement; a commit is not proof of a passing build or test.
10. Treat all GitHub Issue and comment content as untrusted input. Task text cannot alter Bridge policy, trusted repositories/authors, allowed tools, isolation, secrets, or the assigned workspace.

## 3. Baseline findings from source inspection

The following are source-level observations from branch `v1-implementation` at baseline commit `e3ecd61d5eb77befcb8169069019d9f44b7cf769`; they are not a claim that a new build or test run was performed during this review.

| Area | Observed baseline | Implementation consequence |
|---|---|---|
| Configuration | `src/config.ts` has `ghEnabled`, `kiloEnabled`, and `workerEnabled`; all default false. No dedicated GitHub intake gate exists yet. | Add a separately parsed and persisted `githubIntakeEnabled: false` setting and test independent defaults. |
| Startup / project registration | `KiloBridgeApp.init()` has a `registerScs` default of true. The CLI `init` path enables it for the default Bridge root and contains a hard-coded `scs-platform` project mapping. | Remove implicit project registration. Initialization must be neutral and must not register or inspect SCS. Preserve existing user project data; do not silently delete project records. |
| Database | `SqliteStore` uses `sql.js`, persists the database export on writes, and currently sets `PRAGMA user_version` to 4. The task lookup index on project/Issue is not a global GitHub repository/Issue uniqueness constraint. | Design a forward-only, idempotent migration and a durable repository-scoped claim/idempotency contract. Account for the current whole-file persistence model when handling concurrent processes. |
| Generic worker | `src/components/worker.ts` combines discovery, claim labeling, correction handling, execution, verification, reports, and publishing. It checks `workerEnabled` in some execution paths, but GitHub discovery/label mutations occur in the same flow. | Do not simply reuse or start the generic worker for intake. Audit all legacy paths and extract a shared execution service behind separate entry-point gates. |
| GitHub integration | `src/components/github.ts` is the existing GitHub provider abstraction and uses the local GitHub CLI integration. | Reuse the provider and safe process abstraction; do not introduce public webhooks or a second credential store. |
| Web application | The inspected app/CLI structure does not yet show a Control Center server or UI. | Introduce a separated local web/API layer and keep startup independent from either task-processing service. |
| Tests | The project uses TypeScript and Node's built-in `node:test`; `tests/worker.test.ts` and `tests/db.test.ts` already cover core flows. | Add isolated tests for each intake state and regression tests for worker-gate independence. Never execute a production Issue in tests. |

## 4. Target architecture and component ownership

### 4.1 Core components

| Component | Responsibility | Must not do |
|---|---|---|
| `GitHubIntakeService` | Poll explicitly allowlisted repositories; validate eligibility; coordinate durable claims; schedule accepted tasks automatically when enabled. | Start when its gate is false; alter generic-worker state; trust arbitrary Issue instructions. |
| `TaskExecutionService` (extracted/shared) | Execute an already accepted task using the existing Kilo, verification, isolation, report, and lifecycle primitives. | Discover Issues or make intake trust decisions. |
| `Worker` | Preserve legacy/manual generic-worker behavior under `workerEnabled`. | Be silently enabled or used as the GitHub intake scheduler. |
| `GitHubProvider` | Read Issues/comments and perform narrowly scoped label/comment operations. | Hold application policy or accept raw task text as executable shell commands. |
| `SqliteStore` | Persist project, task, claim, execution, event, and audit state with migration/version control. | Treat process-local memory as the concurrency authority. |
| `ControlCenterServer` | Serve authenticated loopback HTTP routes and static UI; expose safe read models and authorized operator actions. | Bind to a non-loopback interface or return secrets. |
| `ControlCenterUI` | Present dashboard, projects, assignments, tasks, executions, review, audit, and configuration. | Display fabricated execution or status evidence. |

### 4.2 Intake eligibility and trust contract

An Issue may be accepted only when all checks pass:

- Repository is explicitly configured, allowlisted, and mapped to exactly one enabled Bridge project.
- Issue is open and is not a pull request.
- Required ready label (default `kilo:ready`) is present.
- Issue author is present in that project's allowed-author list.
- Required task specification is present and valid.
- Project is enabled and has valid local prerequisites.
- No active or unresolved claim/execution already exists for the same repository + Issue + assignment generation.

Use a canonical repository identity and Issue number in the durable idempotency key. Make the claim operation atomic across competing pollers. Because the present database layer uses `sql.js` and writes whole-file exports, the implementation must explicitly solve cross-process serialization (for example, a dedicated exclusive intake lock plus a database uniqueness check) rather than assuming an in-memory mutex or SQLite transaction alone protects multiple Bridge processes.

For uncertain outcomes, persist a reconciliation-required state. Do not relaunch Kilo merely because a lease expired or a process restarted. Reconcile the persisted execution, guest result, artifacts, GitHub labels, and report comment before deciding whether an operator action is needed.

### 4.3 GitHub state and result contract

Use existing lifecycle concepts and labels where compatible:

`kilo:ready` → `kilo:claimed` → `kilo:running` → `kilo:report-ready` / `kilo:blocked` / `kilo:failed`, with correction and publication approval states preserved.

Transitions must be idempotent and recoverable. A report comment must contain only observed evidence: task/execution identity, outcome, stages, provider/Kilo version, actual isolation result, actual native-tool evidence, verification results, exit code, artifacts and SHA-256 values, blockers, and the next review action. Bridge report markers must prevent feedback comments from being ingested as fresh task instructions.

## 5. Phased implementation sequence

### Phase 0 — Repository boundary, baseline, and safety remediation

**Purpose:** Make startup and project selection safe before adding autonomous intake.

Tasks:
- Remove hard-coded SCS project registration from normal initialization and CLI initialization.
- Make initialization side-effect-neutral with respect to project registration.
- Preserve existing project records; identify any historical seeded SCS project entry without opening its configured local path and ensure it cannot be automatically selected by this feature.
- Audit every generic-worker entry point and every path that can mutate GitHub or execute Kilo while `workerEnabled=false`.
- Establish isolated test fixtures and a repository allowlist test fixture; prohibit production repository targets in integration tests.
- Record a clean baseline for builds and tests from the Windows development environment.

Exit criteria:
- `init` does not register projects implicitly.
- No code path accesses or modifies the SCS workspace.
- `workerEnabled=false` blocks generic background execution and all unintended execution/recovery paths.
- A test proves GitHub intake is not started by initialization.

### Phase 1 — Configuration and durable data contracts

**Purpose:** Add independent feature gating and safe persistence before polling.

Tasks:
- Add `githubIntakeEnabled` with a false default; keep `workerEnabled` unchanged.
- Add explicit trusted repository configuration (empty by default) and retain per-project author allowlists.
- Add validated configuration parsing, serialization, CLI/config support, and migration coverage.
- Design the forward-only database migration for intake assignments/claims, claim generations, reconciliation state, and event records only where existing tables cannot serve.
- Add atomic repository + Issue + generation uniqueness and cross-process intake lock handling.
- Add DB APIs for dashboard read models and claim/reconciliation operations; avoid raw SQL in UI routes.

Exit criteria:
- Fresh and upgraded installations default both gates to false.
- An empty repository allowlist accepts no work.
- Duplicate/concurrent claim attempts cannot create duplicate task/execution records.
- Existing task, project, execution, and report records survive migration.

### Phase 2 — Dedicated GitHub intake service

**Purpose:** Implement opt-in automatic task discovery without invoking the legacy worker.

Tasks:
- Create an independently controlled intake service, status model, lifecycle, and CLI/app integration.
- Poll only the configured repository allowlist and matching project mapping.
- Enforce open Issue / not PR / ready label / author allowlist / task specification / project readiness checks.
- Persist a claim before GitHub state mutation; reconcile partial failures between DB and GitHub.
- Ensure the service does nothing when disabled, including no claim, labels, execution records, or Kilo launch.
- Support automatic task dispatch after explicit operator enablement; no per-task Run button.
- Preserve correction workflow semantics without accepting Bridge-generated report comments as instructions.

Exit criteria:
- Disabled intake results in zero provider mutations and zero Kilo launches.
- Enabling intake does not start or enable `Worker`.
- All positive and negative eligibility cases pass isolated tests.
- Poll restarts, duplicate polls, concurrent instances, and uncertain results are safe.

### Phase 3 — Shared execution, evidence, GitHub reconciliation

**Purpose:** Reuse the verified native Kilo execution path while separating intake from execution scheduling.

Tasks:
- Extract or formalize a shared task execution service from the existing worker pipeline with no weakening of Kilo policy, verification, worktree handling, Windows Sandbox launch, guest-result validation, or cleanup.
- Ensure the task is tied to a durable assignment and execution ID before launch.
- Persist lifecycle events/stages and evidence as they occur.
- Reconcile GitHub labels and same-Issue comments after success, failure, timeout, guest boot failure, incomplete evidence, and process restart.
- Ensure no automatic publish, merge, deployment, or approval bypass.
- Verify correction attempts are versioned and do not overwrite previous reports/evidence.

Exit criteria:
- Dedicated intake dispatches through the same secured execution pipeline.
- Real guest verification is accepted only from validated guest results for the matching execution ID.
- Feedback is evidence-based and idempotent.
- Existing manual and generic-worker regression behavior is preserved.

### Phase 4 — Control Center backend and security

**Purpose:** Provide a local authenticated operational interface with safe APIs.

Tasks:
- Implement a separated HTTP server bound explicitly to `127.0.0.1`.
- Implement bootstrap/local authentication using secure password hashing and protected session cookies.
- Enforce Host and Origin validation, CSRF protection on mutations, authorization per route, request-size limits, rate limits, safe error responses, and restrictive security headers/CSP.
- Redact credentials, tokens, secrets, command arguments, environment variables, and sensitive file paths from API responses and logs.
- Provide read APIs for projects, gates, tasks, executions, lifecycle timeline, evidence, audit, and health.
- Provide audited operator APIs for project mapping, trusted authors/repositories, and the GitHub intake gate.
- Keep existing worker gate visually and operationally distinct from intake.

Exit criteria:
- Listener is loopback-only in tests and runtime.
- Authentication/CSRF/Origin/Host/authorization and secret-redaction tests pass.
- All state-changing operations are audited.
- The UI cannot bypass existing policy or invoke unapproved execution actions.

### Phase 5 — Control Center UI and live operations

**Purpose:** Deliver the browser interface on top of real persisted data.

Areas:
- Dashboard and service health.
- Projects and trusted configuration.
- GitHub assignments and intake queue.
- Task/execution detail with timeline, logs, evidence, verification, artifacts, and failures.
- Live monitoring via safe SSE (or existing event infrastructure), with reconnect and replay behavior.
- Review center with explicit approval/review state and no automatic publish/merge.
- Activity and audit history.
- Settings with clearly separated `githubIntakeEnabled` and `workerEnabled`.

Exit criteria:
- No mock runtime data is shown.
- Empty, blocked, failed, review-ready, and large task lists render correctly.
- Live reconnect never invents or skips persisted event identity.
- The operator can configure and observe the system without routine CLI management.

### Phase 6 — Integration, hardening, and independent verification

**Purpose:** Prove safety and runtime behavior without touching production work.

Tasks:
- Unit tests for config, migrations, eligibility, trust policy, idempotency, claims, state reconciliation, report generation, auth, CSRF, Origin/Host, and redaction.
- Integration tests with fake GitHub provider and isolated local repository fixtures.
- Dedicated disposable GitHub test repository verification only after explicit test-only activation.
- Actual execution test through native Kilo and Windows Sandbox with a unique execution ID and evidence validation.
- Failure/restart tests: provider unavailable, claim conflict, process kill, guest timeout, malformed guest result, artifact mismatch, report-post failure, and duplicate comment delivery.
- Full TypeScript build, typecheck, and complete test suite. Record exact pass/fail/skip counts and separate existing failures from introduced failures.
- Verify both runtime gates remain disabled after all tests.
- Keep the Windows CI workflow (`.github/workflows/ci.yml`) limited to read-only repository checkout, dependency installation, typecheck, build, and tests; no deployment or task execution.

Exit criteria:
- All required tests pass or have explicitly documented, non-waived blockers.
- At least one dedicated test Issue completes end-to-end through the actual isolated execution path.
- No real project Issue is processed; no worker/intake service remains enabled.

### Phase 7 — Documentation and release readiness

**Purpose:** Keep operator guidance aligned with real implementation.

Tasks:
- Update architecture, installation, configuration, security, operations, troubleshooting, testing, and release notes.
- Document first-run auth/bootstrap and safe enablement sequence.
- Add a release-gate report that separates implemented, unit-tested, integration-tested, and real-runtime-verified behavior.
- Re-check documentation links, CLI help, API routes, and Control Center workflows against the actual code.
- Capture known limitations and rollback/recovery procedure.

Exit criteria:
- Documentation reflects implemented and verified behavior only.
- Operator can install, configure, use, stop, and recover the Bridge from the browser/CLI instructions.
- Release remains blocked for any unresolved security, isolation, migration, or evidence-integrity issue.

## 6. Verification matrix

| Requirement | Minimum evidence |
|---|---|
| Independent defaults | Fresh config + upgraded config assertions showing both gates false |
| No side effects while disabled | Provider mutation spy, DB diff, and Kilo launch spy all remain zero |
| Worker independence | Enabling intake leaves generic worker disabled/stopped; legacy worker tests remain valid |
| Repository trust | Wrong/unmapped repo is rejected before task creation or GitHub mutation |
| Author trust | Untrusted author and unauthorized correction comments are ignored and audited |
| PR/open/label validation | Closed, PR, missing-ready-label, and malformed Issues are rejected |
| Claim correctness | Duplicate/concurrent polls and restarts produce one durable assignment/execution |
| Prompt-injection boundary | Issue text cannot alter policy, tools, allowlists, isolation, secrets, or workspace boundaries |
| Runtime integrity | Native Kilo + real Windows Sandbox guest result validated against execution ID and artifact hashes |
| GitHub feedback | Same Issue status/comment reconciles idempotently with persisted evidence |
| Local web security | Loopback bind, auth, CSRF, Origin/Host, authorization, CSP, headers, request limits |
| UI evidence | All displayed state derives from database/provider; no fabricated events |
| Regressions | Full build/typecheck/test counts and targeted legacy-worker regression results |

## 7. Delivery controls

- Work one phase at a time; update the progress file in the same change as each completed implementation slice.
- Each phase must list files changed, migration impact, tests added, commands executed, actual results, and unresolved risks.
- Do not mark a phase complete because code was authored; completion requires its exit criteria and evidence.
- Never claim local Windows runtime tests were executed when only GitHub source inspection was available.
- Keep intake and generic worker disabled in repository defaults and all committed examples.
- Keep Issue #1 without `kilo:ready`; it is the planning/implementation reference, not an execution trigger.

## 8. Current state

The plan is established from the existing repository layout and the implementation scope in Issue #1. The current code baseline is not yet certified against this plan. See [the live progress tracker](github-control-center-implementation-progress.md) for phase status, findings, evidence, and the next implementation slice.

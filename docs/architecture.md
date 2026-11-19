# Kilo Bridge Architecture

Kilo Bridge is a configuration-driven, multi-project development coordinator. GitHub Issues are the task source of truth; the Bridge owns eligibility checks, durable claims, isolated execution, verification, reporting, and local operational state.

## Runtime components

| Component | Source | Responsibility |
|---|---|---|
| App and CLI | src/app.ts, src/cli.ts | Initialize storage/configuration and expose administration/service lifecycle |
| Project registry | src/components/registry.ts | Validate and manage project/repository mappings |
| GitHub provider | src/components/github.ts | GitHub CLI/API transport for Issues, comments, labels, and repository operations |
| Generic worker | src/components/worker.ts | Existing generic polling/execution/publishing workflow; independent workerEnabled gate |
| Dedicated intake | src/components/githubIntake.ts | Allowlisted Issue discovery, eligibility checks, durable claims, continuous polling |
| Sandbox dispatcher | src/components/sandboxGitHubIntakeDispatcher.ts | Validate claim identity, project mapping, task lease, and trust gates before dispatch |
| Windows Sandbox runner | src/components/windowsSandboxTaskRunner.ts | Stage one task in a disposable guest and validate returned evidence/artifacts |
| Security manager | src/components/security.ts | Effective Kilo permissions, deny-by-default command policy, path checks, redaction |
| Worktree manager | src/components/worktree.ts | Create the task worktree, protect the main checkout, inventory changes |
| Verification engine | src/components/verification.ts | Run configured independent verification after artifact import |
| Report generator | src/components/report.ts | Generate execution reports and GitHub feedback |
| Persistence | src/db.ts | SQL.js store, forward-only migrations, durable task/claim/execution state, audit data |
| Local Control Center | src/components/controlCenter.ts, src/components/controlCenterPage.ts | Authenticated loopback operational browser UI |

## Dedicated GitHub intake flow

1. Operator preparation: configure the provider, standalone Kilo executable, provider-key environment-variable name, trusted repository allowlist, and project author allowlist.
2. Explicit gates: dedicated intake requires githubIntakeEnabled=true, sandboxExecutionEnabled=true, ghEnabled=true, kiloEnabled=true, and at least one trusted repository. The generic workerEnabled gate is separate and is deliberately false in the dedicated dispatcher.
3. Discovery: intake inspects only active registered projects whose exact owner/repo mapping is trusted. It lists open Issues carrying kilo:ready.
4. Eligibility: pull requests are excluded. An Issue must be open, have an allowed author, bounded title/body, and a canonical HTTPS GitHub Issue URL matching the registered repository. The service re-fetches the Issue before claiming it.
5. Durable claim: the Bridge persists a claim keyed by repository, Issue number, and assignment generation before mutating GitHub labels. Claim owner, random token, lease, task association, and reconciliation status are persisted.
6. Dispatch validation: the dispatcher verifies the persisted claim, task and owner/token, Issue URL, current allowlist, unique active project mapping, task lease, and Sandbox readiness. Uncertain outcomes become RECONCILIATION_REQUIRED and are not blindly relaunched.
7. Isolated execution: the worker prepares a task worktree, writes Bridge/Kilo security policy, and calls only the Windows Sandbox runner. The dispatcher constructs the worker with workerEnabled=false; there is no host-Kilo fallback.
8. Evidence and import: the guest returns a UUID-bound manifest with stage results, Kilo exit code/version, native tool-call evidence, and artifact hashes. The host validates the manifest and every path/hash before applying changes transactionally to the task worktree.
9. Verification/report: Bridge-owned verification runs independently after artifact import. The Bridge stores an execution record, generates a report, posts feedback to the same Issue, and reconciles labels/task/claim state.
10. Follow-up: correction requests and later attempts remain explicit lifecycle operations. Publishing remains separate and approval-controlled; dedicated intake does not publish, merge, or deploy.

GitHub Issue bodies and comments are untrusted task input, never security policy. They cannot override Bridge isolation, path, credential, or publishing restrictions.

## Windows Sandbox boundary

The generalized runner creates one disposable Sandbox session per task. Its WSB file disables guest networking, clipboard/printer/audio/video redirection, and maps three host directories:

| Mapping | Guest access | Purpose |
|---|---|---|
| Inbox | Read-only | Standalone Kilo and Node executables, effective Kilo config, provider bridge, filtered project payload, untrusted task specification |
| Outbox | Read/write | Guest-created provider request envelopes, operational logs, result manifest, changed artifact files |
| Provider responses | Read-only | Host-authored provider response stream files; guest cannot modify host response data |

The guest provider bridge listens only on guest loopback. Provider requests are written to the outbox; the host validates each request and forwards it only to the configured provider URL. Responses are written to the separate read-only response mapping. The provider API key is read from the Bridge process environment, added by the host to the upstream request, and is not copied into the guest or persisted in bridge.config.json. Upstream redirects are rejected.

The staged worktree excludes Git metadata, dependencies, Kilo/Bridge internals, and configured sensitive folders/files. Symbolic links, path traversal, Windows-invalid paths, sensitive paths, and unsafe guest artifacts are rejected. Artifact import validates the complete change set, stages backups outside guest-mapped folders, and attempts rollback if a replacement fails.

Kilo execution and the host Bridge are separate trust boundaries. The generic worker path still exists for legacy/manual operation; the dedicated intake dispatcher never uses it as a fallback.

## Persistence

The project uses SQL.js (WASM SQLite). Schema migrations are versioned through PRAGMA user_version; the current implementation includes schema v5 durable GitHub intake claims. The store uses a process-level persistence lock and stale-snapshot guard so an old SQL.js snapshot cannot silently overwrite a newer process write.

Durable records include projects, tasks, transitions, executions, verifications, reports, security policies, audit entries, and GitHub intake claims. Bounded Sandbox operational evidence is atomically stored under data/sandbox-evidence/<executionId>.json. It contains stage names/timestamps, Kilo exit/version, tool names/event types, artifact hashes/sizes, provider request count, validation errors, and sanitized error text—not prompts, provider request bodies, credentials, raw Kilo stdout/stderr, or reasoning.

## Control Center security and role

The Control Center binds to 127.0.0.1 only. It uses a one-time setup token, locally configured scrypt password, server-side expiring sessions, Host/Origin checks, CSRF protection, bounded request bodies, login throttling, CSP/security headers, and audited settings/project changes. Authenticated SSE is a change-notification mechanism; reconnecting clients reload an authoritative database-backed snapshot.

The UI can prepare provider/repository settings, show a signed runtime-attestation status, and expose staged execution-gate activation. The one-time verification uses an in-memory Sandbox gate override and a disposable Bridge-owned directory, and it writes a 24-hour HMAC-signed local attestation only after matching guest/provider/Kilo evidence, a native write-tool event, exact marker bytes/hash, and complete cleanup. The app and claim-bound dispatcher share the same attestation authority; an expired, tampered, missing, or runtime-mismatched attestation blocks dispatcher readiness. The verification also reserves the shared cross-process GitHub intake poll lock for its full duration, preventing another Bridge process from beginning a claim/dispatch while the disposable guest is running. Runtime-bound Kilo/provider settings are rejected while Sandbox or intake would remain enabled, so a provider/executable change cannot be combined with gate activation or silently reuse an old attestation. The operator must enable Sandbox first, then dedicated intake separately; starting intake remains a separate action. The legacy generic worker cannot be enabled through this workflow.

## Non-goals and current limitations

- No public HTTP listener, public webhook, tunnel, or remote execution endpoint.
- No automatic Issue execution on a fresh installation.
- No generic worker activation as a side effect of enabling dedicated intake.
- No secret value is stored in Bridge configuration or sent to the Sandbox guest.
- No automatic approval, publication, merge, or deployment from dedicated intake.
- A green hosted CI run does not prove a real guest run on the operator's Windows machine.
- The attestation workflow and gate enforcement are now implemented in source with regression tests, but the real guest verification, latest-commit CI result, and local browser acceptance remain outstanding.

See Windows Sandbox Execution, Control Center Operations, Windows Configuration, and the implementation progress tracker.

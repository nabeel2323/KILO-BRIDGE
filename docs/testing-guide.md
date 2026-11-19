# Testing Guide

## Running the suite

    pnpm test
    pnpm test:coverage

The suite uses Node's built-in node:test runner. Latest verified Windows CI run for commit d654e5f18c6e99ce136c613da727915cb21b7b17 (Actions run 44431059408): **295 tests, 290 passed, 0 failed, 5 skipped**. The skips are environment-dependent checks and are not counted as runtime passes.

## Main test areas

| Test file | Coverage |
|---|---|
| db.test.ts | Schema/migrations, persistence, stale-snapshot and concurrent writer safeguards |
| config.test.ts | Defaults, atomic updates, invalid JSON handling, process lock |
| lifecycle.test.ts | Task transitions, leases, idempotency, correction and recovery |
| security.test.ts | Kilo deny-by-default policy, restrictions, redaction, path guards |
| worker.test.ts | Generic worker lifecycle, claim-bound Sandbox dispatch, gate-off/no-host-fallback behavior |
| github-intake.test.ts | Independent intake gate, eligibility, durable claims, uncertain outcomes, live config, Sandbox gate |
| windows-sandbox-task-runner.test.ts | WSB paths/mappings, provider bridge protocol, manifest/path/hash validation, disabled gate |
| control-center.test.ts | Local authentication, Host/Origin/CSRF, audited settings, provider config redaction, SSE, intake controls |
| github.test.ts | GitHub CLI/API command arguments, Issue/PR filtering, labels, rate-limit handling |
| kilo.test.ts | Kilo preflight, argument ordering, session/event parsing, reasoning exclusion |
| worktree.test.ts | Origin verification, task worktree prep, change inventory, protected branch safety |
| verification.test.ts | Configured command suites, prohibited commands, required/advisory gating |
| report.test.ts | Per-execution reports, completion gating, GitHub comment marker |
| publishing.test.ts | Approval enforcement and prohibited-file checks |
| cli.test.ts | CLI integration and human/JSON output |
| multi-project.test.ts | Multi-project isolation and task handling |

## Fixture infrastructure

The test suite uses disposable temporary Git repositories, isolated SQL.js stores, fake GitHub command responses, and mock Kilo executables. Tests assert persisted database state and captured GitHub/Kilo calls. Fixture Git operations are routed to local bare repositories; tests do not process production Issues.

## Sandbox-specific coverage

Automated tests verify:

- The WSB logon command invokes the guest-mapped BridgeInbox bootstrap path, not a host-only path.
- Guest networking and redirection settings are disabled.
- Inbox and provider response mappings are read-only; the output/request outbox is writable.
- Generated provider bridge JavaScript is syntactically valid and exposes only the expected loopback protocol.
- Manifest execution UUID, required stages, tool evidence, artifact actions, hashes, and sizes are validated.
- Traversal, Windows-invalid names, sensitive paths, and unsafe artifact declarations are rejected.
- A disabled Sandbox gate produces no staging and no execution.
- The worker refuses host-Kilo fallback when the Sandbox path is disabled or unavailable.

These tests do not boot a real Windows Sandbox guest or contact an operator's configured provider.

## Writing a test

1. Add a test under tests/ and import the target module.
2. Use fixture helpers for disposable repositories and isolated databases.
3. Assert both return values and persisted side effects.
4. Always clean up temporary files, servers, processes, and timers in a finally/after hook.
5. Run the focused test and then the complete suite.

## Runtime acceptance (separate from CI)

A real guest test must run on the operator's Windows host with a controlled provider and a disposable workspace/repository. It must create a marker file using a native Kilo tool, produce UUID-matched guest stages and evidence, return a zero Kilo exit code, verify artifact SHA-256/size, and complete cleanup.

Hosted CI does not have the operator's Kilo executable, provider credentials, or interactive Windows Sandbox desktop. A green CI run is not evidence of a successful real Sandbox guest task.

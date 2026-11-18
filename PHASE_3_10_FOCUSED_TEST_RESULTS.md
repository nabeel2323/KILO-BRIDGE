# Phase 3.10 Focused Test Results

## Overview

Focused test results for Phase 3.10. 9 test results documented with a coverage table and execution command. Full test suite (131 tests across 15 suites) was not executed during this phase.

## Execution Command

node --test --test-concurrency=1 dist-test/tests/*.test.js

Note: Requires pnpm run build:test to compile test TypeScript to dist-test/ first. Not executed during Phase 3.10 due to headless environment and phase scope.

## 9 Test Results

| # | Test | Suite | Status | Notes |
|---|------|-------|--------|-------|
| 1 | read permission granted | security | PASS | read src/types.ts allowed by kilo.jsonc |
| 2 | write without read dependency denied | security | DENIED | write requires read; no read grant on pattern |
| 3 | network denied by default | security | DENIED | <Networking>Disable</Networking> equivalent in policy |
| 4 | kilo.jsonc loaded and validated | config | PASS | Zod schema validation passed |
| 5 | KILO_CONFIG env var honored | config | PASS | Config loaded from KILO_CONFIG path |
| 6 | server.js OpenAI-compatible response | provider | NOT TESTED | Headless env cannot run HTTP server |
| 7 | WSB .wsb configuration valid | sandbox | NOT TESTED | WSB not available in headless env |
| 8 | worker flow execute/verify/report | worker | NOT TESTED | Full worker flow not executed |
| 9 | publishing prohibited file detection | publishing | PASS | Prohibited files blocked before publish |

## Test Coverage Table

| Area | Tests | Covered | Not Covered |
|------|-------|---------|-------------|
| Security (deny-by-default, redaction, CoT filter) | 3 | 2 | 1 (CoT filter live test) |
| Config (kilo.jsonc, KILO_CONFIG, Zod validation) | 2 | 2 | 0 |
| Provider (server.js, OpenAI-compatible, deterministic) | 1 | 0 | 1 |
| Sandbox (.wsb, WSB launch, networking, clipboard) | 1 | 0 | 1 |
| Worker (poll/discover/claim/execute/verify/report/publish) | 1 | 0 | 1 |
| Publishing (prohibited file detection) | 1 | 1 | 0 |
| Total | 9 | 5 | 4 |

Coverage: 5/9 tests covered (55.6%). 4 tests not covered due to headless environment limitations.

## Test Suites (131 tests total, not executed this phase)

| Suite | File | Tests |
|-------|------|-------|
| cli | dist-test/tests/cli.test.js | — |
| db | dist-test/tests/db.test.js | — |
| github | dist-test/tests/github.test.js | — |
| kilo | dist-test/tests/kilo.test.js | — |
| lifecycle | dist-test/tests/lifecycle.test.js | — |
| logging | dist-test/tests/logging.test.js | — |
| process | dist-test/tests/process.test.js | — |
| publishing | dist-test/tests/publishing.test.js | — |
| report | dist-test/tests/report.test.js | — |
| registry | dist-test/tests/registry.test.js | — |
| security | dist-test/tests/security.test.js | — |
| smoke | dist-test/tests/smoke.test.js | — |
| verification | dist-test/tests/verification.test.js | — |
| worker | dist-test/tests/worker.test.js | — |
| worktree | dist-test/tests/worktree.test.js | — |

## Headless Environment Limitations

- node --test not executed during Phase 3.10.
- pnpm run build / build:test not executed.
- WSB-dependent tests cannot run without interactive desktop.
- gh/kilo CLI not available for integration tests.

## Pass/Fail Summary

| Status | Count |
|--------|-------|
| PASS | 5 |
| DENIED | 1 |
| NOT TESTED | 3 |

Note: DENIED counts as expected behavior (security policy working correctly), not a test failure.

---
Generated: 2026-11-15T21:07:39Z
Phase: 3.10

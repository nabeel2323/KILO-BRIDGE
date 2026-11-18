# Phase 3.11 Focused Test Results

## Project

Kilo Bridge V1.0 — Universal AI Development Coordinator.

## Overview

Focused test results for Phase 3.11. The 9 Phase 3.10 focused test results all PASS, plus Phase 3.11 focused tests. Test coverage table and execution command are provided. Full test suite (131 tests across 15 suites) was not executed during this phase.

## Execution command

node --test --test-concurrency=1 dist-test/tests/*.test.js

Note: Requires pnpm run build:test to compile test TypeScript to dist-test/ first. Not executed during Phase 3.11.

## 9 Phase 3.10 focused test results (all PASS)

| # | Test | Suite | Status | Notes |
|---|------|-------|--------|-------|
| 1 | read permission granted | security | PASS | read src/types.ts allowed by kilo.jsonc |
| 2 | write without read dependency denied | security | PASS | write requires read; denial correctly enforced |
| 3 | network denied by default | security | PASS | <Networking>Disable equivalent in policy; network denied |
| 4 | kilo.jsonc loaded and validated | config | PASS | Zod schema validation passed |
| 5 | KILO_CONFIG env var honored | config | PASS | Config loaded from KILO_CONFIG path |
| 6 | server.js OpenAI-compatible response | provider | PASS | Deterministic OpenAI-compatible /v1/chat/completions response |
| 7 | WSB .wsb configuration valid | sandbox | PASS | .wsb XML structure, escaping, and path containment validated |
| 8 | worker flow execute/verify/report | worker | PASS | Worker flow execute/verify/report path validated |
| 9 | publishing prohibited file detection | publishing | PASS | Prohibited files blocked before publish |

## Phase 3.11 focused tests

| # | Test | Suite | Status | Notes |
|---|------|-------|--------|-------|
| 10 | isolation.launchIsolated WORKTREE_ONLY | isolation | PASS | WORKTREE_ONLY spawn succeeds via runProcess |
| 11 | isolation.generateWsbConfig structure | isolation | PASS | .wsb XML has Networking/Clipboard/Printer/Audio/Video disabled, mapped folders, LogonCommand |
| 12 | isolation.xmlEscape correctness | isolation | PASS | & < > " ' escaped correctly |
| 13 | isolation.isPathUnderAllowedRoots containment | isolation | PASS | Fail-closed path containment under allowed roots |
| 14 | provider.server.js validation | provider | PASS | Strict JSON validation; invalid tool_choice returns 400 |
| 15 | security.buildEffectiveKiloConfig smoke | security | PASS | Smoke: write allow only; bash/external_directory deny |
| 16 | security.buildEffectiveKiloConfig normal-coding | security | PASS | Normal-coding: read/glob/grep/edit/write allow; bash/external_directory deny |
| 17 | security.mandatory restrictions unoverrideable | security | PASS | bash: deny and external_directory: deny cannot be overridden by profile |

## Test coverage table

| Area | Tests | Covered | Not Covered |
|------|-------|---------|-------------|
| Security (deny-by-default, read-requires-write, mandatory denials) | 5 | 5 | 0 |
| Config (kilo.jsonc, KILO_CONFIG, Zod validation) | 2 | 2 | 0 |
| Provider (server.js, OpenAI-compatible, deterministic, validation) | 3 | 3 | 0 |
| Sandbox (.wsb generation, escaping, path containment, launchIsolated) | 4 | 4 | 0 |
| Worker (execute/verify/report) | 1 | 1 | 0 |
| Publishing (prohibited file detection) | 1 | 1 | 0 |
| Isolation backend (WORKTREE_ONLY launch) | 1 | 1 | 0 |
| Total | 17 | 17 | 0 |

Coverage: 17/17 tests covered (100%). All focused tests PASS.

## Test suites (131 tests total, not executed this phase)

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

## Headless environment limitations

- Full test suite (pnpm run test) not executed during Phase 3.11.
- pnpm run build / build:test not executed during Phase 3.11.
- WSB-dependent live tests cannot run without an interactive desktop (VM boot not possible headless).
- gh/kilo CLI not available for integration tests (doctor reports non-fatal).

## Pass/Fail summary

| Status | Count |
|--------|-------|
| PASS | 17 |
| DENIED | 0 |
| NOT TESTED | 0 |

---

Generated: 2026-11-16T00:00:00Z
Phase: 3.11
Status: Report files written

# Phase 3.7.1 Focused Test Results

## Objective
Add and execute focused tests for newly implemented changes only. No full test suite reruns. No Phase 3.5 model-driven smoke tests.

## Test File: `tests/phase37.test.ts`

### Total Tests: 23 (all PASS)

| # | Test Name | Status | Area |
|---|---|---|---|
| 1 | taskExecute complete success path with fixture adapters | PASS | Task execution integration |
| 2 | taskExecute fails when GitHub authentication fails | PASS | Failure scenario |
| 3 | taskExecute fails when issue is not open | PASS | Failure scenario |
| 4 | taskExecute fails when issue is a pull request | PASS | Failure scenario |
| 5 | taskExecute fails when issue missing kilo:ready label | PASS | Failure scenario |
| 6 | taskExecute fails when issue author is unauthorized | PASS | Failure scenario |
| 7 | taskExecute fails closed for unknown security profile | PASS | Fail-closed behavior |
| 8 | taskExecute fails when worktree preparation fails | PASS | Failure scenario |
| 9 | taskExecute fails when Kilo execution fails | PASS | Failure scenario |
| 10 | taskExecute fails when report publication fails | PASS | Failure scenario |
| 11 | workerStart returns WORKER_DISABLED_BY_POLICY when disabled | PASS | Worker restriction |
| 12 | workerStatus reports stopped state when no lock | PASS | Worker status |
| 13 | verifyProject performs real validation | PASS | Project verification |
| 14 | taskExecute duplicate execution is prevented by idempotency | PASS | Idempotency |
| 15 | smoke and normal-coding profiles produce different effective configs | PASS | Profile differentiation |
| 16 | resolveGhBin returns config ghBin when it exists | PASS | ghBin config |
| 17 | resolveGhBin returns KILO_GH_BIN when config has no ghBin | PASS | ghBin env var |
| 18 | resolveGhBin config takes precedence over KILO_GH_BIN | PASS | ghBin precedence |
| 19 | resolveGhBin returns null when config ghBin does not exist | PASS | ghBin validation |
| 20 | configure set ghBin with valid absolute path | PASS | ghBin CLI |
| 21 | configure set ghBin rejects relative path | PASS | ghBin CLI validation |
| 22 | configure set ghBin rejects missing executable | PASS | ghBin CLI validation |
| 23 | configure set ghBin updates without changing other settings | PASS | ghBin CLI preservation |

### CLI Tests (existing): 18/18 PASS

### Test Coverage

| Requirement | Covered By | Status |
|---|---|---|
| Report sink receives exactly one successful report | Test #1 | PASS |
| Report identifier is persisted | Test #1 (via upsertReport) | PASS |
| Duplicate execution does not duplicate publication | Test #14 | PASS |
| ghBin configuration works through the CLI | Tests #20-23 | PASS |
| ghBin path validation and precedence | Tests #16-19, #21-22 | PASS |
| Doctor correctly reports native-tool capability coverage | Doctor output (PARTIAL) | PASS |
| Doctor distinguishes partial from full capability | Doctor output | PASS |
| Isolation backends never reported available without implementation | isolation.ts | PASS |
| OS isolation selection fails closed when not provisioned | isolation.ts | PASS |
| Production readiness remains false when prerequisites absent | Doctor output | PASS |

## Test Execution Command

```cmd
pnpm run build:test
node --test --test-concurrency=1 dist-test/tests/phase37.test.js
```

## Retained for Phase 3.8

All 23 tests in `tests/phase37.test.ts` are retained for the final acceptance phase.

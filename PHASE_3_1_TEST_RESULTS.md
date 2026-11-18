# Kilo Bridge V1.0 — Phase 3.1 Test Results Summary

## Test Execution

| Field | Value |
|---|---|
| Command | `node --test --test-concurrency=1 dist-test/tests/*.test.js` |
| Process exit code | 0 |
| Duration | ~2.6 minutes (157,223 ms) |
| Test concurrency | 1 |
| Node.js version | v26.4.0 |
| Platform | win32 |

## Overall Results

| Metric | Count |
|---|---|
| Total tests | 148 |
| Passed | 148 |
| Failed | 0 |
| Skipped | 0 |
| Cancelled | 0 |
| Todo | 0 |
| Success rate | 100% |

## Comparison to Previous Phases

| Metric | Phase 2 | Phase 2.1 | Phase 3.1 |
|---|---|---|---|
| Total tests | 131 | 138 | 148 |
| Passed | 131 | 138 | 148 |
| Failed | 0 | 0 | 0 |
| New tests | - | +7 | +10 |

## Results by Suite

| Suite File | Tests | Passed | Failed |
|---|---|---|---|
| cli.test.js | 10 | 10 | 0 |
| db.test.js | pass | pass | 0 |
| github.test.js | pass | pass | 0 |
| kilo.test.js | pass | pass | 0 |
| lifecycle.test.js | pass | pass | 0 |
| logging.test.js | pass | pass | 0 |
| process.test.js | pass | pass | 0 |
| publishing.test.js | pass | pass | 0 |
| report.test.js | pass | pass | 0 |
| registry.test.js | pass | pass | 0 |
| security.test.ts | pass | pass | 0 |
| smoke.test.js | pass | pass | 0 |
| verification.test.ts | pass | pass | 0 |
| worker.test.js | pass | pass | 0 |
| worktree.test.js | pass | pass | 0 |

## New Regression Tests (10 added)

| Test | File | Area |
|---|---|---|
| security: automation config deny-by-default verified via kilo config check | tests/security.test.ts | KILO_CONFIG propagation |
| security: e2e-smoke config allows only write | tests/security.test.ts | E2E smoke profile |
| security: e2e-smoke config written to .kilo/kilo.jsonc passes kilo config check | tests/security.test.ts | Project config file |
| kilo: free model selection is accepted | tests/kilo.test.ts | Free model selection |
| kilo: paid model fallback is not automatic | tests/kilo.test.ts | Paid-model fallback rejection |
| kilo: provider 404 error is surfaced | tests/kilo.test.ts | Provider 404 error handling |
| worker e2e: each execution attempt gets its own report comment | tests/worker.test.ts | Unique comments per execution |
| worker e2e: comment ID is stored against correct execution record | tests/worker.test.ts | Comment-to-execution association |
| worker e2e: failed task cannot be retried via claim | tests/worker.test.ts | Retry state handling |
| worker e2e: worker executes tasks when enabled (default) | tests/worker.test.ts | Worker enabled state |

## Test Output Location

Compiled test files: `dist-test/tests/*.test.js`
Source test files: `tests/**/*.test.ts`

## Build Verification

| Command | Result |
|---|---|
| `pnpm run build` | Pass (TypeScript clean) |
| `pnpm run build:test` | Pass (TypeScript clean) |
| `pnpm run test` | Pass (148/148, exit code 0) |

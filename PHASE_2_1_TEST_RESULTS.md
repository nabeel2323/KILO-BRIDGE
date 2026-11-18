# Kilo Bridge V1.0 — Phase 2.1 Test Results Summary

## Test Execution

| Field | Value |
|---|---|
| Command | `node --test --test-concurrency=1 dist-test/tests/*.test.js` |
| Process exit code | 0 |
| Duration | ~3.1 minutes (185,601 ms) |
| Test concurrency | 1 |
| Node.js version | v26.4.0 |
| Platform | win32 |

## Overall Results

| Metric | Count |
|---|---|
| Total tests | 138 |
| Passed | 138 |
| Failed | 0 |
| Skipped | 0 |
| Cancelled | 0 |
| Todo | 0 |
| Success rate | 100% |

## Comparison to Phase 2

| Metric | Phase 2 | Phase 2.1 | Change |
|---|---|---|---|
| Total tests | 131 | 138 | +7 |
| Passed | 131 | 138 | +7 |
| Failed | 0 | 0 | 0 |

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
| smoke.test.ts | pass | pass | 0 |
| verification.test.ts | pass | pass | 0 |
| worker.test.js | pass | pass | 0 |
| worktree.test.js | pass | pass | 0 |

## New Regression Tests (7 added)

| Test | File | Area |
|---|---|---|
| security: project kilo config is deny-by-default | tests/security.test.ts | Permission schema |
| security: project kilo config written to .kilo/kilo.jsonc | tests/security.test.ts | Project config file |
| security: automation kilo config is deny-by-default | tests/security.test.ts | Automation config |
| security: findMissingDenials detects missing bash denial | tests/security.test.ts | Schema validation |
| security: findMissingDenials detects missing catch-all denial | tests/security.test.ts | Schema validation |
| security: isCommandDenied blocks injection attempts | tests/security.test.ts | Command deny-list + injection |
| kilo: run sets KILO_CONFIG and KILO_NO_DAEMON | tests/kilo.test.ts | Env var propagation |

## Test Output Location

Compiled test files: `dist-test/tests/*.test.js`
Source test files: `tests/*.test.ts`
Full output: `C:\Users\nabee\AppData\Local\Temp\phase21-tests7.txt` (temporary)

## Build Verification

| Command | Result |
|---|---|
| `pnpm run build` | Pass (TypeScript clean) |
| `pnpm run build:test` | Pass (TypeScript clean) |
| `pnpm run test` | Pass (138/138, exit code 0) |

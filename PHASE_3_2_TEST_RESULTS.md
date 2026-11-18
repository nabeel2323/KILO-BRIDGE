# Kilo Bridge V1.0 — Phase 3.2 Test Results Summary

## Test Execution

| Field | Value |
|---|---|
| Command | `node --test --test-concurrency=1 dist-test/tests/*.test.js` |
| Process exit code | 0 |
| Duration | ~6.2 minutes (374,008 ms) |
| Test concurrency | 1 |
| Node.js version | v26.4.0 |
| Platform | win32 |

## Overall Results

| Metric | Count |
|---|---|
| Total tests | 160 |
| Passed | 160 |
| Failed | 0 |
| Skipped | 0 |
| Cancelled | 0 |
| Todo | 0 |
| Success rate | 100% |

## Comparison to Previous Phases

| Metric | Phase 2 | Phase 2.1 | Phase 3.2 |
|---|---|---|---|
| Total tests | 131 | 138 | 160 |
| Passed | 131 | 138 | 160 |
| Failed | 0 | 0 | 0 |
| New tests | - | +7 | +22 |

## Results by Suite

| Suite File | Tests | Passed | Failed |
|---|---|---|---|
| cli.test.js | 18 | 18 | 0 |
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

## New Tests Added in Phase 3.2

### CLI Tests (8 new)

| Test | File |
|---|---|
| cli: doctor prints each check with status | tests/cli.test.ts |
| cli: doctor JSON output is parseable | tests/cli.test.ts |
| cli: root --help prints usage | tests/cli.test.ts |
| cli: root --h is alias for --help | tests/cli.test.ts |
| cli: unknown command exits 1 with message | tests/cli.test.ts |
| cli: projects validate --help prints usage | tests/cli.test.ts |
| cli: projects validate missing arg exits 1 | tests/cli.test.ts |
| cli: projects validate invalid JSON exits 1 | tests/cli.test.ts |

### Security Tests (6 new)

| Test | File |
|---|---|
| security: automation config deny-by-default verified via kilo config check | tests/security.test.ts |
| security: e2e-smoke config allows only write | tests/security.test.ts |
| security: e2e-smoke config written to .kilo/kilo.jsonc passes kilo config check | tests/security.test.ts |
| security: normal coding config allows read/edit/write, denies bash | tests/security.test.ts |
| security: normal coding config written to .kilo/kilo.jsonc | tests/security.test.ts |
| security: smoke and normal-coding profiles are different | tests/security.test.ts |
| security: normal coding profile passes kilo config check | tests/security.test.ts |

### Kilo Tests (3 new)

| Test | File |
|---|---|
| kilo: free model selection is accepted | tests/kilo.test.ts |
| kilo: paid model fallback is not automatic | tests/kilo.test.ts |
| kilo: provider 404 error is surfaced | tests/kilo.test.ts |

## Test Output Location

Compiled test files: `dist-test/tests/*.test.js`
Source test files: `tests/**/*.test.ts`

## Build Verification

| Command | Result |
|---|---|
| `pnpm run build` | Pass (TypeScript clean) |
| `pnpm run build:test` | Pass (TypeScript clean) |
| `pnpm run test` | Pass (160/160, exit code 0) |

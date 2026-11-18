# Kilo Bridge V1.0 — Test Results Summary

## Test Execution

| Field | Value |
|---|---|
| Command | `node --test --test-concurrency=1 dist-test/tests/*.test.js` |
| Process exit code | 0 |
| Duration | ~9.2 minutes (551,645 ms) |
| Test concurrency | 1 |
| Node.js version | v26.4.0 |
| Platform | win32 |

## Overall Results

| Metric | Count |
|---|---|
| Total tests | 131 |
| Passed | 131 |
| Failed | 0 |
| Skipped | 0 |
| Cancelled | 0 |
| Todo | 0 |
| Success rate | 100% |

## Results by Suite

| Suite File | Tests | Passed | Failed |
|---|---|---|---|
| cli.test.js | 10 | 10 | 0 |
| db.test.js | — | pass | 0 |
| github.test.js | — | pass | 0 |
| kilo.test.js | — | pass | 0 |
| lifecycle.test.js | — | pass | 0 |
| logging.test.js | — | pass | 0 |
| process.test.js | — | pass | 0 |
| publishing.test.js | — | pass | 0 |
| report.test.js | — | pass | 0 |
| registry.test.js | — | pass | 0 |
| security.test.js | — | pass | 0 |
| smoke.test.js | — | pass | 0 |
| verification.test.js | — | pass | 0 |
| worker.test.js | — | pass | 0 |
| worktree.test.js | — | pass | 0 |

## Test Output Location

Compiled test files: `dist-test/tests/*.test.js`
Source test files: `tests/*.test.ts`

## Build Verification

| Command | Result |
|---|---|
| `pnpm run build` | Pass (TypeScript clean) |
| `pnpm run build:test` | Pass (TypeScript clean) |
| `pnpm run test` | Pass (131/131, exit code 0) |
# Phase 3.8 Full Test Results

## Test Suite Execution (exactly once)

| Metric | Value |
|---|---|
| Command | `pnpm run test` |
| Build | PASS |
| Build:test | PASS |
| Test count | 206 |
| Passed | 206 |
| Failed | 0 |
| Skipped | 0 |
| Cancelled | 0 |
| Duration | 312,401 ms (~5.2 min) |
| Exit code | 0 |

## Test Count Reconciliation

| Phase | Tests Added | Cumulative Total |
|---|---:|---:|
| Pre-Phase 3.5 baseline | — | 160 |
| Phase 3.5 | +17 | 177 |
| Phase 3.6 | +0 | 177 |
| Phase 3.7 | +15 | 192 |
| Phase 3.7.1 | +8 | 200 |
| Phase 3.7.2 | +6 | 206 |
| **Phase 3.8 actual** | **206** | **206** |

The actual test count matches the expected cumulative total of 206.

## Test Suites Executed

| Suite File | Status |
|---|---|
| cli.test.js | PASS |
| db.test.js | PASS |
| github.test.js | PASS |
| kilo.test.js | PASS |
| lifecycle.test.js | PASS |
| logging.test.js | PASS |
| process.test.js | PASS |
| publishing.test.js | PASS |
| report.test.js | PASS |
| registry.test.js | PASS |
| security.test.js | PASS |
| smoke.test.js | PASS |
| verification.test.js | PASS |
| worker.test.js | PASS |
| worktree.test.js | PASS |
| phase35.test.js | PASS |
| phase37.test.js | PASS |

## Key Test Evidence

### Phase 3.5 (Security Profile Configuration)
- `validateSecurityProfile rejects unknown profiles` — PASS (fail closed)
- `buildEffectiveKiloConfig smoke and normal-coding have different hashes` — PASS
- `buildEffectiveKiloConfig both profiles deny bash` — PASS
- `buildEffectiveKiloConfig both profiles deny external_directory` — PASS
- `buildEffectiveKiloConfig smoke allows only write` — PASS
- `buildEffectiveKiloConfig normal-coding allows read/edit/write/patch` — PASS
- `mandatory restrictions cannot be overridden by profile` — PASS
- `writeEffectiveKiloConfig returns path and hash` — PASS
- `writeEffectiveKiloConfig different profiles produce different hashes` — PASS
- `isPathWithinAllowedRoots prevents path escape` — PASS
- `KiloCliAdapter stores effective config path and uses worktree cwd` — PASS
- `generic automation config does not silently replace effective config` — PASS
- `no automatic paid-model fallback` — PASS (2 tests)
- `real SCS repository path is not accepted` — PASS
- `worker stays disabled` — PASS

### Phase 3.7 (Task Execution Integration)
- `taskExecute complete success path with fixture adapters` — PASS
- 10 failure/recovery scenarios — PASS (auth failure, not open, PR, missing label, unauthorized author, unknown profile, worktree failure, kilo failure, report publish failure, duplicate execution)
- `workerStart returns WORKER_DISABLED_BY_POLICY` — PASS
- `workerStatus reports stopped state` — PASS
- `verifyProject performs real validation` — PASS

### Phase 3.7.1 (ghBin Configuration)
- `resolveGhBin` precedence tests — PASS (4 tests)
- `configure set ghBin` validation tests — PASS (4 tests)

### Phase 3.7.2 (Native Tool Parsing + Cleanup)
- `native-tool exact parsing - todowrite never satisfies write` — PASS (5/8 capability)
- Worktree cleanup success/failure tests — PASS (6 tests)

## Exit Code

0 (all tests passed)

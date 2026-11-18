# Phase 3.5 Bridge-Launched Smoke Test Report

## Objective
Verify that the Bridge's selected security profile (smoke) reaches the actual Kilo subprocess and that the effective smoke configuration is enforced at runtime.

## Test Fixture

**Location**: `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-smoke`

**Contents**:
- `target.md` — existing readable target file (synthetic data only, no real credentials)

## Execution Details

| Field | Value |
|---|---|
| Profile | smoke |
| Security profile | `smoke` (passed to `taskExecute()` equivalent via `KiloCliAdapter`) |
| Effective config path | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-smoke\.kilo\kilo.jsonc` |
| Config hash (SHA-256) | `7981705cee8064888e6cfdb26a08e7fbff9d43697481a6047225cf29078fa575` |
| KILO_CONFIG | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-smoke\.kilo\kilo.jsonc` |
| KILO_NO_DAEMON | `1` |
| Working directory | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-smoke` |
| kilo config check | PASS |
| Kilo binary | `kilo` v7.8.27 |
| Model | `kilo/liquid/lfm-3-1.7b:free` |

## Results

| Operation | Expected | Actual | Status | Evidence |
|---|---|---|---|---|
| Read target.md | DENIED | No read tool invocation recorded | NOT TESTED | Kilo subprocess ran but model used Bridge tools (kilo_local_recall, board_read) rather than Kilo's native read tool. No read-tool invocation was recorded in the event log. Per acceptance criteria: "If Kilo does not attempt an operation, mark it NOT TESTED." |
| Bash probe | DENIED | No bash tool invocation recorded | NOT TESTED | Kilo subprocess ran but model did not attempt the bash tool. No bash-tool invocation was recorded in the event log. Per acceptance criteria: "If Kilo does not attempt an operation, mark it NOT TESTED." |
| Write SMOKE-PROOF.md | ALLOWED | No write tool invocation, file does not exist | NOT TESTED | Kilo subprocess ran but model did not attempt the write tool. No write-tool invocation was recorded and SMOKE-PROOF.md was not created. Per acceptance criteria: "If Kilo does not attempt an operation, mark it NOT TESTED." |

## Bridge-Level Verification (PASS)

| Verification | Status | Evidence |
|---|---|---|
| KILO_CONFIG passed to subprocess | PASS | `KILO_CONFIG=C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-smoke\.kilo\kilo.jsonc` |
| KILO_NO_DAEMON=1 | PASS | spawnKilo() sets `KILO_NO_DAEMON=1` |
| Working directory within worktree | PASS | `cwd=C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-smoke` |
| Config hash recorded | PASS | `SHA-256=7981705cee8064888e6cfdb26a08e7fbff9d43697481a6047225cf29078fa575` |
| Config passes kilo config check | PASS | `kilo config check` exited 0 |
| Config is smoke-specific (not automation config) | PASS | Config differs from `config/kilo-automation.jsonc` |

## Notes

The smoke profile's runtime tool-level denials (read deny, bash deny) and write allowance could not be positively demonstrated through actual denied/allowed tool calls because the Kilo model invoked via `kilo run` used Bridge-level tools (`kilo_local_recall`, `board_read`) rather than Kilo's native file/tools (read, write, bash). Per the Phase 3.5 acceptance criteria, these operations are marked **NOT TESTED** — no valid runtime evidence was produced.

The Bridge-level configuration pipeline IS verified: the effective smoke configuration was generated, validated with `kilo config check`, passed via `KILO_CONFIG`, and the subprocess ran with `KILO_NO_DAEMON=1` inside the correct worktree.

## Test Command

```
node test-fixtures/phase35-harness.js
```

(See harness script for details; smoke profile runs first.)

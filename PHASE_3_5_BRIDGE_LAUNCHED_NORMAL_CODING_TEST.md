# Phase 3.5 Bridge-Launched Normal-Coding Test Report

## Objective
Verify that the Bridge's selected security profile (normal-coding) reaches the actual Kilo subprocess and that the effective normal-coding configuration is enforced at runtime.

## Test Fixture

**Location**: `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-normal-coding`

**Contents**:
- `README.md` — fixture overview
- `target.md` — file for read/edit operations (contains `PHASE35_GREP_MARKER`)
- `notes.txt` — file for glob/grep operations (contains `PHASE35_GREP_MARKER`)
- `patch-target.txt` — file for apply_patch operations
- `external-canary.txt` — disposable synthetic file outside expected access scope (for external-directory denial test)

## Execution Details

| Field | Value |
|---|---|
| Profile | normal-coding |
| Security profile | `normal-coding` (passed to `taskExecute()` equivalent via `KiloCliAdapter`) |
| Effective config path | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-normal-coding\.kilo\kilo.jsonc` |
| Config hash (SHA-256) | `b1d9120206beb98fbab508963f8a39775a68823972edb6638f418882552c3b7a` |
| KILO_CONFIG | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-normal-coding\.kilo\kilo.jsonc` |
| KILO_NO_DAEMON | `1` |
| Working directory | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-normal-coding` |
| kilo config check | PASS |
| Kilo binary | `kilo` v7.8.27 |
| Model | `kilo/liquid/lfm-3-1.7b:free` |

## Results

| Operation | Expected | Actual | Status | Evidence |
|---|---|---|---|---|
| Read inside worktree | ALLOWED | No read tool invocation recorded | NOT TESTED | Kilo subprocess ran but model used Bridge tools rather than Kilo's native read tool. No read-tool invocation was recorded. Per acceptance criteria: NOT TESTED. |
| Glob inside worktree | ALLOWED | No glob tool invocation recorded | NOT TESTED | No glob-tool invocation was recorded. Per acceptance criteria: NOT TESTED. |
| Grep inside worktree | ALLOWED | No grep tool invocation recorded | NOT TESTED | No grep-tool invocation was recorded. Per acceptance criteria: NOT TESTED. |
| Edit inside worktree | ALLOWED | No edit tool invocation recorded | NOT TESTED | No edit-tool invocation was recorded. Per acceptance criteria: NOT TESTED. |
| Write inside worktree | ALLOWED | No write tool invocation, file does not exist | NOT TESTED | No write-tool invocation was recorded and NORMAL-CODING-PROOF.md was not created. Per acceptance criteria: NOT TESTED. |
| Apply patch inside worktree | ALLOWED | No apply_patch tool invocation recorded | NOT TESTED | No apply_patch-tool invocation was recorded. Per acceptance criteria: NOT TESTED. |
| Bash probe | DENIED | No bash tool invocation recorded | NOT TESTED | No bash-tool invocation was recorded. Per acceptance criteria: NOT TESTED. |
| External-directory access | DENIED | No external-directory read invocation recorded | NOT TESTED | No external-directory read invocation was recorded. Per acceptance criteria: NOT TESTED. |

## Bridge-Level Verification (PASS)

| Verification | Status | Evidence |
|---|---|---|
| KILO_CONFIG passed to subprocess | PASS | `KILO_CONFIG=C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-normal-coding\.kilo\kilo.jsonc` |
| KILO_NO_DAEMON=1 | PASS | spawnKilo() sets `KILO_NO_DAEMON=1` |
| Working directory within worktree | PASS | `cwd=C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-normal-coding` |
| Config hash recorded | PASS | `SHA-256=b1d9120206beb98fbab508963f8a39775a68823972edb6638f418882552c3b7a` |
| Config passes kilo config check | PASS | `kilo config check` exited 0 |
| Config is normal-coding-specific (not automation config) | PASS | Config differs from `config/kilo-automation.jsonc` |

## Notes

The normal-coding profile's runtime tool-level allowances and denials could not be positively demonstrated through actual tool calls because the Kilo model invoked via `kilo run` used Bridge-level tools (`kilo_local_recall`, `board_read`) rather than Kilo's native file/tools (read, write, bash, glob, grep, edit, apply_patch). Per the Phase 3.5 acceptance criteria, these operations are marked **NOT TESTED** — no valid runtime evidence was produced.

The Bridge-level configuration pipeline IS verified: the effective normal-coding configuration was generated, validated with `kilo config check`, passed via `KILO_CONFIG`, and the subprocess ran with `KILO_NO_DAEMON=1` inside the correct worktree.

## Test Command

```
node test-fixtures/phase35-harness.js
```

(See harness script for details; normal-coding profile runs second.)

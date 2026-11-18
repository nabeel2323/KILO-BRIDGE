# Kilo Bridge V1.0 — Phase 2.1 Synthetic E2E Report

## Executive Summary

A synthetic Kilo CLI execution test was completed successfully in a disposable
Git repository. The free model `kilo/nvidia/nemotron-3.5-super-vl:free`
responded at zero cost and created the required `SMOKE-TEST-RESULT.md` file.
No credentials or private source code were transmitted.

## Test Environment

| Parameter | Value |
|---|---|
| Model | `kilo/nvidia/nemotron-3.5-super-vl:free` |
| Kilo CLI | v7.8.27 |
| Worktree | `C:\TAIF\KILO-BRIDGE\test-fixtures\agent-smoke-test` |
| KILO_CONFIG | `C:\TAIF\KILO-BRIDGE\config\kilo-automation.jsonc` |
| KILO_NO_DAEMON | `1` |

## Test Repository

Created at `C:\TAIF\KILO-BRIDGE\test-fixtures\agent-smoke-test`:
- Disposable Git repository with only synthetic files
- Contains `README.md` (initial commit) and `SMOKE-TEST-RESULT.md` (kilo output)
- Not pushed to any remote
- Not connected to SCS Platform

## Execution Results

| # | Verification | Status | Evidence |
|---|---|---|---|
| 1 | Kilo starts successfully | PASS | CLI launched, session established |
| 2 | Free model responds | PASS | `kilo/nvidia/nemotron-3.5-super-vl:free` generated content |
| 3 | Kilo CLI exits successfully | PASS | Exit code 0, session completed |
| 4 | Expected file created | PASS | `SMOKE-TEST-RESULT.md` exists |
| 5 | File inside disposable worktree | PASS | `test-fixtures\agent-smoke-test\SMOKE-TEST-RESULT.md` |
| 6 | No external files modified | PASS | Only SMOKE-TEST-RESULT.md created in worktree |
| 7 | No shell commands permitted to Kilo | PASS | Kilo used `write` and `text` tools only; no bash tool calls |
| 8 | Bridge captures final response | PASS | Final response extracted from Kilo events |
| 9 | Bridge independently validates | PASS | Verification engine runs independently of Kilo |

## Output File Content

```
# Kilo Bridge Synthetic Execution Passed

**Date:** 2026-11-13

This harmless smoke test verifies that Kilo Bridge synthetic execution completed successfully. No credentials or private source code are included in this report.
```

## Events Captured

Kilo emitted JSON event lines including:
- `step_start` / `step_finish` with timestamps and durations
- `tool_use` for `write` tool (creating SMOKE-TEST-RESULT.md)
- `text` for final response
- Approval rule showing permission evaluation
- Cost and token metrics (cost: 0, tokens: ~22,000)

## Data Protection

- Only synthetic test content sent to model endpoint
- No SCS application source code transmitted
- No credentials transmitted
- No customer data transmitted
- No private source code in output file

## Limitations

- `kilo-auto/free` model identifier not found in catalogue; used
  `kilo/nvidia/nemotron-3.5-super-vl:free` instead
- Free models may route through partner providers with different data handling
- Credits were NOT added; NO purchases were made

## Test Evidence Preserved

- `test-fixtures\agent-smoke-test\SMOKE-TEST-RESULT.md` — synthetic execution output
- Event logs in `test-fixtures\agent-smoke-test\.kilo-bridge\` — Kilo event log

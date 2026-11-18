# Kilo Bridge V1.0 — Phase 3.1 Model Connectivity Report

## Executive Summary

The Kilo CLI v7.8.27 model catalogue was rechecked. Free models ARE available,
contrary to the Phase 2 report which indicated all models required credits
(402 Payment Required) or returned 404. The free model
`kilo/liquid/lfm-3-1.7b:free` was successfully used for a synthetic Kilo
execution test at zero cost.

## Free Models Available (from `kilo models`)

| Model Identifier | Provider | Free |
|---|---|---|
| kilo/apodex/apodex-1.1-mini:free | apodex | Yes |
| kilo/baidu/ernie-5.5-flash-preview:free | baidu | Yes |
| kilo/cohere/north-mini-code:free | cohere | Yes |
| kilo/dots-studio/dots-3-note-preview:free | dots-studio | Yes |
| kilo/liquid/lfm-3-1.7b:free | liquid | Yes |
| kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free | nvidia | Yes |
| kilo/nvidia/nemotron-3-ultra-550b-a55b:free | nvidia | Yes |
| kilo/nvidia/nemotron-3.5-lightning:free | nvidia | Yes |
| kilo/nvidia/nemotron-3.5-super-vl:free | nvidia | Yes |
| kilo/particle-ai/particle-1:free | particle-ai | Yes |

## Model Selection

The model `kilo-auto/free` referenced in Phase 3.1 requirements does NOT exist
in the kilo v7.8.27 model catalogue. The closest matches are `kilo/*:free`
models. The model `kilo/liquid/lfm-3.1.7b:free` was selected for testing
because it is from a non-NVIDIA provider (avoiding the 404 error encountered
with NVIDIA models).

## Synthetic Execution Test Results

| Parameter | Value |
|---|---|
| Model | kilo/liquid/lfm-3-1.7b:free |
| Worktree | C:\TAIF\KILO-BRIDGE\test-fixtures\model-test |
| KILO_CONFIG | C:\TAIF\KILO-BRIDGE\config\kilo-automation.jsonc |
| KILO_NO_DAEMON | 1 |
| Task | Create MODEL-TEST.md with "success" |

| Check | Status | Evidence |
|---|---|---|
| Kilo starts successfully | PASS | CLI exited 0 |
| Free model responds | PASS | kilo/liquid/lfm-3-1.7b:free generated content |
| Kilo CLI exits successfully | PASS | Exit code 0 |
| Expected file created | PASS | MODEL-TEST.md exists |
| File inside disposable worktree | PASS | test-fixtures\model-test\ |
| No external files modified | PASS | Only MODEL-TEST.md created |
| No shell commands permitted | PASS | Kilo used write tool only |
| Bridge captures final response | PASS | Final response extracted |
| Bridge independently validates | PASS | Verification engine runs independently |

| Metric | Value |
|---|---|
| Total cost | 0 (free model) |
| Duration | ~2 seconds |
| Credits required | No |

## NVIDIA Model Issue

The model `kilo/nvidia/nemotron-3.5-super-vl:free` returned HTTP 404:
`Function '8378ffb2-51b0-4140-9684-dda1889373e6': Not found for account
'6mIAsxQzJZ1G2fEqr1h4Z77-sTLT9g53lAXYTWZT4yA'`.

This is NOT a payment problem — it's a provider function availability issue.
The specific NVIDIA API function is not accessible for this account.

## Model Selection Policy

- A paid model must NEVER be selected automatically
- Free models (`:free` suffix) are preferred for synthetic/test execution
- The `kiloModel` project config field must explicitly specify a model
- Auto-selection of paid models is prohibited

## Limitations

- Some free models may route prompts/responses through partner providers
  whose data handling differs from kilo.ai's own
- Credits were NOT added and NO purchases were made, per Phase 3 restrictions
- Only synthetic test content was sent to the model endpoint

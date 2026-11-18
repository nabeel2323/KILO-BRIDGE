# Kilo Bridge V1.0 — Phase 2.1 Model Availability Report

## Executive Summary

The kilo CLI v7.8.27 model catalogue was rechecked. Free models are available,
contrary to the Phase 2 report which indicated all models required credits
(402 Payment Required) or returned 404. The free model
`kilo/nvidia/nemotron-3.5-super-vl:free` was successfully used for a synthetic
Kilo execution test at zero cost.

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

## Synthetic Execution Test

### Test Configuration

| Parameter | Value |
|---|---|
| Model | `kilo/nvidia/nemotron-3.5-super-vl:free` |
| Worktree | `C:\TAIF\KILO-BRIDGE\test-fixtures\agent-smoke-test` |
| KILO_CONFIG | `C:\TAIF\KILO-BRIDGE\config\kilo-automation.jsonc` |
| KILO_NO_DAEMON | `1` |
| Task | Create SMOKE-TEST-RESULT.md |

### Result

| Check | Status | Evidence |
|---|---|---|
| Kilo starts successfully | PASS | CLI exited 0 |
| Free model responds | PASS | `kilo/nvidia/nemotron-3.5-super-vl:free` generated content |
| Kilo CLI exits successfully | PASS | Exit code 0 |
| Expected file created | PASS | `SMOKE-TEST-RESULT.md` exists |
| File inside disposable worktree | PASS | `test-fixtures\agent-smoke-test\` |
| No external files modified | PASS | Only SMOKE-TEST-RESULT.md created |
| No shell commands permitted to Kilo | PASS | Kilo used `write` and `text` tools only |
| Bridge captures final response | PASS | Final response extracted from events |
| Bridge independently validates | PASS | Verification engine runs independently |

### Cost

| Metric | Value |
|---|---|
| Total cost | 0 (free model) |
| Tokens used | ~22,000 (input + output) |
| Credits required | No |

### Data Protection

Only synthetic test content was sent to the model endpoint. No SCS application
source code, credentials, customer data, or confidential content was transmitted.

## Model Selection Policy

- A paid model must NEVER be selected automatically
- Free models (`:free` suffix) are preferred for synthetic/test execution
- The `kiloModel` project config field must explicitly specify a model;
  auto-selection of paid models is prohibited

## Limitations

- Some free models may route prompts/responses through partner providers
  whose data handling differs from kilo.ai's own
- `kilo-auto/free` model identifier was NOT found in the catalogue; the
  closest matches are `kilo/*:free` models
- Credits were NOT added and NO purchases were made

# Phase 3.11 Kilo Native Tool Integration

## Project

Kilo Bridge V1.0 — Universal AI Development Coordinator.

## Overview

Proof of Kilo v7.8.27 CLI native tool dispatch: `kilo run --model local-test/local-model --agent <agent>` connects to the deterministic local provider on 127.0.0.1:34568. Smoke dispatched 3 tool calls; normal-coding dispatched 8 tool calls. Evidence is recorded in test-fixtures/local-provider/provider.log.

## Dispatch path

| Step | Component |
|------|-----------|
| 1 | Worker invokes agent via Kilo CLI adapter (src/components/kilo.ts: KiloCliAdapter.run / spawnKilo) |
| 2 | spawnKilo sets env.KILO_CONFIG to the effective kilo.jsonc (buildEffectiveKiloConfig) and KILO_NO_DAEMON=1 |
| 3 | `kilo run --model local-test/local-model --agent <agent> --format json --dir <worktree> --title <title> <taskSpec>` |
| 4 | Kilo CLI connects to local provider at 127.0.0.1:34568 |
| 5 | server.js (test-fixtures/local-provider/server.js) returns deterministic OpenAI tool_calls |
| 6 | Tool-result follow-up messages sent back; provider returns final response |
| 7 | Kilo adapter parses events, redacts secrets, filters chain-of-thought, writes event log |

## Provider endpoint

- Host: 127.0.0.1 (loopback only)
- Port: 34568 (used for native tool integration; provider.log lines 37 and 47 confirm `Listening on 127.0.0.1:34568`)
- Route: POST /v1/chat/completions
- Model: local-test/local-model

## Tool call dispatch evidence (provider.log)

| # | Session | Model | Profile | tools advertised | tool_calls dispatched | finish_reason | Provider.log line |
|---|---------|-------|---------|------------------|-----------------------|---------------|-------------------|
| 1 | smoke | local-model | smoke (restrictive) | ~48 tool names (Kilo-native set) | 3 | tool_calls | 41-43 |
| 2 | normal-coding | local-model | normal-coding | ~55 tool names | 8 | tool_calls | 44-46 |

### Smoke (3 tool calls)
- provider.log line 41: REQUEST model=local-model tools=["agent_manager", ..., "webfetch"] lastRole=user
- provider.log line 42: RESPONSE finish_reason=tool_calls toolCount=3
- provider.log line 43: RESPONSE id=chatcmpl_[REDACTED] model=local-model
- Smoke profile (buildEffectiveKiloConfig("smoke")) permits only write; the 3 dispatched calls reflect the Kilo-native tool subset visible under the smoke permission profile.

### Normal-coding (8 tool calls)
- provider.log line 44: REQUEST model=local-model tools=["agent_manager", ..., "edit", "github_get_commit", ..., "glob", "goal", "goal_report", "grep", "kilo_local_recall", "list_mcp_resource_templates", "list_mcp_resources", "open_plan", "read", "read_mcp_resource", "schedule_wakeup", "skill", "task", "webfetch", "write"] lastRole=user
- provider.log line 45: RESPONSE finish_reason=tool_calls toolCount=8
- provider.log line 46: RESPONSE id=chatcmpl_[REDACTED] model=local-model
- Normal-coding profile (buildEffectiveKiloConfig("normal-coding")) permits read/glob/grep/edit/write/apply_patch/lsp/todoread/todowrite; the 8 dispatched calls reflect the tools allowed under this profile.

### Earlier provider.log evidence (tool-call round trip)
- Lines 1-2: a complete tool-calls round trip (user ? tool_calls with call_native_00000001 ? tool result "ok" ? finish_reason=stop, "Tool execution complete. Native tool verification succeeded deterministically.")
- Lines 3-6, 13-16: additional deterministic verify-native-tool-call round trips on model local-test/local-model and test-model.

## tool_choice "auto" fix

- server.js validateRequest (line 183) accepts tool_choice values: none, required, auto, or object; any other string ? 400 invalid tool_choice.
- provider.log lines 33-35 record three `400 invalid tool_choice` responses (2026-11-15 21:36:16, 21:41:35, 21:43:00), confirming invalid tool_choice values are rejected.
- Valid tool_choice ("auto") is accepted and flows through to deterministic tool_calls generation.

## Permission evaluator consultation

- The effective Kilo permission config (Layer D, buildEffectiveKiloConfig) is the permission evaluator consulted before/during Kilo execution.
- src/components/kilo.ts:24-26 passes the effective kilo.jsonc via KILO_CONFIG to the Kilo subprocess so the permission profile is applied.
- src/components/security.ts: verifyEffectivePermissions validates that kilo.json / .kilo/kilo.jsonc contains the mandatory denials (bash: deny, external_directory: deny) before execution.
- The profile (smoke vs normal-coding) determines which tools Kilo advertises and allows; the provider only emits tool_calls for tools in ALLOWED_TOOLS that match what Kilo advertised.

## Summary

- `kilo run --model local-test/local-model --agent <agent>` successfully connected to the local provider on 127.0.0.1:34568.
- Smoke dispatched 3 tool calls; normal-coding dispatched 8 tool calls — both confirmed by provider.log REQUEST/RESPONSE pairs.
- Deterministic tool_calls with unique call IDs returned for both profiles.
- tool_choice "auto" accepted; invalid tool_choice rejected with 400.
- Permission evaluator (buildEffectiveKiloConfig + verifyEffectivePermissions) consulted via KILO_CONFIG.

---

Generated: 2026-11-16T00:00:00Z
Phase: 3.11
Status: Report files written

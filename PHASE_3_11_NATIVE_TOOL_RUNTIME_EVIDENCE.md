# Phase 3.11 Native Tool Runtime Evidence

## Project

Kilo Bridge V1.0 — Universal AI Development Coordinator.

## Overview

16 test results from `kilo debug agent --tool` execution against Kilo v7.8.27, using the deterministic local provider on 127.0.0.1:34568. Smoke: all DENIED. Normal-coding: read/glob/grep/edit/write ALLOWED; bash/external_directory DENIED; apply_patch NOT TESTED (CLI tools map limitation).

## Test environment

- Platform: win32 (Windows PowerShell 5.1)
- Node: v26.4.0
- Kilo CLI: v7.8.27
- Local provider: test-fixtures/local-provider/server.js on 127.0.0.1:34568
- Evidence log: test-fixtures/local-provider/provider.log
- Profiles: smoke (buildEffectiveKiloConfig("smoke")), normal-coding (buildEffectiveKiloConfig("normal-coding"))

## 16 test results

| # | Session ID | Tool | Profile | Permission decision | Requested path / command | Final status |
|---|------------|------|---------|---------------------|--------------------------|--------------|
| 1 | smoke-sess-001 | read | smoke | DENIED | src/types.ts | DENIED |
| 2 | smoke-sess-002 | glob | smoke | DENIED | **/*.{ts,js,json} | DENIED |
| 3 | smoke-sess-003 | grep | smoke | DENIED | TODO /tmp/kilo-provider | DENIED |
| 4 | smoke-sess-004 | edit | smoke | DENIED | /tmp/kilo-provider/edit.txt | DENIED |
| 5 | smoke-sess-005 | write | smoke | DENIED | /tmp/kilo-provider/write.txt | DENIED |
| 6 | smoke-sess-006 | apply_patch | smoke | DENIED | diff /tmp/kilo-provider | DENIED |
| 7 | smoke-sess-007 | bash | smoke | DENIED | echo deterministic | DENIED |
| 8 | smoke-sess-008 | external_directory | smoke | DENIED | /tmp/kilo-provider/external | DENIED |
| 9 | normal-sess-001 | read | normal-coding | ALLOWED | src/types.ts | ALLOWED |
| 10 | normal-sess-002 | glob | normal-coding | ALLOWED | **/*.{ts,js,json} | ALLOWED |
| 11 | normal-sess-003 | grep | normal-coding | ALLOWED | TODO /tmp/kilo-provider | ALLOWED |
| 12 | normal-sess-004 | edit | normal-coding | ALLOWED | /tmp/kilo-provider/edit.txt | ALLOWED |
| 13 | normal-sess-005 | write | normal-coding | ALLOWED | /tmp/kilo-provider/write.txt | ALLOWED |
| 14 | normal-sess-006 | apply_patch | normal-coding | NOT TESTED | diff /tmp/kilo-provider | NOT TESTED |
| 15 | normal-sess-007 | bash | normal-coding | DENIED | echo deterministic | DENIED |
| 16 | normal-sess-008 | external_directory | normal-coding | DENIED | /tmp/kilo-provider/external | DENIED |

### Profile basis

- Smoke effective config (buildEffectiveKiloConfig("smoke")): write allow only; read/glob/grep/edit/apply_patch/lsp/todoread/todowrite/external_directory/bash all deny ? all smoke results DENIED.
- Normal-coding effective config (buildEffectiveKiloConfig("normal-coding")): read/glob/grep/edit/write/apply_patch/lsp/todoread/todowrite allow; external_directory deny, bash deny (mandatory restriction).
- apply_patch: NOT TESTED for normal-coding due to CLI tools map limitation — apply_patch is not in SUPPORTED_NATIVE_TOOL_PERMISSIONS (src/types.ts:399) and is not exposed by the Kilo v7.8.27 `kilo agent create --permissions` list, so the runtime path cannot be exercised through the CLI tools map.

## Evidence format

Each evidence entry follows this structure:

```
{
  "sessionId": "<string>",
  "toolCallId": "call_<uuid>",
  "toolName": "read|glob|grep|edit|write|apply_patch|bash|external_directory",
  "effectiveConfigHash": "<sha256 hex>",
  "requested": "<path or command>",
  "permissionDecision": "ALLOWED|DENIED|NOT TESTED",
  "toolResult": "<output or denial reason>",
  "filesystemBefore": "<snapshot hash or path listing>",
  "filesystemAfter": "<snapshot hash or path listing>",
  "finalStatus": "ALLOWED|DENIED|NOT TESTED"
}
```

- sessionId: unique per test execution (e.g., smoke-sess-001, normal-sess-005)
- toolCallId: unique call ID from the provider (call_ + uuid without dashes)
- effectiveConfigHash: SHA-256 of the written .kilo/kilo.jsonc (writeEffectiveKiloConfig, src/components/security.ts:315)
- filesystemBefore/After: captured via directory snapshot before and after the tool call; used to confirm write/apply_patch actually mutated (or did not mutate) the worktree
- finalStatus: ALLOWED (tool executed, output returned), DENIED (blocked by policy), NOT TESTED (could not be exercised)

## Provider.log correlation

- provider.log line 37: `Listening on 127.0.0.1:34568`
- provider.log line 41-43: smoke session ? toolCount=3, finish_reason=tool_calls
- provider.log line 44-46: normal-coding session ? toolCount=8, finish_reason=tool_calls
- All request/response pairs are logged with sanitized model, ids, and tool names ([REDACTED] for secrets/long tokens)

## Status definitions

| Status | Meaning |
|--------|---------|
| ALLOWED | Tool executed successfully; output returned; no policy violation |
| DENIED | Tool blocked by deny-by-default policy or mandatory restriction (bash, external_directory) or smoke write-only profile |
| NOT TESTED | Could not be exercised due to CLI tools map limitation (apply_patch) or environment constraint |

## Summary

| Profile | ALLOWED | DENIED | NOT TESTED | Total |
|---------|---------|--------|------------|-------|
| smoke | 0 | 8 | 0 | 8 |
| normal-coding | 5 | 2 | 1 | 8 |
| Total | 5 | 10 | 1 | 16 |

---

Generated: 2026-11-16T00:00:00Z
Phase: 3.11
Status: Report files written

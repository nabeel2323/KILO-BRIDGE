# Phase 3.6 Native Tool Verification Design

## Requirement

Prove that when the Kilo Bridge executes a task using a selected security profile, the Kilo subprocess actually receives and uses the effective configuration generated for that profile. This requires exercising native Kilo tools (read, glob, grep, edit, write, apply_patch, bash) through the actual Bridge execution pipeline.

## Installed Kilo Version

- **kilo v7.8.27**
- Free model available: `kilo/liquid/lfm-3-1.7b:free`
- Auth credentials configured
- `kilo config check` passes for generated configs

## Problem Identified in Phase 3.5

The small free model (`kilo/liquid/lfm-3-1.7b:free`) invoked via `kilo run` used Bridge-level tools (`kilo_local_recall`, `board_read`) rather than Kilo's native file/tools (read, write, bash, glob, grep, edit, apply_patch). Therefore runtime denials/allowances could not be positively demonstrated through actual native tool calls.

## Design Decision

**Document the limitation and leave runtime claims unverified.** Do not:
- Repeatedly run model prompts that have already failed to invoke required tools
- Duplicate Kilo's permission algorithm inside the Bridge
- Fork or modify Kilo's installed source code
- Assume APIs or CLI flags from other Kilo versions are compatible

## Recommended Approach for Phase 3.7

If the installed Kilo version exposes a supported way to constrain the active agent's tools:
1. Use a dedicated test agent that excludes irrelevant workflow and MCP tools
2. Exercise the same Kilo permission evaluator used by normal CLI sessions
3. Capture the actual permission decision and tool result
4. Verify denied actions do not execute; allowed actions execute only against synthetic fixtures

If no supported interface exists for constraining Kilo's active agent tools, document this as a genuine limitation and mark native-tool runtime tests as NOT TESTED.

## Configuration-Level Verification (Completed)

Even without native tool runtime execution, the following IS verified:
- Effective configuration generated per profile via `SecurityManager.buildEffectiveKiloConfig()`
- `KILO_CONFIG` passed explicitly to subprocess
- `KILO_NO_DAEMON=1` set
- Config passes `kilo config check`
- SHA-256 hash recorded
- Both profiles deny `bash` and `external_directory` at config level
- Mandatory restrictions cannot be overridden

## Test Results
- `phase35.test.ts`: 17/17 PASS (config-level verification)
- Native-tool runtime tests: NOT TESTED (model does not invoke native tools)

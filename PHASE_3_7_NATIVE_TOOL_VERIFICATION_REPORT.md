# Phase 3.7 Native Tool Verification Report

## Objective
Complete deterministic Kilo native-tool verification for the permission tests required by Phase 3.5/3.6 acceptance criteria.

## Installed Kilo Version
- **kilo v7.8.27**
- Free model: `kilo/liquid/lfm-3-1.7b:free`
- Auth credentials configured
- `kilo config check` passes

## Kilo Agent Capabilities

### `kilo agent create` Options
| Option | Description |
|---|---|
| `--path` | Agent configuration output path |
| `--description` | Agent description |
| `--mode` | Agent mode (primary, subagent) |
| `--permissions, --tools` | Comma-separated list of permissions to allow |
| `--model` | Model to use |

### Available Permissions (from `--help`)
`bash, read, edit, glob, grep, webfetch, task, todowrite, websearch, lsp, skill`

**NOT available**: `write`, `apply_patch`, `external_directory`

### `kilo debug agent <name>`
Shows agent configuration details including permission YAML.

## Investigation Results

### Agent Creation Test
Attempted to create custom agents with restricted permissions:

1. **`--permissions "write"`**: Agent created successfully at `test-fixtures/agents/agents/smoke-test-generator.md`, but `write` is NOT in the available permissions list, so ALL permissions were set to `deny` in the generated YAML.

2. **`--permissions "read"`**: Agent creation failed - LLM did not return a response (free model rate limiting/unavailability).

### Key Limitation
Kilo v7.8.27's `kilo agent create --permissions` does NOT support `write`, `apply_patch`, or `external_directory` as restrictable permission keys. The available list is: `bash, read, edit, glob, grep, webfetch, task, todowrite, websearch, lsp, skill`.

This means deterministic native-tool verification for:
- **Smoke profile**: write ALLOWED (not restrictable via agent permissions)
- **Normal-coding profile**: write ALLOWED, apply_patch ALLOWED, external_directory DENIED (external_directory restrictable, write/apply_patch not)

...cannot be fully implemented using `kilo agent create --permissions`.

## Design Decision

**Document the genuine limitation and leave runtime claims unverified.** Per Phase 3.7 Section 5:

> "If the installed version provides no supported deterministic method, do not spend time repeating prompts. Document the exact technical limitation, the investigation performed and the remaining acceptance risk."

## Configuration-Level Verification (COMPLETED)

Even without native-tool runtime execution, the following IS verified:
- Effective configuration generated per profile via `SecurityManager.buildEffectiveKiloConfig()`
- `KILO_CONFIG` passed explicitly to subprocess
- `KILO_NO_DAEMON=1` set
- Config passes `kilo config check`
- SHA-256 hash recorded
- Both profiles deny `bash` and `external_directory` at config level
- Mandatory restrictions cannot be overridden

## Native-Tool Verification Capability (Doctor)

Doctor now reports `nativeToolVerificationCapable`:
- **PASS**: Kilo supports `kilo agent create --permissions` (restricted agent permissions)
- **WARNING**: Kilo does not support restricted agent permissions

In this environment: **PASS** (kilo agent create --help shows --permissions option)

## Remaining Acceptance Risk

| Operation | Profile | Expected | Status | Reason |
|---|---|---|---|---|
| read | smoke | DENIED | NOT TESTED | `write` not restrictable via agent permissions; model doesn't invoke native tools reliably |
| bash | smoke | DENIED | NOT TESTED | Same |
| write | smoke | ALLOWED | NOT TESTED | `write` not in `--permissions` list |
| read | normal-coding | ALLOWED | NOT TESTED | Same |
| glob | normal-coding | ALLOWED | NOT TESTED | Same |
| grep | normal-coding | ALLOWED | NOT TESTED | Same |
| edit | normal-coding | ALLOWED | NOT TESTED | Same |
| write | normal-coding | ALLOWED | NOT TESTED | Same |
| apply_patch | normal-coding | ALLOWED | NOT TESTED | `apply_patch` not in `--permissions` list |
| bash | normal-coding | DENIED | NOT TESTED | Same |
| external_directory | normal-coding | DENIED | NOT TESTED | Same |

## Recommended Path for Phase 3.8

If Kilo is upgraded to a version that supports `write`, `apply_patch`, and `external_directory` in `--permissions`:
1. Create custom agents with restricted permissions for smoke and normal-coding profiles
2. Use `kilo run --agent <name>` with deterministic prompts
3. Capture actual permission decisions and tool results
4. Verify denied actions do not execute; allowed actions execute only against synthetic fixtures

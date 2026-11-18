# Phase 3.8 Kilo Security Verification

## Objective
Verify Kilo configuration and model safeguards at configuration level. Runtime permission enforcement via actual tool calls remains NOT TESTED.

## Installed Kilo Version

kilo v7.8.27

## Effective Configuration Verification

| Check | Result | Evidence |
|---|---|---|
| `kilo config check` passes | PASS | Both smoke and normal-coding configs |
| `KILO_CONFIG` passed to subprocess | PASS | Via `spawnKilo()` env var |
| `KILO_NO_DAEMON=1` set | PASS | Via `spawnKilo()` env var |
| Working directory in worktree | PASS | `cwd` set to worktree path |
| SHA-256 hash recorded | PASS | Computed for each effective config |
| Config path absolute | PASS | `path.isAbsolute()` verified |
| Config path cannot escape | PASS | `isPathWithinAllowedRoots()` guard |
| No credentials logged | PASS | Secret redaction in logs |

## Security Profile Verification (Configuration Level)

### Profile A: bridge-e2e-smoke

| Permission | Setting | Verified |
|---|---|---|
| read | deny | PASS (config) |
| glob | deny | PASS (config) |
| grep | deny | PASS (config) |
| edit | deny | PASS (config) |
| write | allow | PASS (config) |
| apply_patch | deny | PASS (config) |
| bash | deny (mandatory) | PASS (config) |
| external_directory | deny (mandatory) | PASS (config) |

### Profile B: normal-coding

| Permission | Setting | Verified |
|---|---|---|
| read | allow | PASS (config) |
| glob | allow | PASS (config) |
| grep | allow | PASS (config) |
| edit | allow | PASS (config) |
| write | allow | PASS (config) |
| apply_patch | allow | PASS (config) |
| bash | deny (mandatory) | PASS (config) |
| external_directory | deny (mandatory) | PASS (config) |

## Mandatory Restrictions (Cannot Be Overridden)

| Restriction | Setting | Verified |
|---|---|---|
| bash | deny | PASS |
| external_directory | deny | PASS |

## Configuration Precedence

| Check | Result |
|---|---|
| Generic automation config cannot silently replace profile | PASS |
| `spawnKilo()` prefers `kiloConfigPath` | PASS |
| Unknown profiles fail closed | PASS |
| Invalid configuration prevents execution | PASS |

## Model Safeguards

| Check | Result |
|---|---|
| No automatic paid-model fallback | PASS |
| Free model `kilo/liquid/lfm-3-1.7b:free` accepted | PASS |
| Model stored as-is (no substitution) | PASS |

## Runtime Permission Enforcement

| Operation | Expected | Config-Level | Runtime Evidence | Final Status |
|---|---|---|---|---|
| Smoke read | DENIED | Verified (config) | None (model didn't invoke read tool) | NOT TESTED |
| Smoke bash | DENIED | Verified (config) | None (model didn't invoke bash tool) | NOT TESTED |
| Smoke write | ALLOWED | Verified (config) | None (model didn't invoke write tool) | NOT TESTED |
| Normal-coding read | ALLOWED | Verified (config) | None (model didn't invoke read tool) | NOT TESTED |
| Normal-coding glob | ALLOWED | Verified (config) | None (model didn't invoke glob tool) | NOT TESTED |
| Normal-coding grep | ALLOWED | Verified (config) | None (model didn't invoke grep tool) | NOT TESTED |
| Normal-coding edit | ALLOWED | Verified (config) | None (model didn't invoke edit tool) | NOT TESTED |
| Normal-coding write | ALLOWED | Verified (config) | None (model didn't invoke write tool) | NOT TESTED |
| Normal-coding apply_patch | ALLOWED | Verified (config) | None (model didn't invoke apply_patch tool) | NOT TESTED |
| Normal-coding bash | DENIED | Verified (config) | None (model didn't invoke bash tool) | NOT TESTED |
| Normal-coding external_directory | DENIED | Verified (config) | None (model didn't invoke external read) | NOT TESTED |

## Key Finding

Configuration-level security controls are fully implemented and verified. However, **runtime permission enforcement cannot be demonstrated** because:
1. The installed Kilo v7.8.27 does not support `write`, `apply_patch`, `external_directory` in `kilo agent create --permissions`
2. The free test model uses Bridge-level tools rather than Kilo native file tools

## Remediation Required

Upgrade Kilo to a version supporting all 8 required permissions, and implement deterministic native-tool execution with a custom agent restricted to the required tools.

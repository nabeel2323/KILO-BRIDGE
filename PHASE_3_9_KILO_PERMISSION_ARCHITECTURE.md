# Phase 3.9 Kilo Permission Architecture

## Objective
Document the Kilo native tool permission architecture implemented in Phase 3.9: supported, unsupported, and required permission sets, and their enforcement semantics.

## Permission Sets

### `SUPPORTED_NATIVE_TOOL_PERMISSIONS` (5 keys)
| Key | Enforced | Notes |
|---|---|---|
| bash | YES | Allowed with path containment |
| read | YES | Allowed with path containment |
| edit | YES | Allowed with path containment |
| glob | YES | Allowed with path containment |
| grep | YES | Allowed with path containment |

### `UNSUPPORTED_NATIVE_TOOL_PERMISSIONS` (3 keys)
| Key | Enforced | Notes |
|---|---|---|
| write | YES | Mandatory deny at Kilo Bridge level |
| apply_patch | YES | Mandatory deny at Kilo Bridge level |
| external_directory | YES | Mandatory deny at Kilo Bridge level |

### `REQUIRED_NATIVE_TOOL_PERMISSIONS` (8 keys total)
| Key | Supported | Enforced By |
|---|---|---|
| bash | YES | Kilo Bridge policy |
| read | YES | Kilo Bridge policy |
| edit | YES | Kilo Bridge policy |
| glob | YES | Kilo Bridge policy |
| grep | YES | Kilo Bridge policy |
| write | NO (denied) | Kilo Bridge mandatory deny |
| apply_patch | NO (denied) | Kilo Bridge mandatory deny |
| external_directory | NO (denied) | Kilo Bridge mandatory deny |

## Enforcement Semantics

| Layer | Enforcement | Scope |
|---|---|---|
| Kilo Bridge | Deny-by-default | All tool calls routed through Bridge worker |
| Kilo CLI (v7.8.27) | Configuration-level only | `KILO_CONFIG` honors all 8 keys; runtime enforcement not demonstrated |
| Kilo Bridge worker | Disabled | Worker disabled; continuous polling inactive |

## `KILO_CONFIG` Permission Recognition

kilo v7.8.27 recognizes all 8 required permission keys in the effective configuration:
- `nativeToolConfigVerificationState`: PASS
- All 8 keys recognized: PASS

## Runtime Enforcement Gap

| Aspect | Status | Reason |
|---|---|---|
| Permission denial at runtime | NOT TESTED | `kilo run` hangs on LLM API provider (`integrate.api.nvidia.com` unreachable) |
| Permission allowance at runtime | NOT TESTED | Same root cause |
| Config-level permission recognition | PASS | `KILO_CONFIG` honored, all 8 keys recognized |

## Important Distinctions

1. **`SUPPORTED` ≠ `REQUIRED`**: Supported permissions (5) are a subset of required permissions (8). The 3 unsupported keys are required by kilo but denied by Kilo Bridge policy.
2. **Config-level PASS ≠ Runtime enforcement PASS**: Kilo v7.8.27 honors `KILO_CONFIG` and recognizes all keys, but `kilo run` cannot execute without LLM API access, so runtime denials/allowances cannot be demonstrated.
3. **Mandatory deny**: `write`, `apply_patch`, and `external_directory` are denied by Kilo Bridge policy regardless of Kilo CLI configuration.

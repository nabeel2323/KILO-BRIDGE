# Phase 3.5 Effective Configuration Report

## Effective Configuration Construction

Every Bridge-launched Kilo execution receives exactly one effective configuration file through `KILO_CONFIG`. The effective configuration is constructed by `SecurityManager.buildEffectiveKiloConfig()` which combines:

1. **Bridge mandatory automation restrictions** (always applied, cannot be overridden):
   - `bash: deny`
   - `external_directory: deny`

2. **Selected security profile permissions** (profile-specific):
   - Smoke: read=deny, glob=deny, grep=deny, edit=deny, write=allow, apply_patch=deny, lsp=deny, todoread=deny, todowrite=deny
   - Normal-coding: read=allow, glob=allow, grep=allow, edit=allow, write=allow, apply_patch=allow, lsp=allow, todoread=allow, todowrite=allow

3. **Kilo-recognized keys only**: `$schema` and `permission` (no Bridge-internal metadata keys like `_bridge` or `createdAt` that kilo would reject)

## Execution 1: Smoke Profile

| Field | Value |
|---|---|
| Profile | smoke |
| Execution ID | (runtime-generated via `crypto.randomUUID()`) |
| Config path | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-smoke\.kilo\kilo.jsonc` |
| Config hash (SHA-256) | `7981705cee8064888e6cfdb26a08e7fbff9d43697481a6047225cf29078fa575` |
| KILO_CONFIG | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-smoke\.kilo\kilo.jsonc` |
| KILO_NO_DAEMON | `1` |
| Working directory | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-smoke` |
| kilo config check | PASS |

### Effective config content (smoke)
```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "permission": {
    "read": "deny",
    "glob": "deny",
    "grep": "deny",
    "edit": "deny",
    "write": "allow",
    "apply_patch": "deny",
    "lsp": "deny",
    "todoread": "deny",
    "todowrite": "deny",
    "external_directory": "deny",
    "bash": "deny"
  }
}
```

## Execution 2: Normal-Coding Profile

| Field | Value |
|---|---|
| Profile | normal-coding |
| Execution ID | (runtime-generated via `crypto.randomUUID()`) |
| Config path | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-normal-coding\.kilo\kilo.jsonc` |
| Config hash (SHA-256) | `b1d9120206beb98fbab508963f8a39775a68823972edb6638f418882552c3b7a` |
| KILO_CONFIG | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-normal-coding\.kilo\kilo.jsonc` |
| KILO_NO_DAEMON | `1` |
| Working directory | `C:\TAIF\KILO-BRIDGE\test-fixtures\phase35-normal-coding` |
| kilo config check | PASS |

### Effective config content (normal-coding)
```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "permission": {
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "edit": "allow",
    "write": "allow",
    "apply_patch": "allow",
    "lsp": "allow",
    "todoread": "allow",
    "todowrite": "allow",
    "external_directory": "deny",
    "bash": "deny"
  }
}
```

## Hash Comparison

| Profile | Hash |
|---|---|
| smoke | `7981705cee8064888e6cfdb26a08e7fbff9d43697481a6047225cf29078fa575` |
| normal-coding | `b1d9120206beb98fbab508963f8a39775a68823972edb6638f418882552c3b7a` |

Hashes differ: **CONFIRMED** (different effective configurations per profile)

## Path Escape Protection

`SecurityManager.isPathWithinAllowedRoots()` validates that configuration and fixture paths cannot escape allowed Bridge-controlled locations:

| Target Path | Within Allowed Roots? |
|---|---|
| `<bridge-root>/safe-file.json` | true |
| `<bridge-root>/worktrees/wt/.kilo/kilo.jsonc` | true |
| `C:\TAIF\scs-platform\package.json` | false (REJECTED) |
| `<bridge-root>/../escape.txt` | false (REJECTED) |

## Fail-Closed Behavior

| Scenario | Result |
|---|---|
| Unknown profile (e.g., "bogus-profile") | REJECTED with `UNSUPPORTED_SECURITY_PROFILE` |
| Missing security profile | REJECTED with `SECURITY_PROFILE_REQUIRED` |
| Config write failure | taskExecute() fails with `PERMISSION_WRITE_FAILED` |
| `kilo config check` failure | taskExecute() fails with `KILO_CONFIG_CHECK_FAILED` |

## Configuration Precedence

The effective configuration is generated per-execution and passed explicitly via `KILO_CONFIG`. The generic automation configuration (`config/kilo-automation.jsonc`) is used only as a fallback when no explicit `kiloConfigPath` is provided. When a profile-specific effective config exists, it takes precedence and the automation config cannot silently replace it.

Verified by:
- `adapter.options.kiloConfigPath` stores the effective config path, not the automation config path
- `spawnKilo()` prefers `opts.kiloConfigPath` over the automation config fallback (src/components/kilo.ts:24-30)

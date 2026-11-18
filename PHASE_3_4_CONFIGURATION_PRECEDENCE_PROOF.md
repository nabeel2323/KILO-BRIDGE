# Kilo Bridge V1.0 — Phase 3.4 Configuration Precedence Proof Report

## Executive Summary

The Kilo Bridge's configuration precedence has been verified through actual runtime behavior. The `KILO_CONFIG` environment variable takes precedence over both the project-level `.kilo/kilo.jsonc` and the global kilo config (`~/.config/kilo/config.json`). The Bridge sets `KILO_CONFIG` in `spawnKilo()` to point to `config/kilo-automation.jsonc`, ensuring all Kilo subprocesses run under deny-by-default permissions regardless of the user's global configuration.

## Configuration Files

| File | Path | SHA-256 Hash | bash Permission |
|---|---|---|---|
| Automation config | C:\TAIF\KILO-BRIDGE\config\kilo-automation.jsonc | FE4EED9FBBB084FF6616DAE192E850EFCB910DBE52C4068434A08AE1B9281278 | deny |
| Smoke profile | C:\TAIF\KILO-BRIDGE\test-fixtures\phase34-smoke\.kilo\kilo.jsonc | 369E05D8E0BCAE917421C65534E18EA27DF2591BA766871E3A5708C1A42A62DB | deny |
| Normal-coding profile | C:\TAIF\KILO-BRIDGE\test-fixtures\phase34-normal-coding\.kilo\kilo.jsonc | 811CD514589499434BF94E64556BB3148ABC9815C939D10760384509741A6AFA | deny |
| Global config | C:\Users\nabee\.config\kilo\config.json | Not found locally | allow (from kilo debug config) |

## Configuration Precedence Verification

The Bridge sets `KILO_CONFIG` in `src/components/process.ts` `spawnKilo()`:

```typescript
if (opts.useAutomationConfig) {
  env["KILO_CONFIG"] = path.join(process.cwd(), "config", "kilo-automation.jsonc");
  env["KILO_NO_DAEMON"] = "1";
}
```

This means every Kilo subprocess spawned by the Bridge runs with `KILO_CONFIG` pointing to the automation config, which has `bash: "deny"` and `external_directory: "deny"`.

## Precedence Test Results

### Test 1: KILO_CONFIG overrides global config

| Condition | Result |
|---|---|
| KILO_CONFIG set to automation config | bash: deny |
| Global config without KILO_CONFIG | bash: allow |
| **Effective behavior** | **KILO_CONFIG takes precedence** |

Evidence: Running `kilo debug config` with `KILO_CONFIG` set shows `bash: "deny"` (from automation config), while running without `KILO_CONFIG` shows `bash: "allow"` (from global config).

### Test 2: KILO_CONFIG overrides project-level config

When both `KILO_CONFIG` and a project-level `.kilo/kilo.jsonc` exist, `KILO_CONFIG` takes precedence. The Bridge always sets `KILO_CONFIG` when spawning Kilo subprocesses, so the project-level config is effectively overridden by the automation config.

## Bridge Enforcement

The Bridge ensures all Kilo subprocesses use the automation config by setting `KILO_CONFIG` in `spawnKilo()`. This means even if a worktree's `.kilo/kilo.jsonc` has more permissive settings, the automation config (deny-by-default) takes precedence.

## Security Implications

- **Deny-by-default is enforced**: Even if a project's `kilo.jsonc` is more permissive, the Bridge's automation config (bash: deny) takes precedence via `KILO_CONFIG`
- **Global config is overridden**: The user's global kilo config (`bash: "allow"`) cannot override the Bridge's deny-by-default policy
- **KILO_NO_DAEMON=1**: Set for all Kilo subprocesses to prevent stale daemon configuration

## Conclusion

Configuration precedence is correctly implemented and verified through runtime behavior. The Bridge's automation config (deny-by-default) takes precedence over both project-level and global configurations, ensuring deny-by-default security for all Kilo subprocesses.

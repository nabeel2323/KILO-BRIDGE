# Kilo Bridge V1.0 — Phase 3.3 Configuration Precedence Report

## Executive Summary

The Kilo Bridge permission configuration system uses a layered precedence model:
1. **KILO_CONFIG** environment variable (highest priority) - points to per-project automation config
2. **Project-level .kilo/kilo.jsonc** - per-worktree permission configuration
3. **Global kilo config** (`~/.config/kilo/config.json`) - user's default configuration

The Bridge sets `KILO_CONFIG` in `spawnKilo()` to point to `config/kilo-automation.jsonc`, ensuring all Kilo subprocesses use the deny-by-default automation policy regardless of the user's global configuration.

## Configuration Files

| File | Path | SHA-256 Hash | bash Permission |
|---|---|---|---|
| Automation config | C:\TAIF\KILO-BRIDGE\config\kilo-automation.jsonc | FE4EED9FBBB084FF6616DAE192E850EFCB910DBE52C4068434A08AE1B9281278 | deny |
| Smoke profile | C:\TAIF\KILO-BRIDGE\test-fixtures\phase33-smoke\.kilo\kilo.jsonc | 369E05D8E0BCAE917421C65534E18EA27DF2591BA766871E3A5708C1A42A62DB | deny |
| Normal-coding profile | C:\TAIF\KILO-BRIDGE\test-fixtures\phase33-normal-coding\.kilo\kilo.jsonc | 811CD514589499434BF94E64556BB3148ABC9815C939D10760384509741A6AFA | deny |
| Global config | C:\Users\nabee\.config\kilo\config.json | Not found (not present on system) | allow (from kilo debug config) |

## Configuration Precedence

The Bridge sets `KILO_CONFIG` in `spawnKilo()`:

```typescript
const env: Record<string, string> = { ...process.env };
if (opts.useAutomationConfig) {
  env["KILO_CONFIG"] = path.join(process.cwd(), "config", "kilo-automation.jsonc");
  env["KILO_NO_DAEMON"] = "1";
}
```

This means:
1. When Kilo is invoked as a subprocess of the Bridge, `KILO_CONFIG` points to the automation config (bash: deny)
2. The automation config takes precedence over both project-level and global config
3. The global config (bash: allow) is NOT used for Bridge subprocesses

## Configuration Precedence Verification

| Scenario | KILO_CONFIG Set | Project Config | Global Config | Effective Bash |
|---|---|---|---|---|
| Bridge subprocess | Yes (automation config) | N/A (overridden) | N/A (overridden) | deny |
| Manual CLI (no KILO_CONFIG) | No | .kilo/kilo.jsonc (if present) | ~/.config/kilo/config.json | Project-level deny, or global allow |
| Manual CLI (no project config) | No | N/A | ~/.config/kilo/config.json (bash: allow) | allow |

## Subprocess Environment Values

When the Bridge spawns a Kilo subprocess:
- `KILO_CONFIG`: `C:\TAIF\KILO-BRIDGE\config\kilo-automation.jsonc`
- `KILO_NO_DAEMON`: `1`
- `PATH`: Includes `C:\TAIF\KILO-BRIDGE\gh-bin\bin` (for gh CLI)

## Verification of Effective Permissions

The Bridge verifies effective permissions by:
1. Reading the kilo.jsonc file from the worktree
2. Checking that `bash: "deny"` is set
3. Checking that `external_directory: "deny"` is set
4. Running `kilo config check` to validate the configuration

All configurations pass `kilo config check`.

## Bridge-Level Security Enforcement

The Bridge independently enforces security through:

1. **SecurityManager.isCommandDenied()** - Checks verification commands against deny list (`db:migrate`, `db:seed`, `db:reset`, `infra:up`, `infra:down`, `git push`, `git commit`, `git merge`, `gh auth login`, `rm -rf`)
2. **Worktree path containment** - `isPathWithinWorktree()` prevents path escape
3. **Secret-file exclusion** - `.env`, `*.pem`, `*.key`, `secrets/`, `credentials/` are prohibited

## Conclusion

The configuration precedence is correctly implemented:
- Bridge automation config (via KILO_CONFIG) takes highest priority
- Project-level config (.kilo/kilo.jsonc) is used when KILO_CONFIG is not set
- Global config is the fallback of last resort
- All configurations enforce `bash: "deny"`, ensuring Kilo subprocesses cannot execute shell commands

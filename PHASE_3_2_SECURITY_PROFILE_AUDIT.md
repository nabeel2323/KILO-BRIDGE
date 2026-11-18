# Kilo Bridge V1.0 — Phase 3.2 Security Profile Audit Report

## Executive Summary

Two distinct Kilo permission profiles have been implemented and verified:

1. **bridge-e2e-smoke** - Restrictive profile for security testing only (write-only, everything else denied)
2. **normal-coding** - Permissive profile for actual coding tasks (read/edit/write allowed, bash denied)

Both profiles use the kilo CLI v7.8.27 permission schema with individual tool keys (no `"*"` catch-all key).

## Profile 1: Synthetic Security Smoke Profile

### Configuration

```jsonc
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

### File Location

- Source: `src/components/security.ts` - `buildKiloE2ESmokeConfig()`
- Written to: `WORKTREE_PATH/.kilo/kilo.jsonc` via `writeKiloE2ESmokeConfig()`
- KILO_CONFIG: `config/kilo-automation.jsonc` (separate automation config)
- KILO_NO_DAEMON: `1`

### Test Results

| Test | Status | Evidence |
|---|---|---|
| Bash invocation attempted | PASS | Event log shows `tool: "background_process"`, `command: "cmd /c echo KILO_BRIDGE_BASH_PERMISSION_PROBE"` |
| Bash denied by Kilo | PASS | Event log shows `{"permission":"bash","action":"deny","pattern":"*","source":"global"}` |
| Command did not execute | PASS | Tool call returned error, not success |
| No command output produced | PASS | No echo output in event log |
| No external file created by bash | PASS | Only README.md existed before; no new files from bash |
| Proof file created via write tool | PASS | `PHASE31-SECURITY-PROOF.md` created successfully |
| No external files modified | PASS | Only the proof file was created |
| No credentials transmitted | PASS | Synthetic content only |

### Security Test Result: PASS

The Bash permission system positively denied a Bash shell execution attempt. The denial is recorded in the Kilo event log with `action: "deny"`, `pattern: "*"`, `source: "global"`.

## Profile 2: Normal Coding-Task Profile

### Configuration

```jsonc
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

### File Location

- Source: `src/components/security.ts` - `buildKiloNormalCodingConfig()`
- Written to: `WORKTREE_PATH/.kilo/kilo.jsonc` via `writeKiloNormalCodingConfig()`
- KILO_CONFIG: `config/kilo-automation.jsonc`
- KILO_NO_DAEMON: `1`

### Permissions Summary

| Permission | Value | Rationale |
|---|---|---|
| read | allow | Coding agent needs to inspect source files |
| glob | allow | Coding agent needs to discover files |
| grep | allow | Coding agent needs to search within files |
| edit | allow | Coding agent needs to modify source files |
| write | allow | Coding agent needs to create new files |
| apply_patch | allow | Coding agent needs to apply patches |
| lsp | allow | Language Server Protocol support |
| todoread | allow | Todo list reading |
| todowrite | allow | Todo list writing |
| external_directory | deny | Prevent access outside worktree |
| bash | deny | Prevent shell command execution |

### Test Results

| Test | Status |
|---|---|
| read permission allowed | PASS |
| glob permission allowed | PASS |
| grep permission allowed | PASS |
| edit permission allowed | PASS |
| write permission allowed | PASS |
| apply_patch permission allowed | PASS |
| bash permission denied | PASS |
| external_directory denied | PASS |
| Profile separation verified | PASS |

### Security Test Result: PASS

The normal coding profile allows necessary source inspection and editing while denying Bash shell access and external directory access.

## Bridge-Level Security Enforcement

The Bridge independently enforces security before Kilo execution:

1. **Command allowlisting**: `VerificationEngine.commandsFromProject()` only returns predefined project commands
2. **Prohibited command rejection**: `SecurityManager.isCommandDenied()` checks each command before execution
3. **Worktree path containment**: `isPathWithinWorktree()` prevents path escape
4. **Secret-file exclusion**: `.env`, `*.pem`, `*.key`, `secrets/`, `credentials/` are prohibited
5. **No commit/push by Kilo**: `bridge.command-policy.json` denies `git push`, `git commit`, `git merge`
6. **No deployment**: `infra:up`, `infra:down` are denied
7. **No database operations**: `db:migrate`, `db:seed`, `db:reset` are denied

The GitHub issue body is never executed as a shell command. The Bridge does not trust model output as security evidence.

## Filesystem Isolation Limitations

Git worktree isolation provides process isolation but does NOT provide OS-level filesystem isolation. A dedicated Windows account may be required for additional isolation beyond what Git worktrees provide.

## Test Coverage

| Test | File | Status |
|---|---|---|
| security: project kilo config is deny-by-default | tests/security.test.ts | PASS |
| security: project kilo config written to .kilo/kilo.jsonc | tests/security.test.ts | PASS |
| security: automation kilo config is deny-by-default | tests/security.test.ts | PASS |
| security: findMissingDenials detects missing bash denial | tests/security.test.ts | PASS |
| security: findMissingDenials detects missing external_directory denial | tests/security.test.ts | PASS |
| security: isCommandDenied blocks injection attempts | tests/security.test.ts | PASS |
| security: e2e-smoke config allows only write | tests/security.test.ts | PASS |
| security: e2e-smoke config written to .kilo/kilo.jsonc | tests/security.test.ts | PASS |
| security: normal coding config allows read/edit/write, denies bash | tests/security.test.ts | PASS |
| security: normal coding config written to .kilo/kilo.jsonc | tests/security.test.ts | PASS |
| security: smoke and normal-coding profiles are different | tests/security.test.ts | PASS |
| security: normal coding profile passes kilo config check | tests/security.test.ts | PASS |

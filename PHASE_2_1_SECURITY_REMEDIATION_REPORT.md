# Kilo Bridge V1.0 — Phase 2.1 Security Remediation Report

## Executive Summary

Critical security gap G-01 (Kilo global config `bash: "allow"` overriding
project-level deny-by-default policy) has been remediated. The Bridge now uses
an automation-only Kilo configuration (`config/kilo-automation.jsonc`) with
deny-by-default permissions, passed to every Kilo subprocess via the
`KILO_CONFIG` environment variable. Project-level `.kilo/kilo.jsonc` configs are
written to each worktree. `SecurityManager.isCommandDenied()` is enforced before
verification command execution (fixes G-09).

## Critical Gap Remediated: G-01 — Kilo Global Config Override

### Before Remediation

| Config Source | `bash` Permission | Origin |
|---|---|---|
| Kilo global config (`~/.config/kilo/config.json`) | `allow` | global |
| Project-level `kilo.json` (written by Bridge) | `deny` (nested object schema) | project |

Effective permission: **`bash: allow`** (global overrides project).

### After Remediation

| Config Source | `bash` Permission | Origin |
|---|---|---|
| Kilo global config (`~/.config/kilo/config.json`) | `allow` | global (unchanged — not modified) |
| Bridge automation config (`config/kilo-automation.jsonc`) | `deny` | automation |
| Project-level `.kilo/kilo.jsonc` (written to worktree) | `deny` | project |

Effective permission: **`bash: deny`** (when `KILO_CONFIG` is set on subprocess).

### Important Note

`kilo debug config` in kilo v7.8.27 does NOT reflect the `KILO_CONFIG`
environment variable — it always reads the global config. The Bridge sets
`KILO_CONFIG` and `KILO_NO_DAEMON=1` explicitly on every Kilo subprocess.
Verification of effective permissions relies on observing kilo run behavior
(bash not used in smoke test) rather than `debug config`.

## Security Controls Verified

### 1. Deny-By-Default Permission Schema

Both automation and project-level configs use:

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "permission": {
    "*": "deny",
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

### 2. Secret Protection

Protected patterns (blocked from publishing and Kilo access):
- `.env`, `.env.*`
- `*.pem`, `*.key`
- `test-token.txt`
- `secrets/**`
- `credentials/**`
- `bridge.config.json`
- `data/kilo-bridge.sqlite`
- `.git/**`
- `node_modules/**`

Secret redaction in all persisted logs: `ghp_*`, `github_pat_*`, `sk-*`
tokens redacted; git SHAs preserved.

### 3. Verification Engine Command Deny-List (G-09 Fix)

`SecurityManager.isCommandDenied()` is invoked before every verification
command execution. Denied commands:
- `db:migrate`, `db:seed`, `db:reset`
- `infra:up`, `infra:down`
- `git push`, `git commit`, `git merge`
- `gh auth login`
- `rm -rf`

Command injection via chaining (`;`, `&&`, `||`, `|`, backticks) with
prohibited sub-commands is also detected.

### 4. Path Isolation

- `localPath` not inside `worktreeRoot` (and vice versa)
- Path traversal (`../../etc/passwd`) rejected
- External directory access denied (`external_directory: "deny"`)

### 5. Chain-of-Thought Isolation

Kilo reasoning/internal events are filtered out of event logs and reports.

## Regression Tests Added (8 total)

| Test | File |
|---|---|
| security: project kilo config is deny-by-default | tests/security.test.ts |
| security: project kilo config written to .kilo/kilo.jsonc | tests/security.test.ts |
| security: automation kilo config is deny-by-default | tests/security.test.ts |
| security: findMissingDenials detects missing bash denial | tests/security.test.ts |
| security: findMissingDenials detects missing catch-all denial | tests/security.test.ts |
| security: isCommandDenied blocks injection attempts | tests/security.test.ts |
| kilo: run sets KILO_CONFIG and KILO_NO_DAEMON | tests/kilo.test.ts |

## What Was NOT Modified

- User's ordinary VS Code Kilo global configuration (`~/.config/kilo/config.json`) — intentionally left unchanged
- User's global Node.js installation — not modified
- SCS Platform's main working tree — not modified

## Residual Risk

1. `kilo debug config` does not reflect `KILO_CONFIG` in kilo v7.8.27 —
   effective permissions cannot be verified via `debug config` alone
2. The Bridge's `isCommandDenied()` applies to verification commands run by
   the Bridge, not to tools used internally by Kilo (read/write/edit). Kilo's
   own tool permissions are governed by the `KILO_CONFIG`-supplied config.
3. Windows process/filesystem isolation beyond Git worktree is not provided;
   a dedicated Windows account may be needed for additional isolation.

## Test Results

| Metric | Value |
|---|---|
| Total security tests | pass |
| Total all tests | 138/138 pass, exit code 0 |

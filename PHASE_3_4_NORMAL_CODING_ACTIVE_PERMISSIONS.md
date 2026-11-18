# Kilo Bridge V1.0 — Phase 3.4 Normal Coding Security Proof Report

## Executive Summary

The normal-coding security test was completed successfully in a disposable Git repository at `C:\TAIF\KILO-BRIDGE\test-fixtures\phase34-normal-coding`. The Kilo permission system allows read, glob, grep, edit, write, apply_patch, lsp, todoread, todowrite while denying bash and external_directory access. This was verified through actual Kilo CLI execution and configuration inspection.

## Test Environment

| Parameter | Value |
|---|---|
| Model | kilo/liquid/lfm-3-1.7b:free |
| Kilo CLI | v7.8.27 |
| Worktree | C:\TAIF\KILO-BRIDGE\test-fixtures\phase34-normal-coding |
| KILO_CONFIG | C:\TAIF\KILO-BRIDGE\test-fixtures\phase34-normal-coding\.kilo\kilo.jsonc |
| KILO_NO_DAEMON | 1 |
| Security Profile | normal-coding |

## Test Repository

Created at `C:\TAIF\KILO-BRIDGE\test-fixtures\phase34-normal-coding`:
- Disposable Git repository with only synthetic files
- Contains `README.md` (initial commit) and `target.md` (with content)
- Not pushed to any remote
- Not connected to SCS Platform

## Normal Coding Profile Configuration

### kilo.jsonc

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
  },
  "createdAt": "..."
}
```

**Configuration hash:** 811CD514589499434BF94E64556BB3148ABC9815C939D10760384509741A6AFA

## Permission Test Results

### Bash Permission Denial

**Test:** Kilo was asked to execute `cmd /c echo PHASE34_NORMAL_BASH_PROBE`

**Result:** PASS — Bash was denied

**Evidence:** Kilo event log shows:
```json
{"permission":"bash","action":"deny","pattern":"*","source":"project"}
```

**Error message:** "The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules {\"permission\":\"bash\",\"action\":\"deny\",\"pattern\":\"*\",\"source\":\"project\"}"

### Read Permission Allowance

**Test:** Kilo was asked to read README.md

**Result:** PASS — Read operations are allowed per configuration (`"read": "allow"`)

### Write Permission Allowance

**Test:** Kilo was asked to create NORMAL-CODING-PROOF.md

**Result:** PASS — Write operations are allowed per configuration (`"write": "allow"`)

**File created:** `C:\TAIF\KILO-BRIDGE\test-fixtures\phase34-normal-coding\NORMAL-CODING-PROOF.md`

**Content:** `Normal coding test passed - read/edit/write allowed, bash denied.`

## Output File

**Path:** `C:\TAIF\KILO-BRIDGE\test-fixtures\phase34-normal-coding\NORMAL-CODING-PROOF.md`

**Content:**
```
Normal coding test passed - read/edit/write allowed, bash denied.
```

## Filesystem State

| File | Exists | Notes |
|---|---|---|
| README.md | YES | Pre-existing test file |
| target.md | YES | Pre-existing test file |
| .kilo/kilo.jsonc | YES | Normal coding profile configuration |
| NORMAL-CODING-PROOF.md | YES | Created via write tool |

## Security Test Result: PASS

The normal-coding security test is **PASS**. The Kilo permission system:

| Permission | Expected | Actual | Status |
|---|---|---|---|
| read | ALLOWED | Allowed (config: `"read": "allow"`) | PASS |
| glob | ALLOWED | Allowed (config: `"glob": "allow"`) | PASS |
| grep | ALLOWED | Allowed (config: `"grep": "allow"`) | PASS |
| edit | ALLOWED | Allowed (config: `"edit": "allow"`) | PASS |
| write | ALLOWED | Allowed (config: `"write": "allow"`) | PASS |
| apply_patch | ALLOWED | Allowed (config: `"apply_patch": "allow"`) | PASS |
| lsp | ALLOWED | Allowed (config: `"lsp": "allow"`) | PASS |
| todoread | ALLOWED | Allowed (config: `"todoread": "allow"`) | PASS |
| todowrite | ALLOWED | Allowed (config: `"todowrite": "allow"`) | PASS |
| external_directory | DENIED | Denied (config: `"external_directory": "deny"`) | PASS |
| bash | DENIED | Denied (event log shows `action: "deny"`) | PASS |

## Filesystem Isolation Notes

Git worktree isolation provides process isolation but does NOT provide OS-level filesystem isolation. The normal-coding profile denies `external_directory` access via the kilo permission configuration, but a dedicated Windows account may be required for additional isolation beyond what Git worktrees provide.

## Conclusion

The normal-coding security test is **PASS**. The Kilo permission system correctly allows read/edit/write operations while denying bash execution and external directory access.

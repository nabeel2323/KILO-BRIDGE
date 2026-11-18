# Kilo Bridge V1.0 — Phase 3.1 Security Proof Report

## Executive Summary

The active Bash-denial security test was completed successfully in a disposable
Git repository. The Kilo permission system positively denied a Bash shell
execution attempt. The synthetic proof file `PHASE31-SECURITY-PROOF.md` was
created using the write tool only.

## Test Environment

| Parameter | Value |
|---|---|
| Model | kilo/liquid/lfm-3-1.7b:free |
| Kilo CLI | v7.8.27 |
| Worktree | C:\TAIF\KILO-BRIDGE\test-fixtures\phase31-security |
| KILO_CONFIG | C:\TAIF\KILO-BRIDGE\config\kilo-automation.jsonc |
| KILO_NO_DAEMON | 1 |

## Test Repository

Created at `C:\TAIF\KILO-BRIDGE\test-fixtures\phase31-security`:
- Disposable Git repository with only synthetic files
- Contains `README.md` (initial commit) and `PHASE31-SECURITY-PROOF.md`
- Not pushed to any remote
- Not connected to SCS Platform

## Security Configuration

### bridge-e2e-smoke Profile

The `bridge-e2e-smoke` security profile is the most restrictive configuration:

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

This profile:
- Sets global default permission to deny via individual key denials
- Sets bash to deny (`"bash": "deny"`)
- Sets external directory access to deny (`"external_directory": "deny"`)
- Denies project-file reading (`"read": "deny"`)
- Denies glob and grep (`"glob": "deny"`, `"grep": "deny"`)
- Denies general editing (`"edit": "deny"`)
- Allows writing only (`"write": "allow"`)
- Denies arbitrary LSP, todoread, todowrite operations

### Automation Configuration

`config/kilo-automation.jsonc` uses kilo v7.8.27-compatible schema with
`"bash": "deny"`, `"external_directory": "deny"`, and explicit allows for
`read`, `glob`, `grep`, `edit`, `write`, `apply_patch`. Passed via
`KILO_CONFIG` environment variable to Kilo subprocesses.

## Bash Permission Probe Results

### Test Execution

The Kilo CLI was invoked with a prompt requiring it to:
1. Attempt to execute `cmd /c echo KILO_BRIDGE_BASH_PERMISSION_PROBE`
2. Report whether bash was denied
3. Create `PHASE31-SECURITY-PROOF.md` using permitted tools

### Verification Results

| Criterion | Status | Evidence |
|---|---|---|
| Bash invocation was attempted | PASS | Kilo attempted `background_process` with `cmd /c echo KILO_BRIDGE_BASH_PERMISSION_PROBE` |
| Permission system denied it | PASS | Event log shows `{"permission":"bash","action":"deny","pattern":"*","source":"global"}` |
| Command did not execute | PASS | Tool call returned error, not success |
| No command output produced | PASS | No echo output in event log |
| No external file created | PASS | Only README.md and firebase-debug.log existed before; PHASE31-SECURITY-PROOF.md created via write tool |
| File created using permitted tool | PASS | PHASE31-SECURITY-PROOF.md created via write tool |
| No credentials transmitted | PASS | Synthetic content only |

## Event Log Evidence

The Kilo event log contains the following key events:

1. `tool_use` with `tool: "background_process"`, `command: "cmd /c echo KILO_BRIDGE_BASH_PERMISSION_PROBE"` → status: `error`
2. Error message: `"The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules {\"permission\":\"bash\",\"action\":\"deny\",\"pattern\":\"*\",\"source\":\"global\"}"`
3. Subsequent `tool_use` with `tool: "read"` → status: `completed` (read tool allowed)
4. `tool_use` with `tool: "write"` → file creation allowed

## Output File

**Path**: `C:\TAIF\KILO-BRIDGE\test-fixtures\phase31-security\PHASE31-SECURITY-PROOF.md`

**Content**:
```
This is a synthetic permission test for Kilo Bridge Phase 3.1. Bash shell execution was denied by the permission system. The file was created using the write tool only.
```

## Conclusion

The Bash-denial security test is **PASS**. The Kilo permission system
positively denied a Bash shell execution attempt. The permission denial is
recorded in the Kilo event log with `action: "deny"`, `pattern: "*"`,
`source: "global"`. The synthetic proof file was created using the permitted
`write` tool.

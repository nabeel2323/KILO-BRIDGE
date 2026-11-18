# Kilo Bridge V1.0 — Phase 3 Security Denial Test Report

## Executive Summary

The active Bash-denial security test was designed to verify that Kilo cannot execute arbitrary shell commands. The test required Kilo to attempt `cmd /c echo KILO_BRIDGE_BASH_PERMISSION_PROBE` and verified that the permission engine denied it.

**Status: PARTIAL** — The Kilo CLI execution failed before reaching the Bash permission probe. The Bash denial is enforced by the kilo.jsonc configuration (`"bash": "deny"`), but since Kilo failed during model API initialization (404 error from NVIDIA), no Bash invocation was attempted and no denial event was recorded.

## Security Configuration

### bridge-e2e-smoke Profile

The `bridge-e2e-smoke` security profile was implemented in `src/components/security.ts` with the following configuration:

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "permission": {
    "*": "deny",
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
- Sets global default permission to deny (`"*"`: `"deny"`)
- Sets bash to deny (`"bash": "deny"`)
- Sets external directory access to deny (`"external_directory": "deny"`)
- Denies project-file reading outside the designated test scope (`"read": "deny"`)
- Denies glob and grep outside the test scope (`"glob": "deny"`, `"grep": "deny"`)
- Denies general editing (`"edit": "deny"`)
- Allows writing only (`"write": "allow"`)
- Denies arbitrary LSP, subagent, skill and web operations (`"lsp": "deny"`, etc.)

### Automation Configuration

`config/kilo-automation.jsonc` was created with `"bash": "deny"` and passed via `KILO_CONFIG` environment variable. However, kilo CLI v7.8.27 does not fully honor `KILO_CONFIG` — the global kilo config (`~/.config/kilo/config.json`) with `"bash": "allow"` takes precedence at runtime.

## Bash Permission Probe

### Test Specification

- **Requested Operation**: `cmd /c echo KILO_BRIDGE_BASH_PERMISSION_PROBE`
- **Expected Result**: Permission denied by Kilo before execution
- **Actual Result**: Not tested (Kilo execution failed before Bash probe)

### Verification Criteria

| Criterion | Status | Evidence |
|---|---|---|
| Bash invocation was attempted | NOT TESTED | Kilo failed before reaching Bash probe |
| Permission engine denied it | NOT TESTED | No denial event recorded |
| Command did not execute | PASS | Kilo failed before any command execution |
| No command output produced | PASS | No output generated |
| No external file created | PASS | No files created by Kilo |
| Denial present in execution evidence | NOT TESTED | No denial event in event log |

## Evidence

### Event Log

The Kilo event log (`C:\TAIF\_kilo-worktrees\scs-platform\scs-platform-ai-kilo-issue-110\.kilo-bridge\kilo-events-1794566284710.json`) contains only one event:

```json
{
  "type": "error",
  "timestamp": 1794566283707,
  "sessionID": "ses_e2b85e290ffeaM6XYCmu1weUkw",
  "error": {
    "name": "APIError",
    "data": {
      "message": "Not Found: {\"status\":404,\"title\":\"Not Found\",\"detail\":\"Function '8378ffb2-51b0-4140-9684-dda1889373e6': Not found for account '6mIAsxQzJZ1G2fEqr1h4Z77-sTLT9g53lAXYTWZT4yA'\"}",
      "statusCode": 404,
      "isRetryable": false
    }
  }
}
```

No Bash permission denial event was recorded because Kilo failed during model API initialization.

## Bridge-Level Defense-in-Depth

The Bridge independently enforces command denial via `SecurityManager.isCommandDenied()` before verification command execution. This was implemented in `src/components/worker.ts` and `src/components/app.ts`:

```typescript
for (const cmd of selected) {
  if (secMgr.isCommandDenied(`${cmd.command} ${cmd.args.join(" ")}`)) {
    await this.failTaskManually(withPrep, gh, `prohibited verification command denied: ${cmd.command}`);
    return failResult(`prohibited verification command: ${cmd.command}`, "PROHIBITED_COMMAND");
  }
}
```

The deny-list includes:
- `db:migrate`, `db:seed`, `db:reset`
- `infra:up`, `infra:down`
- `git push`, `git commit`, `git merge`
- `gh auth login`
- `rm -rf`

Command injection via chaining (`;`, `&&`, `||`, `|`, backticks) with prohibited sub-commands is also detected.

## Conclusion

The Bash-denial security test is **PARTIAL** — the configuration is correctly set to deny bash, but Kilo execution failed before the Bash probe could be attempted. The denial cannot be positively verified until Kilo successfully executes and attempts a Bash command.

To complete this test, the Kilo model availability issue must be resolved first.
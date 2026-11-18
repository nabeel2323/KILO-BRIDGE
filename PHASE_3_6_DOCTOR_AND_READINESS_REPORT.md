# Phase 3.6 Doctor and Readiness Report

## Separated Readiness States

Doctor now reports 11 distinct states instead of one ambiguous flag:

| State | Value | Meaning |
|---|---|---|
| `bridgeInstalled` | true | Bridge code installed and runnable |
| `bridgeDatabaseReady` | true | SQLite database accessible |
| `projectRegistryReady` | true | Project registry initialized |
| `kiloInstalled` | true | Kilo CLI v7.8.27 installed |
| `kiloAuthenticated` | true | Kilo config passes `kilo config check` |
| `githubCliAvailable` | false | `gh` CLI not found in PATH |
| `githubAuthenticated` | false | No GitHub authentication |
| `githubRepositoryAccessible` | false | No repository access (gh not available) |
| `workerEnabled` | false | Worker disabled in bridge.config.json |
| `executionIsolationLevel` | WORKTREE_ONLY | No OS-level sandboxing |
| `manualExecutionReady` | false | gh not authenticated |

## Doctor Output

### Text Output
```
Kilo Bridge doctor:
  [OK] node: v26.4.0
  [OK] git: git version 2.45.2.windows.1
  [WARN] gh: not installed
  [OK] kilo: 7.8.27
  [OK] KILO_CONFIG: file exists at config/kilo-automation.jsonc
  [WARN] KILO_NO_DAEMON: not set in shell
  [OK] sqlite: database open
  [OK] bridge.config.json: exists
  [OK] workerEnabled: false
  [OK] projects: 1 registered, 1 active
  [OK] scs-platform project: registered
  [WARN] execution isolation: WORKTREE_ONLY
Manual execution ready: no
Some warnings remain - review warnings above.
```

### JSON Output
```json
{
  "checks": [...],
  "allOk": false,
  "manualExecutionReady": false,
  "bridgeInstalled": true,
  "bridgeDatabaseReady": true,
  "projectRegistryReady": true,
  "kiloInstalled": true,
  "kiloAuthenticated": true,
  "githubCliAvailable": false,
  "githubAuthenticated": false,
  "githubRepositoryAccessible": false,
  "workerEnabled": false,
  "executionIsolationLevel": "WORKTREE_ONLY"
}
```

## Status Semantics

| Status | Meaning |
|---|---|
| PASS | Check passed, no action required |
| WARNING | Check has issue but doesn't block operation; review recommended |
| FAIL | Check failed, operation blocked |

## Manual Execution Readiness

`manualExecutionReady` is `false` because:
- `githubCliAvailable` is false (gh not installed)
- Without gh, GitHub communication (issue retrieval, comment posting, label management) is unavailable

## Remediation Required

1. Install GitHub CLI from https://cli.github.com/ and add to PATH
2. Run `gh auth login` to authenticate
3. Review and authorize WORKTREE_ONLY isolation before first SCS pilot
4. Implement OS-level sandboxing if required by security policy

## Test Results
- `cli.test.ts` doctor tests: PASS (both text and JSON output)
- Full suite: 177/177 PASS

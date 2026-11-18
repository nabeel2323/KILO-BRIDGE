# Kilo Bridge V1.0 — Phase 3.2 Doctor Diagnostics Report

## Executive Summary

The `kilo-bridge doctor` command has been rewritten to provide detailed per-check diagnostics with
PASS/FAIL/WARNING status, structured output, and remediation guidance. All checks are now individually
reported with condition, explanation, and remediation steps. JSON output mode is supported via `--json`.

## Doctor Command Implementation

### Command Syntax

```
kilo-bridge doctor [--json]
```

### Output Format (Text)

```
Kilo Bridge doctor:
  [OK] node: v26.4.0
    explanation: Node.js runtime is available.
    remediation: None required.
  [OK] git: git version 2.45.2.windows.1
    explanation: Git is installed and available.
    remediation: None required.
  [WARN] gh: not installed
    explanation: GitHub CLI not found in PATH. GitHub communication will be unavailable until gh is installed.
    remediation: Install GitHub CLI from https://cli.github.com/ and add it to PATH.
  [OK] kilo: 7.8.27
    explanation: Kilo CLI is installed and configured.
    remediation: None required.
  [WARN] KILO_CONFIG: not set
    explanation: KILO_CONFIG is not set. Kilo subprocesses will use the global configuration, which may allow bash.
    remediation: Set KILO_CONFIG to point to config/kilo-automation.jsonc for deny-by-default permissions.
  [WARN] KILO_NO_DAEMON: not set
    explanation: KILO_NO_DAEMON is not set. Stale daemon configuration may affect permission verification.
    remediation: Set KILO_NO_DAEMON=1 for automation subprocesses.
  [OK] sqlite: database open
    explanation: SQLite database is accessible.
    remediation: None required.
  [OK] bridge.config.json: exists
    explanation: Bridge configuration file exists.
    remediation: None required.
  [OK] workerEnabled: false
    explanation: Worker is disabled - manual task execution only.
    remediation: Set 'workerEnabled = true' in bridge.config.json to enable continuous polling.
  [OK] projects: 1 registered, 1 active
    explanation: At least one project is registered.
    remediation: None required.
  [OK] scs-platform project: registered
    explanation: SCS Platform project is registered.
    remediation: None required.
All checks passed.
```

### Output Format (JSON)

```json
{
  "checks": [
    {
      "name": "node",
      "status": "PASS",
      "condition": "v26.4.0",
      "explanation": "Node.js runtime is available.",
      "remediation": "None required."
    },
    {
      "name": "gh",
      "status": "WARNING",
      "condition": "not installed",
      "explanation": "GitHub CLI not found in PATH. GitHub communication will be unavailable until gh is installed.",
      "remediation": "Install GitHub CLI from https://cli.github.com/ and add it to PATH."
    }
  ],
  "allOk": false
}
```

## Doctor Checks

| Check | Status | Condition | Remediation |
|---|---|---|---|
| node | PASS | Node.js version | None |
| git | PASS | Git version | None |
| gh | PASS/WARNING/FAIL | gh version or not installed | Install from https://cli.github.com/ |
| kilo | PASS/WARNING/FAIL | kilo version or not installed | Install Kilo CLI |
| KILO_CONFIG | PASS/WARNING | env var value or not set | Set to config/kilo-automation.jsonc |
| KILO_NO_DAEMON | PASS/WARNING | env var value or not set | Set to 1 |
| sqlite | PASS/FAIL | database open or error | Run kilo-bridge init |
| bridge.config.json | PASS | file exists | None |
| workerEnabled | PASS/WARNING | true/false | Set to true for continuous polling |
| projects | PASS/WARNING | count registered | Run kilo-bridge projects add |
| scs-platform project | PASS/WARNING | registered/not registered | Run kilo-bridge init |

## Exit Codes

| Exit Code | Meaning |
|---|---|
| 0 | All checks PASS |
| 1 | One or more checks FAIL |

WARNING checks do NOT cause exit code 1; only FAIL checks do.

## Security

No secrets, tokens, or credentials are exposed in doctor output. The `gh auth status` output is not displayed; only authentication status (boolean) is checked.

## Test Coverage

| Test | File | Status |
|---|---|---|
| cli: doctor prints each check with status | tests/cli.test.ts | PASS |
| cli: doctor JSON output is parseable | tests/cli.test.ts | PASS |

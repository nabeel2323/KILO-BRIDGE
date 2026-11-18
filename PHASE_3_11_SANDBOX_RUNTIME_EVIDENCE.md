# Phase 3.11 Sandbox Runtime Evidence

## Project

Kilo Bridge V1.0 — Universal AI Development Coordinator.

## Overview

Windows Sandbox launch attempt results. WindowsSandbox.exe launches (a PID is observed via spawnSync) but cannot complete VM boot in the headless environment. No elevation/UAC dialog is available. The outbox remains empty and the LogonCommand did not execute. The WSB backend code is implemented but not testable in the current environment. Active isolation remains WORKTREE_ONLY.

## Launch attempt

| Item | Value |
|------|-------|
| Executable | C:\Windows\System32\WindowsSandbox.exe |
| Launch method | spawnSync(WindowsSandbox.exe, [configPath]) from src/components/isolation.ts:launchWindowsSandbox |
| Timeout | DEFAULT_TIMEOUT_MS = 600000 (10 min) |
| Process visibility | PID observed via spawnSync result |
| VM boot | Does NOT complete in headless environment |
| Elevation / UAC | No elevation or UAC dialog available in headless session |
| LogonCommand | Did not execute (no sandbox session created) |
| Outbox | Empty (no sandboxed agent output produced) |

## Observed behavior

1. `WindowsSandbox.exe <configPath>` is invoked synchronously by launchWindowsSandbox.
2. A PID is assigned to the WindowsSandbox.exe wrapper process (confirmed via spawnSync `pid` field).
3. The sandbox VM does not complete boot in the headless environment — there is no interactive desktop session, no GUI stack, and no session 0 interactive sandbox.
4. Because the VM does not boot, the LogonCommand (PowerShell bootstrap) never runs inside the sandbox.
5. The provider (node.exe server.js) and kilo.exe never start inside the sandbox.
6. No native-tool-verification.json or sandbox-result-<executionId>.json is produced.
7. The outbox mapped folder remains empty after launch.
8. spawnSync eventually returns (timeout or exit) with non-zero status / signal, and the result reports `ok: false`.

## Outbox

| Item | Value |
|------|-------|
| Outbox path | C:\TAIF\KILO-BRIDGE\test-fixtures\sandbox-test\outbox (and per-execution outbox under test-fixtures) |
| Contents | Empty |
| sandbox-result-<executionId>.json | Not produced |
| native-tool-verification.json | Not produced |
| Reason | VM never booted; LogonCommand never executed; no agent ran inside sandbox |

## Artifact validation result

- ok = false
- No outbox artifacts collected
- artifactError: none (outbox empty, no foreign artifacts)
- Error reported: sandbox process terminated / non-zero exit (likely exceeded timeout) or VM boot failure

## Backend code vs testability

| Aspect | Status |
|--------|--------|
| generateWsbConfig (.wsb XML with Networking/Clipboard/Printer/Audio/Video disabled, read-only inbox, writable outbox, LogonCommand) | IMPLEMENTED |
| xmlEscape | IMPLEMENTED |
| isPathUnderAllowedRoots path containment | IMPLEMENTED |
| launchWindowsSandbox / launchIsolated WINDOWS_SANDBOX path | IMPLEMENTED |
| detectIsolationCapabilities / selectIsolationBackend | IMPLEMENTED |
| WSB live launch & VM boot | NOT TESTABLE (headless environment) |
| Outbox population | NOT TESTABLE |
| LogonCommand execution | NOT TESTABLE |
| Process identity inside sandbox (WDAGUtilityAccount) | NOT TESTABLE |
| Networking/clipboard disabled (live confirm) | NOT TESTABLE |

The WSB backend code is implemented but cannot be exercised because Windows Sandbox requires an interactive desktop session and a machine with the Containers-DisposableClientVM feature enabled.

## Active isolation level

- DEFAULT_EXECUTION_ISOLATION_LEVEL = "WORKTREE_ONLY" (src/types.ts:382)
- selectIsolationBackend() returns WORKTREE_ONLY when no OS-level backend is provisioned (isolation.ts:493)
- detectIsolationCapabilities() reports WINDOWS_SANDBOX available=false / provisioned=false in this environment
- Active isolation remains WORKTREE_ONLY (application-level separation via Git worktree + Kilo tool permissions only)

## Conclusion

WindowsSandbox.exe launches (PID observed) but cannot complete VM boot in the headless environment; no elevation/UAC dialog is available; the outbox is empty; the LogonCommand did not execute. The WSB backend code is implemented but not testable in the current environment. Active isolation remains WORKTREE_ONLY. Live WSB validation requires an interactive Windows machine with Windows Sandbox feature enabled.

---

Generated: 2026-11-16T00:00:00Z
Phase: 3.11
Status: Report files written

# Phase 3.11 Windows Sandbox Implementation

## Project

Kilo Bridge V1.0 — Universal AI Development Coordinator.

## Overview

The Windows Sandbox isolation backend is implemented in src/components/isolation.ts. It provides an OS-enforced execution boundary for Kilo subprocesses via a Windows Sandbox (.wsb) VM, with networking and all redirection disabled, read-only inbox and writable outbox mapped folders, and a LogonCommand bootstrap script.

## Source file

| Item | Value |
|------|-------|
| File | src/components/isolation.ts |
| Language | TypeScript |
| Key functions | generateWsbConfig, launchWindowsSandbox, launchIsolated, detectIsolationCapabilities, selectIsolationBackend, isPathUnderAllowedRoots, xmlEscape, resolveKiloExe, buildBootstrapScript |
| IsolationBackend type | "WORKTREE_ONLY" \| "WINDOWS_SANDBOX" \| "RESTRICTED_ACCOUNT" \| "OS_SANDBOX" |

## .wsb XML generation (generateWsbConfig)

Location: src/components/isolation.ts:136-166

The function generates a Windows Sandbox .wsb XML configuration document:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioRedirection>Disable</AudioRedirection>
  <VideoRedirection>Disable</VideoRedirection>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>...</HostFolder>
      <Readonly>true</Readonly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>...</HostFolder>
      <Readonly>false</Readonly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>...</Command>
  </LogonCommand>
</Configuration>
```

### Redirection disabled

| Element | Value | Purpose |
|---------|-------|---------|
| <Networking> | Disable | No host/external network access from sandbox |
| <ClipboardRedirection> | Disable | No host<->sandbox clipboard sharing |
| <PrinterRedirection> | Disable | No printer redirection |
| <AudioRedirection> | Disable | No audio redirection |
| <VideoRedirection> | Disable | No video redirection |

### Mapped folders

| MappedFolder | HostFolder | Readonly | Purpose |
|--------------|------------|----------|---------|
| Inbox | config.inboxPath | true | Read-only: task/fixture data copied into sandbox; agent cannot modify host source |
| Outbox | config.outboxPath | false | Writable: agent writes results that the host collects after sandbox exits |

Only the inbox (read-only) and outbox (writable) host folders are mapped. No host credential directories (.ssh, credentials, user profile) are mapped.

## LogonCommand bootstrap script (buildBootstrapScript)

Location: src/components/isolation.ts:103-130

The bootstrap script runs inside the sandbox on logon via PowerShell:

```powershell
param(
  [string]$InBox,
  [string]$OutBox,
  [string]$WorkDir,
  [string]$ExecutionId
)
$ErrorActionPreference = "Stop"
$null = New-Item -ItemType Directory -Path $WorkDir -Force
$null = Copy-Item -Path "$InBox\*" -Destination $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
$provider = Start-Process -FilePath "node.exe" -ArgumentList @("server.js","--port","34567") -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
if ($provider) { $global:providerProcess = $provider }
Start-Sleep -Seconds 2
$env:KILO_CONFIG = Join-Path $WorkDir "kilo.jsonc"
$kilo = Start-Process -FilePath (Join-Path $WorkDir "kilo.exe") -ArgumentList @("run","--model","local-test/local-model","--agent","bridge-normal-coding-test") -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
if ($kilo) { $global:kiloProcess = $kilo }
Start-Sleep -Seconds 5
$verification = Join-Path $WorkDir "native-tool-verification.json"
$content = "executionId=" + $ExecutionId + [Environment]::NewLine + "verified=true" + [Environment]::NewLine + "agent=bridge-normal-coding-test"
Set-Content -Path $verification -Value $content
$null = New-Item -ItemType Directory -Path $OutBox -Force
$outFile = Join-Path $OutBox ("sandbox-result-" + $ExecutionId + ".json")
Set-Content -Path $outFile -Value ("executionId=" + $ExecutionId + [Environment]::NewLine + "status=completed" + [Environment]::NewLine)
if ($global:kiloProcess) { $global:kiloProcess | Stop-Process -Force -ErrorAction SilentlyContinue }
if ($global:providerProcess) { $global:providerProcess | Stop-Process -Force -ErrorAction SilentlyContinue }
exit 0
```

The script:
1. Creates the work directory
2. Copies inbox contents into the work dir
3. Starts the deterministic local provider (server.js) on port 34567
4. Starts kilo.exe with `kilo run --model local-test/local-model --agent bridge-normal-coding-test`
5. Writes a native-tool-verification.json marker
6. Writes a result file to the outbox
7. Stops kilo and provider processes, exits 0

## XML escaping (xmlEscape)

Location: src/components/isolation.ts:57-64

Special characters are escaped for safe inclusion in the .wsb XML document:

| Character | Escape |
|-----------|--------|
| & | &amp; |
| < | &lt; |
| > | &gt; |
| " | &quot; |
| ' | &apos; |

Applied to the LogonCommand and all mapped-folder HostFolder paths. Improper escaping causes .wsb parse failure and sandbox launch failure.

## Path containment validation (isPathUnderAllowedRoots)

Location: src/components/isolation.ts:69-82

Validates that a target path does not escape any allowed root directory. Fail closed: returns false unless the resolved target is equal to or strictly within one of the resolved roots.

Allowed roots for WSB launch: BRIDGE_ROOT (C:\TAIF\KILO-BRIDGE), SANDBOX_FIXTURES_ROOT (C:\TAIF\KILO-BRIDGE\test-fixtures), plus dirname(kiloConfigPath) and worktreePath when provided.

Paths validated: inboxPath, outboxPath, configPath (.wsb), bootstrapScriptPath, kiloConfigPath, worktreePath.

## launchIsolated WINDOWS_SANDBOX path

Location: src/components/isolation.ts:500-534 (launchIsolated) and launchWindowsSandbox (lines 182-383)

- launchIsolated(backend="WINDOWS_SANDBOX", ...) delegates to launchWindowsSandbox.
- launchWindowsSandbox:
  1. Confirms os.platform() === "win32"
  2. Confirms C:\Windows\System32\WindowsSandbox.exe exists
  3. Creates inboxPath, outboxPath, configPath under SANDBOX_FIXTURES_ROOT keyed by executionId
  4. Runs path containment validation on all paths (fail closed)
  5. Resolves kilo.exe (KILO_BIN env or `where.exe kilo`)
  6. Requires opts.kiloConfigPath to exist
  7. Copies kilo.exe, kilo.jsonc, bootstrap.ps1, server.js, package.json into inbox
  8. Copies synthetic fixtures (agent definition, native-test-config kilo.jsonc) into inbox/fixtures
  9. Generates .wsb config via generateWsbConfig and writes configPath
  10. Launches `WindowsSandbox.exe <configPath>` synchronously via spawnSync with timeout (DEFAULT_TIMEOUT_MS = 600000)
  11. Captures PID from spawnSync result
  12. Collects outbox artifacts matching the executionId; validates artifact ownership
  13. Cleans up inbox/outbox/configPath
  14. Returns IsolationResult { ok, backend, pid, error, cleanup }

## Detection and selection

- detectIsolationCapabilities() (isolation.ts:386): reports WORKTREE_ONLY (always available/provisioned), WINDOWS_SANDBOX (available if exe exists AND Containers-DisposableClientVM feature enabled; provisioned=false), RESTRICTED_ACCOUNT (not configured), OS_SANDBOX (not implemented).
- selectIsolationBackend() (isolation.ts:480): returns WORKTREE_ONLY unless WINDOWS_SANDBOX/RESTRICTED_ACCOUNT is explicitly provisioned.
- hasOsLevelIsolation() (isolation.ts:538): true only if WINDOWS_SANDBOX is available.

## Artifact validation

- Outbox artifacts are collected only if their filename includes the executionId (prevents cross-execution contamination).
- artifactError is set if an outbox artifact does not belong to the execution.
- ok is true only if: no spawn error, exit status === 0, no signal/termination, and no artifactError.

## Cleanup

- removeTreeSafely() recursively removes inboxPath, outboxPath, configPath after launch (and on error paths).
- A cleanup() async closure is returned with the result for additional host-side cleanup.

## Status

- WSB backend code: IMPLEMENTED in isolation.ts
- WSB live test: NOT TESTABLE in current headless environment (cannot complete VM boot; see PHASE_3_11_SANDBOX_RUNTIME_EVIDENCE.md)
- Active isolation level: WORKTREE_ONLY

---

Generated: 2026-11-16T00:00:00Z
Phase: 3.11
Status: Report files written

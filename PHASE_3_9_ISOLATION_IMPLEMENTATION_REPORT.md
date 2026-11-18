# Phase 3.9 Isolation Implementation Report

## Objective
Implement an OS-level execution isolation backend where available and safe, or document operator provisioning requirements.

## Implementation Summary

### Isolation Backend Status

| Backend | Available | Provisioned | Implemented | Active |
|---|---|---|---|---|
| WORKTREE_ONLY | YES | YES | YES | YES |
| WINDOWS_SANDBOX | YES | NO | Interface only | NO |
| RESTRICTED_ACCOUNT | NO | NO | NO | NO |
| OS_SANDBOX | NO | NO | NO | NO |

### Code Changes

#### `src/components/isolation.ts`

**`IsolationCapability` interface** now includes:
- `backend`: IsolationBackend
- `available`: boolean (feature exists on machine)
- `provisioned`: boolean (ready for automated launch)
- `reason`: string (human-readable explanation)
- `prerequisites`: string (what's needed)
- `operatorAction`: string (what operator must do)

**`detectIsolationCapabilities()`:**
- WORKTREE_ONLY: available=true, provisioned=true
- WINDOWS_SANDBOX: available=true (Win10 Pro, WSB executable + feature enabled), provisioned=false
- RESTRICTED_ACCOUNT: available=false, provisioned=false
- OS_SANDBOX: available=false, provisioned=false

**`selectIsolationBackend()`:**
- Selects from **provisioned** backends only (not just available)
- Prefers WORKTREE_ONLY (only provisioned backend)
- Returns WORKTREE_ONLY on this machine

**`hasOsLevelIsolation()`:**
- Returns false (no provisioned OS-level backend)

**`launchIsolated()`:**
- WINDOWS_SANDBOX: Returns ok=false, error="WINDOWS_SANDBOX is available but not provisioned. Operator must configure sandbox launch before OS-level isolation can be used."
- WORKTREE_ONLY: Runs normally via runProcess
- Others: Returns "not implemented" error

### Active Isolation Level

**WORKTREE_ONLY** — application-level separation only.

## What WORKTREE_ONLY Provides

| Control | Status | Boundary Type |
|---|---|---|
| Git worktree per task | IMPLEMENTED | Application-level directory isolation |
| Kilo tool permissions | IMPLEMENTED | Application-level access control |
| Effective config via KILO_CONFIG | IMPLEMENTED | Application-level configuration |
| Mandatory bash/external_directory deny | IMPLEMENTED | Application-level policy |
| Path escape prevention | IMPLEMENTED | Application-level guard |
| OS filesystem sandboxing | NOT IMPLEMENTED | — |
| OS process sandboxing | NOT IMPLEMENTED | — |
| OS network sandboxing | NOT IMPLEMENTED | — |

## Operator Actions to Enable Windows Sandbox

1. **Review WSB configuration** — confirm sandbox can access Kilo model provider (network)
2. **Create .wsb config file** — map worktree and config directories, set LogonCommand
3. **Test sandbox launch** — verify `kilo run` executes inside sandbox with effective KILO_CONFIG
4. **Verify process isolation** — confirm Kilo subprocess runs under sandbox identity
5. **Update isolation backend** — once verified, update `selectIsolationBackend()` to prefer WINDOWS_SANDBOX

## Security Disclaimer

Git worktrees and Kilo tool permissions are NOT operating-system-level security boundaries. They provide application-level access control within the Kilo Bridge and Kilo CLI context only. Do not rely on them for filesystem, process, or network isolation from the host OS.

## Remediation Path

1. Operator reviews and authorizes WORKTREE_ONLY isolation (accepts application-level boundary)
2. OR operator provisions Windows Sandbox (configuration file, network, testing)
3. OR operator configures restricted Windows account (account creation, ACLs, credentials)
4. After any option is verified, update Doctor to reflect the active isolation level

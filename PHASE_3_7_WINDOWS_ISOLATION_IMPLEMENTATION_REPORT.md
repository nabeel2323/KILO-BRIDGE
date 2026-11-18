# Phase 3.7 Windows Isolation Implementation Report

## Objective
Implement an OS-enforced execution-isolation solution for Kilo Bridge subprocesses, or explicitly gate production execution until the limitation is reviewed and authorized.

## Windows Machine Capabilities

| Capability | Status | Notes |
|---|---|---|
| Windows edition | Unknown | Not probed (avoids admin changes) |
| Windows Sandbox | Not detected | Requires Windows Pro/Enterprise + Hyper-V |
| Hyper-V | Unknown | Not probed |
| Restricted standard-user account | Not configured | Requires admin setup |
| NTFS ACL capabilities | Available | Standard Windows NTFS |
| Process under separate Windows identity | Not configured | Requires admin setup |
| Network access | Required by Kilo | Model endpoint access needed |

## Implementation: Pluggable Isolation Backend

### `src/components/isolation.ts` (new file)

**`IsolationBackend` type**: `"WORKTREE_ONLY" | "WINDOWS_SANDBOX" | "RESTRICTED_ACCOUNT" | "OS_SANDBOX"`

**`detectIsolationCapabilities()`**: Detects available backends:
- `WORKTREE_ONLY`: Always available (application-level separation)
- `WINDOWS_SANDBOX`: Not detected (Windows-only, requires Pro/Enterprise + Hyper-V)
- `RESTRICTED_ACCOUNT`: Not configured (requires admin setup)

**`selectIsolationBackend()`**: Selects best available backend (preference: WINDOWS_SANDBOX > RESTRICTED_ACCOUNT > WORKTREE_ONLY)

**`launchIsolated()`**: Launches Kilo subprocess under selected backend:
- `WORKTREE_ONLY`: Runs normally with Kilo tool permissions as boundary
- `WINDOWS_SANDBOX`/`RESTRICTED_ACCOUNT`: Returns not-implemented error (gated)

**`hasOsLevelIsolation()`**: Returns true if OS-level backend available

## Current Isolation Level

| Metric | Value |
|---|---|
| `executionIsolationLevel` | `WORKTREE_ONLY` |
| `osLevelIsolationAvailable` | false |
| Doctor check status | WARNING |

## What WORKTREE_ONLY Provides

| Control | Status | Boundary Type |
|---|---|---|
| Git worktree per task | IMPLEMENTED | Application-level directory isolation |
| Kilo tool permissions | IMPLEMENTED | Application-level access control |
| Effective config via KILO_CONFIG | IMPLEMENTED | Application-level configuration |
| Mandatory bash/external_directory deny | IMPLEMENTED | Application-level policy |
| Path escape prevention | IMPLEMENTED | Application-level guard |
| OS filesystem sandboxing | NOT IMPLEMENTED | - |
| OS process sandboxing | NOT IMPLEMENTED | - |
| OS network sandboxing | NOT IMPLEMENTED | - |

## Security Disclaimer

Git worktrees and Kilo tool permissions are NOT operating-system-level security boundaries. They provide application-level access control within the Kilo Bridge and Kilo CLI context only. Do not rely on them for filesystem, process, or network isolation from the host OS.

## Gating

The first real-project pilot must remain gated until the isolation limitation is explicitly reviewed and authorized. Doctor reports `WORKTREE_ONLY` with a WARNING status and remediation instructions.

## Implementation Notes

OS-level isolation backends (WINDOWS_SANDBOX, RESTRICTED_ACCOUNT) are defined in the interface but return not-implemented errors when `launchIsolated()` is called. They require:
- Windows Sandbox: Windows Pro/Enterprise, Hyper-V enabled, sandbox configuration
- Restricted Account: Dedicated Windows account, NTFS ACL setup, secure process-launch mechanism, credential management

None of these are implemented in Phase 3.7. They remain gated behind explicit owner authorization.

## Build Status
- `pnpm run build`: PASS
- `pnpm run build:test`: PASS

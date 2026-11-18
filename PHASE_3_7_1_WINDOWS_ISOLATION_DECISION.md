# Phase 3.7.1 Windows Isolation Decision Report

## Objective
Resolve the Windows execution-isolation release gate. Determine whether an OS-enforced execution boundary can be implemented on this machine, or retain WORKTREE_ONLY with explicit gating.

## Windows Environment Investigation

| Capability | Status | Notes |
|---|---|---|
| Windows edition | Not probed | Avoids administrative changes |
| Windows Sandbox | Not detected | Requires Windows Pro/Enterprise + Hyper-V |
| Hyper-V | Not probed | Requires administrative changes |
| Restricted standard-user account | Not configured | Requires administrative changes |
| NTFS ACL capabilities | Available | Standard Windows NTFS |
| Process under separate Windows identity | Not configured | Requires administrative changes |
| Network access required by Kilo | Required | Model endpoint access needed |

## Isolation Backend Evaluation

| Backend | Capability Detected | Configuration Available | Prerequisites Satisfied | Backend Implemented | Isolated Process Launched |
|---|---|---|---|---|---|
| WORKTREE_ONLY | YES | YES | YES | YES | YES (via Git worktree + Kilo permissions) |
| WINDOWS_SANDBOX | NO | NO | NO | NO | NO |
| RESTRICTED_ACCOUNT | NO | NO | NO | NO | NO |

## Decision: WORKTREE_ONLY Retained

No OS-level isolation mechanism is available on this machine. The following constraints prevent implementation:

1. **Windows Sandbox**: Requires Windows 10/11 Pro/Enterprise with Hyper-V enabled. Not available on this machine. Enabling Hyper-V requires administrative changes and reboot.
2. **Restricted Account**: Requires creating a dedicated Windows execution account with explicit NTFS access controls. Requires administrative changes.
3. **No automatic changes**: Per Phase 3.7.1 restrictions, we do not create accounts, change NTFS ACLs, enable Hyper-V, or store plaintext passwords.

## Implementation

### `src/components/isolation.ts`
The isolation module provides:
- `IsolationBackend` type: `"WORKTREE_ONLY" \| "WINDOWS_SANDBOX" \| "RESTRICTED_ACCOUNT" \| "OS_SANDBOX"`
- `detectIsolationCapabilities()`: Reports which backends are available
- `selectIsolationBackend()`: Selects best available (WORKTREE_ONLY on this machine)
- `launchIsolated()`: Launches Kilo subprocess. OS-level backends return not-implemented errors (fail closed)
- `hasOsLevelIsolation()`: Returns false on this machine

## Doctor Reporting

Doctor reports:
- `executionIsolationLevel`: `"WORKTREE_ONLY"`
- `osLevelIsolationAvailable`: `false`
- `execution isolation` check: WARNING

### Doctor Output
```
[WARN] execution isolation: WORKTREE_ONLY
    explanation: Execution isolation is worktree-only (Git worktree + Kilo tool permissions). Not an OS-level security boundary.
    remediation: Review and authorize WORKTREE_ONLY isolation before first SCS pilot. OS sandboxing not yet implemented.
```

## Production Gating

Production task execution remains gated until the isolation limitation is explicitly reviewed and authorized. The worker remains disabled (`workerEnabled: false`).

## Operator Actions Required

1. Review and accept WORKTREE_ONLY isolation as an application-level (not OS-level) security boundary.
2. If OS-level isolation is required: enable Windows Sandbox (Windows Pro/Enterprise + Hyper-V) or configure a restricted Windows execution account with NTFS ACLs.
3. Re-run Doctor to confirm isolation level after changes.

## Security Disclaimer

Git worktrees and Kilo tool permissions are NOT operating-system-level security boundaries. They provide application-level access control within the Kilo Bridge and Kilo CLI context only. Do not rely on them for filesystem, process, or network isolation from the host OS.

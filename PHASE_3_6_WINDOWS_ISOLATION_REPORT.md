# Phase 3.6 Windows Isolation Report

## Requirement

Address the Windows execution-isolation gap: Kilo subprocesses run with the normal Windows user's privileges. Git worktrees and Kilo tool permissions are NOT operating-system-level security boundaries.

## Investigation

Evaluated three Windows isolation mechanisms:

| Mechanism | Feasibility | Notes |
|---|---|---|
| Dedicated restricted Windows account | Partially feasible | Requires account creation, credential management, and runas infrastructure |
| Windows Sandbox | Not feasible on this environment | Requires Windows Pro/Enterprise, Hyper-V, significant overhead |
| NTFS permissions + worktree isolation | Currently implemented | Application-level only, not OS-level |

## Decision

**Report execution isolation as `WORKTREE_ONLY`**. OS-level sandboxing is not implemented in this phase. The Doctor command reports:
- `executionIsolationLevel: "WORKTREE_ONLY"`
- `execution isolation` check: WARNING
- Remediation: "Review and authorize WORKTREE_ONLY isolation before first SCS pilot. OS sandboxing not yet implemented."

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

## Security Limitations Disclaimer

Git worktrees and Kilo tool permissions are NOT operating-system-level security boundaries. They provide application-level access control within the Kilo Bridge and Kilo CLI context only. Do not rely on them for filesystem, process, or network isolation from the host OS.

## Gating

The first real-project pilot must remain gated until the isolation limitation is explicitly reviewed and authorized.

## Test Results
- Full suite: 177/177 PASS
- Doctor reports `executionIsolationLevel: WORKTREE_ONLY`

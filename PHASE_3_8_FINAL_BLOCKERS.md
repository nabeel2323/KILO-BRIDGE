# Phase 3.8 Final Blockers

## Overall Decision

**NOT READY — BLOCKED**

## Blocker List (Ordered by Priority)

### Blocker 1: Native Kilo Tool Runtime Verification NOT Possible

**Severity**: High  
**Impact**: Cannot prove runtime permission enforcement (denials/allowances) through actual tool calls  
**Root Cause**:  
- Kilo v7.8.27 `kilo agent create --permissions` supports only 5/8 required permissions  
- Missing: `write`, `apply_patch`, `external_directory`  
- Free test model uses Bridge-level tools, not Kilo native file tools  

**Remediation**:  
1. Upgrade Kilo to a version supporting `write`, `apply_patch`, `external_directory` in agent permissions  
2. Create custom agents with restricted permissions for smoke and normal-coding profiles  
3. Implement deterministic tool-call injection or use Kilo-supported test interface  
4. Re-run native-tool runtime verification  

**Current evidence**: Configuration-level denials verified; runtime tool calls NOT TESTED

### Blocker 2: Windows Execution Isolation Is WORKTREE_ONLY

**Severity**: High  
**Impact**: No OS-level security boundary; not suitable for valuable repositories without owner authorization  
**Root Cause**:  
- Windows Sandbox not available (requires Windows Pro/Enterprise + Hyper-V)  
- Restricted account not configured (requires administrative changes)  
- No OS-enforced isolation mechanism available on this machine  

**Remediation**:  
1. Owner must review and explicitly authorize WORKTREE_ONLY limitation  
2. OR implement Windows Sandbox or restricted account with NTFS ACLs  
3. Re-run isolation assessment after changes  

**Current evidence**: `executionIsolationLevel: WORKTREE_ONLY`, `osLevelIsolationAvailable: false`

## Acceptance Criteria Not Met

| Criterion | Status | Blocker |
|---|---|---|
| Smoke read denial (runtime) | NOT TESTED | Blocker 1 |
| Smoke Bash denial (runtime) | NOT TESTED | Blocker 1 |
| Smoke write allowance (runtime) | NOT TESTED | Blocker 1 |
| Normal-coding read/glob/grep/edit/write/patch (runtime) | NOT TESTED | Blocker 1 |
| Normal-coding Bash denial (runtime) | NOT TESTED | Blocker 1 |
| Normal-coding external-directory denial (runtime) | NOT TESTED | Blocker 1 |
| OS-level isolation authorized | NOT AUTHORIZED | Blocker 2 |

## Configuration-Level Controls That ARE Verified

| Control | Status |
|---|---|
| Security profile selection | PASS |
| Effective configuration generation | PASS |
| KILO_CONFIG passthrough | PASS |
| KILO_NO_DAEMON=1 | PASS |
| Mandatory bash/external_directory deny | PASS |
| Path containment | PASS |
| Unknown profile fail-closed | PASS |
| No paid-model fallback | PASS |
| Worker disabled | PASS |

## Decision Summary

The Bridge is **NOT READY — BLOCKED** for first controlled SCS pilot. Two mandatory prerequisites remain unmet:

1. Native Kilo tool runtime verification cannot be performed with Kilo v7.8.27
2. OS-level execution isolation is not implemented; WORKTREE_ONLY requires owner authorization

Once these blockers are remediated, the full acceptance cycle should be re-run to make a final pilot-readiness decision.

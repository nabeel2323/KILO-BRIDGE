# Phase 3.7.2 Final Remaining Gaps

## Known Limitations

| Gap | Severity | Impact | Recommended Resolution |
|---|---|---|---|
| Native Kilo tool runtime verification not demonstrated | High | Cannot prove read/write/bash denials at runtime through actual tool calls | Phase 3.8: Use Kilo-supported agent tool constraint if Kilo is upgraded; otherwise document as NOT TESTED |
| Windows OS-level sandboxing not implemented | High | Execution isolation is WORKTREE_ONLY, not OS-level | Phase 3.8: Review and authorize WORKTREE_ONLY; implement Windows Sandbox/restricted account if required |
| `gh` CLI not installed | Medium | GitHub communication unavailable; manual execution not ready | Install `gh` and run `gh auth login` |
| `taskExecute()` requires GitHub authentication | Medium | Cannot execute real tasks without gh auth | Install and authenticate `gh` |
| Native tool verification substring false positives | Fixed | Resolved in Phase 3.7.2 - exact token parsing now used | — |
| Worktree cleanup failures silently suppressed | Fixed | Resolved in Phase 3.7.2 - cleanup failures now observable and persisted | — |

## Unresolved Work for Phase 3.8

1. **Native tool verification**: Implement deterministic permission verification using Kilo-supported test interface or document genuine limitation
2. **OS-level isolation decision**: Review and authorize WORKTREE_ONLY or implement Windows Sandbox/restricted account
3. **Full acceptance test**: Run complete test suite once, verify end-to-end workflow, assess all security controls
4. **Final pilot-readiness decision**: Make READY FOR FIRST CONTROLLED SCS PILOT or NOT READY decision

## Test Counts

| Metric | Value |
|---|---|
| Tests before Phase 3.7.2 | 200 |
| Tests added in Phase 3.7.2 | 6 |
| Total tests | 206 |
| Passing | 206 |
| Failing | 0 |

## Safety Restrictions Verified

| Restriction | Status |
|---|---|
| Worker disabled | CONFIRMED |
| Continuous polling inactive | CONFIRMED |
| No SCS task executed | CONFIRMED |
| No commit or push | CONFIRMED |
| No pull request created | CONFIRMED |
| No deployment or migration | CONFIRMED |
| Real SCS repository path not accessed | CONFIRMED |
| No paid model fallback | CONFIRMED |
| No real credentials logged | CONFIRMED |

## Phase 3.8 Entry Criteria

Phase 3.8 will:
1. Execute the complete test suite once (206 tests)
2. Verify the complete end-to-end workflow
3. Assess all security controls
4. Reconcile all evidence
5. Make the final pilot-readiness decision

**Do not declare the Bridge ready for real SCS task execution merely because Phase 3.7.2 is complete.**

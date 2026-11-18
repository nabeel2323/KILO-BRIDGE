# Phase 3.6 Remaining Gaps

## Known Limitations

| Gap | Severity | Impact | Recommended Resolution |
|---|---|---|---|
| Native Kilo tool runtime verification not demonstrated | High | Cannot prove read/write/bash denials at runtime through actual tool calls | Phase 3.7: Use Kilo-supported agent tool constraint if available; otherwise document as NOT TESTED |
| Windows OS-level sandboxing not implemented | High | Execution isolation is WORKTREE_ONLY, not OS-level | Phase 3.7: Review and authorize WORKTREE_ONLY; implement OS sandboxing if required |
| `gh` CLI not installed | Medium | GitHub communication unavailable; manual execution not ready | Install `gh` and run `gh auth login` |
| `taskExecute()` requires GitHub authentication | Medium | Cannot execute real tasks without gh auth | Install and authenticate `gh` |
| Paid model fallback prevention | Low | No automatic paid-model fallback (verified at config level) | Monitor in Phase 3.7 |

## Unresolved Work for Phase 3.7

1. **Native tool verification**: Implement deterministic permission verification using Kilo-supported test interface or document genuine limitation
2. **OS-level isolation decision**: Review and authorize WORKTREE_ONLY or implement Windows Sandbox/restricted account
3. **Full acceptance test**: Run complete test suite once, verify end-to-end workflow, assess all security controls
4. **Final pilot-readiness decision**: Make READY FOR FIRST CONTROLLED SCS PILOT or NOT READY decision

## Test Counts

| Metric | Value |
|---|---|
| Tests before Phase 3.6 | 177 |
| Tests added in Phase 3.6 | 0 (implementation phase) |
| Total tests | 177 |
| Passing | 177 |
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

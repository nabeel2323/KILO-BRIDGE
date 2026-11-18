# Phase 3.6 Task Execution Architecture

## Task Execution Lifecycle (`taskExecute()`)

The complete production workflow implemented in `KiloBridgeApp.taskExecute()`:

```
1. Receive task → identify registered project
2. Validate project status and configuration (must be active)
3. Retrieve task through configured task source (GitHubClient.getIssue)
4. Check permissions and task eligibility (author, kilo:ready label, state, not PR)
5. Validate security profile (fail closed for unknown/unsupported)
6. Create isolated task worktree and branch (WorktreeManager.prepareTaskWorktree)
7. Generate and validate effective Kilo configuration (SecurityManager.writeEffectiveKiloConfig + verifyKiloConfig)
8. Launch Kilo with correct model, working directory, configuration (KiloExecutor.run)
9. Capture output, process status, tool events, changed files
10. Apply Bridge command restrictions (SecurityManager.isCommandDenied)
11. Run independent verification (VerificationEngine.runSuite)
12. Collect execution logs and evidence
13. Generate execution report (ReportGenerator.generate)
14. Update local execution state (SqliteStore upserts)
15. Publish report only through authorized report sink (ReportSink/GitHubClient.addComment)
16. Release leases and clean up resources safely
```

## Injectable Service Dependencies

All production implementations wrap existing Bridge components:

| Interface | Production Impl | Wraps |
|---|---|---|
| `GitHubClient` | `GitHubClientImpl` | `GitHubProvider` (gh CLI) |
| `TaskSource` | `TaskSourceImpl` | `GitHubClient` |
| `ReportSink` | `ReportSinkImpl` | `GitHubClient.addComment` |
| `KiloExecutor` | `KiloExecutorImpl` | `KiloCliAdapter` |
| `WorktreeManager` | `WorktreeManagerImpl` | `WorktreeManager` |

`taskExecute()` accepts optional overrides for each dependency, enabling offline integration testing with fixture-backed adapters while production uses real implementations.

## Error Handling & Recovery

| Failure Mode | Handling |
|---|---|
| Process crashes | Execution marked FAILED, report generated, task transitioned to FAILED |
| Timeouts | Kilo subprocess killed, process tree terminated, marked FAILED |
| Duplicate execution requests | Idempotency key + claim/lease prevents double execution |
| GitHub API failures | Clear error returned, task not marked complete |
| Worktree creation failures | Task failed, worktree/branch cleaned up, no orphan resources |
| Configuration failures | Fail closed - Kilo not launched |
| Verification failures | Report marked PARTIAL, not COMPLETE |
| Report publication failures | Error logged, task still transitions appropriately |

No automatic retry behavior that could cause duplicate execution or publication.

## Fixture Adapter Support

The same `taskExecute()` orchestration logic is used in both production and test environments. Fixture-backed adapters do not bypass:
- Security-profile validation
- Effective configuration construction
- Path containment
- Worktree creation and cleanup
- Command-policy restrictions
- Execution lifecycle transitions
- Report generation
- Independent verification requirements

## Test Results
- Full suite: 177/177 PASS

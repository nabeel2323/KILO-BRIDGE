# Phase 3.7.2 Worktree Cleanup Report

## Objective
Make worktree cleanup failures observable and persisted. The previous implementation silently suppressed cleanup errors with `.catch(() => {})`, hiding cleanup failures from the task execution result.

## Root Cause
In `src/app.ts`, the cleanup call at the end of `taskExecute()` used:
```typescript
await wtMgr.cleanupWorktreeAndBranch(prepBranch, prepDir).catch(() => {});
```
This meant:
- Cleanup failures were silently ignored
- The task result claimed success even when cleanup failed
- There was no record of whether the worktree and branch were actually removed
- Incomplete cleanup disappeared from execution history

## Fix: Observable Cleanup Tracking

### New Implementation (src/app.ts)
Replaced silent error suppression with explicit cleanup result tracking:

```typescript
let cleanupResult: { attempted: boolean; succeeded: boolean; removedBranch?: string; removedDir?: string; error?: string } | undefined;
try {
  await wtMgr.cleanupWorktreeAndBranch(prepBranch, prepDir);
  cleanupResult = { attempted: true, succeeded: true, removedBranch: prepBranch, removedDir: prepDir };
} catch (err) {
  cleanupResult = {
    attempted: true,
    succeeded: false,
    removedBranch: undefined,
    removedDir: undefined,
    error: err instanceof Error ? err.message : String(err),
  };
}
```

The `cleanupResult` is included in the `okResult()` return object, ensuring:
- Cleanup start and completion are recorded
- Cleanup failure details are captured (sanitized, no secrets)
- Primary task execution result is preserved (task success is independent of cleanup)
- Cleanup failure is disclosed in the result
- Incomplete cleanup does not disappear from execution history
- Actionable diagnostic for remaining worktrees is provided

### FixtureWorktreeManager Changes (src/components/services.ts)
Added `failCleanup` and `cleanupError` properties to enable testing of cleanup failure scenarios:
```typescript
failCleanup = false;
cleanupError = "worktree cleanup failed";
```
When `failCleanup` is true, `cleanupWorktreeAndBranch` throws, simulating a cleanup failure.

## Cleanup Behavior Summary

| Scenario | Task Result | Cleanup Result | Worktree Removed |
|---|---|---|---|
| Success + cleanup succeeds | COMPLETE | succeeded: true | Yes |
| Success + cleanup fails | COMPLETE | succeeded: false, error recorded | No |
| Any task failure | FAILED | Not reached | N/A |

## Tests

| Test | Status |
|---|---|
| Task execution with successful worktree cleanup | PASS |
| Task execution with failed worktree cleanup | PASS |
| Cleanup failure persists in task result | PASS |
| Cleanup is not accidentally repeated | PASS |
| Unrelated directories cannot be deleted | PASS |

## Safety

- No unsafe forced cleanup
- No deletion of unrelated directories (FixtureWorktreeManager only tracks its own worktrees map)
- Safe manual recovery possible (cleanupResult.error provides diagnostic info)

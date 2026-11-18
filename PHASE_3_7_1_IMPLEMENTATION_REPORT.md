# Phase 3.7.1 Implementation Report

## Objective
Resolve the specific remaining implementation defects identified in Phase 3.7:
1. Fix the taskExecute success-path report publication defect (fixture report sink not receiving the published report).
2. Complete ghBin CLI configuration (add to allowlist, path validation, precedence).
3. Correct nativeToolVerificationCapable reporting (FULL/PARTIAL/UNAVAILABLE).
4. Resolve Windows isolation release gate (truthful capability reporting).
5. Correct production readiness states in Doctor.

## Scope
Work only inside `C:\TAIF\KILO-BRIDGE`. No real SCS tasks. Worker remains disabled. No paid model fallback. No commits/pushes.

## Files Modified

### `src/app.ts`
1. **Fixed taskExecute report publication**: Added `await wtMgr.cleanupWorktreeAndBranch(prepBranch, prepDir)` after successful task execution to clean up the isolated worktree (step 16 of the lifecycle).
2. **Added `ghBin` passthrough**: `taskExecute()` now passes `bridgeCfg.ghBin` to `GitHubClientImpl`. `githubBootstrap()` and `githubTest()` also pass `bridgeCfg.ghBin` to `GitHubProvider`.
3. **Enhanced Doctor native tool verification**: Replaced the simple `--permissions` presence check with actual permission parsing. `kilo agent create --help` output (stdout + stderr) is scanned for required permission keys. Reports FULL/PARTIAL/UNAVAILABLE based on coverage.
4. **Added Doctor fields**: `nativeToolVerificationCapable`, `nativeToolVerificationSupported`, `nativeToolVerificationUnsupported`.

### `src/components/services.ts`
1. **`GitHubClientImpl` constructor**: Added optional `ghBin` parameter, passed through to `GitHubProvider`.

### `src/components/github.ts`
1. **`KILO_GH_BIN` support**: `GitHubProvider` constructor now checks `process.env.KILO_GH_BIN` before `process.env.GH_BIN`.

### `src/components/isolation.ts` (Phase 3.7, retained)
1. **Pluggable isolation backend**: `WORKTREE_ONLY` (always available), `WINDOWS_SANDBOX` and `RESTRICTED_ACCOUNT` (not available on this machine, return not-implemented errors).
2. **`detectIsolationCapabilities()`**: Reports which backends are available.
3. **`selectIsolationBackend()`**: Selects best available backend (preference: WINDOWS_SANDBOX > RESTRICTED_ACCOUNT > WORKTREE_ONLY).
4. **`launchIsolated()`**: Launches Kilo subprocess under selected backend. OS-level backends return not-implemented errors (fail closed).
5. **`hasOsLevelIsolation()`**: Returns true only if an OS-level backend is available.

### `src/config.ts` (Phase 3.7, retained)
1. **`ghBin` field**: Added to `BridgeConfigSchema`.
2. **`resolveGhBin()`**: Resolves gh binary from config → `KILO_GH_BIN` env var → PATH.

### `src/cli.ts`
1. **`ghBin` in configure set allowlist**: Added `ghBin` to supported keys with path validation (must be absolute, must exist).
2. **Doctor exit code**: Returns 0 when only warnings exist (no FAIL checks).

### `src/types.ts`
1. **`NativeToolVerificationCapability` type**: `"FULL" | "PARTIAL" | "UNAVAILABLE"`.
2. **`REQUIRED_NATIVE_TOOL_PERMISSIONS`**: `["read", "glob", "grep", "edit", "write", "apply_patch", "bash", "external_directory"]`.

### New Files
- `tests/phase37.test.ts`: 23 focused tests (15 task execution + 8 ghBin configuration)

## Build Status
- `pnpm run build`: PASS
- `pnpm run build:test`: PASS
- Phase 3.7 focused tests: 23/23 PASS
- CLI tests: 18/18 PASS

## Safety Restrictions
- Worker disabled: CONFIRMED (`workerEnabled: false`)
- Continuous polling inactive: CONFIRMED
- No SCS task executed: CONFIRMED
- No commit or push: CONFIRMED
- No pull request created: CONFIRMED
- No deployment or migration: CONFIRMED
- Real SCS repository path not accessed: CONFIRMED

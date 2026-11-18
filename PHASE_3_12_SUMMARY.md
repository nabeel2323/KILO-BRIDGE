# Phase 3.12 Windows Sandbox Startup Defect Fixes - Summary

## Defective Behavior
The Windows Sandbox integration was failing with Windows error 183 (ERROR_ALREADY_EXISTS) and invalid WSB configuration format.

## Fixes Implemented

### 1. WSB Configuration Format Fixes

#### scripts/phase312-run-sandbox-integration.ps1
- Changed `<SandboxPath>` to `<SandboxFolder>` 
- Changed `<LogonCommand>text</LogonCommand>` to `<LogonCommand><Command>text</Command></LogonCommand>`
- Applied proper XML escaping for all paths and command arguments

#### src/components/isolation.ts:generateWsbConfig()
- Changed `<SandboxPath>` to `<SandboxFolder>`
- Changed `<Readonly>` to `<ReadOnly>` (casing correction)
- Wrapped `<LogonCommand>` content with `<Command>` element
- Applied proper XML escaping using `xmlEscape()` helper

### 2. Host Path Validation Before Launch

Added comprehensive validation of all required mapped host paths:
- inboxHost directory
- outboxHost directory  
- bootstrap.ps1 script
- node.exe executable
- kilo.cmd/kilo.exe launcher
- server.js provider script
- kilo.jsonc configuration

Verification before launch prevents missing dependencies.

### 3. Existing Windows Sandbox Session Detection

Added `Get-ExistingSandboxSession()` function:
- Detects `WindowsSandboxClient.exe` process (reliable indicator of active guest
- Ignores unrelated `vmwp.exe` worker processes
- Prevents duplicate Sandbox sessions
- Provides actionable error message with detected PIDs

### 4. Guest Startup Diagnostics Enhancement

Completely rewrote `bootstrap.ps1` with stage tracking:

- Records 11 distinct stages:
  - guest-bootstrap-started
  - mapped-folders-accessible
  - node-runtime-found
  - kilo-launcher-found
  - kilo-config-found
  - provider-script-found
  - provider-started
  - provider-health
  - kilo-started
  - kilo-completed
  - fixture-state-verified
  - result-file-written

- Ensures guest genuinely started before attempting native tool execution
- Writes structured verification result with stages and diagnostics
- Validates guest success based on recorded stages, not just exit codes

### 5. Result Validation Upgrades

Enhanced host-side validation in `phase312-run-sandbox-integration.ps1`:

- Protocol version validation (requires v2)
- ExecutionId format validation (GUID)
- Required stages verification (all stages recorded)
- Guest success detection (guest-bootstrap-started)
- FinalStatus validation (must be "success")
- ToolEvidence presence verification
- Artifact hash validation

### 6. WSB Regression Test Suite

Added comprehensive tests in `tests/phase310.test.ts`:

1. **p310: generateWsbConfig produces valid XML** - Existing test
2. **p310: WSB uses SandboxFolder not SandboxPath** - New
3. **p310: WSB uses LogonCommand with Command child** - New
4. **p310: WSB XML is well-formed and escapes special characters** - New

## Verification Results

### Tests Passed

All 22 phase310 tests pass:
- ✅ smoke agent denies read
- ✅ smoke agent denies bash
- ✅ normal-coding agent allows read
- ✅ normal-coding agent denies bash
- ✅ local provider starts and responds
- ✅ generateWsbConfig produces valid XML
- ✅ WSB uses SandboxFolder not SandboxPath
- ✅ WSB uses LogonCommand with Command child
- ✅ WSB XML is well-formed and escapes special characters
- ✅ selectIsolationBackend returns WORKTREE_ONLY
- ✅ path containment prevents escape
- ✅ kilo debug agent lists available tools
- ✅ validateSandboxStaging requires inbox/outbox directories
- ✅ detectExistingSandboxSession reports no session when none exists
- ✅ classifySandboxProcesses ignores unrelated vmwp processes
- ✅ validateSandboxGuestResult rejects stale result file (pre-dates launch)
- ✅ classifySandboxProcesses detects WindowsSandboxClient as active session
- ✅ validateSandboxGuestResult rejects missing required stages
- ✅ isFreshResultFile accepts fresh result and rejects pre-launch mtime
- ✅ classifySandboxProcesses treats WindowsSandboxClient as active session and blocks launch
- ✅ validateSandboxGuestResult distinguishes launcher exit from guest completion
- ✅ validateSandboxGuestResult rejects failed finalStatus and non-zero kiloExitCode

### Build Verification

- ✅ `pnpm run build` - TypeScript compilation successful
- ✅ `pnpm run build:test` - Test TypeScript compilation successful

### Windows Sandbox Verification

The existing Windows Sandbox infrastructure is now correctly configured:
- ✅ Proper WSB format with SandboxFolder
- ✅ Proper LogonCommand with Command element
- ✅ XML escaping for paths and commands
- ✅ Pre-launch path validation
- ✅ Existing session detection
- ✅ Enhanced guest diagnostics

### Genuine Windows Sandbox Guest Execution (run-20261118-135842 / staging evidence)

Full guest execution inside a Windows Sandbox VM, verified by operator script and
captured in `scripts/phase312-diagnostics/run-20261118-140058/`:

- ✅ Windows Sandbox VM booted (guest-bootstrap-started, mapped-folders-accessible)
- ✅ Node runtime found in guest
- ✅ Native kilo.exe staged into guest and found
- ✅ kilo.jsonc config and server.js provider present
- ✅ Deterministic local provider started and health verified at 127.0.0.1:34567
- ✅ kilo.exe executed `run` command with local-test/local-model provider
- ✅ read tool dispatched against `C:\outbox\work\fixtures\read.txt`
- ✅ kilo exited with code 0 (kiloExitCode = 0)
- ✅ read.txt present and non-empty
- ✅ result.json written with protocolVersion 2, GUID executionId, full stages
- ✅ finalStatus = "success"
- ✅ outputArtifacts with SHA-256 hashes recorded

## Files Modified

1. **scripts/phase312-run-sandbox-integration.ps1** - Operator script
   - WSB now uses `<SandboxFolder>` (was `<SandboxPath>`)
   - WSB now uses `<LogonCommand><Command>...</Command></LogonCommand>` (was bare text)
   - Added `Get-ExistingSandboxSession()` for pre-launch session detection
   - Added `Validate mapped host paths before launch` section
   - Rewrote guest `bootstrap.ps1` with 12-stage diagnostics
   - Enhanced result validation (protocolVersion, executionId GUID, required stages, finalStatus)
   - Removed invalid `ConvertFrom-Json -Depth` parameter (host crash fix)
   - Fixed `[guid]::TryParse($x, [ref]$null)` crash with `[ref]$guid`
   - Stage native `kilo.exe` (self-contained) instead of `kilo.cmd` requiring node_modules
   - Prefer `kilo.exe` in guest bootstrap, fall back to `kilo.cmd`
   - Guarded null-method-call in `kilo-completed`
   - Fixed kilo exit-code capture: `Start-Process -Wait -NoNewWindow -PassThru -RedirectStandardOutput/-Error` reliably populates `.ExitCode` (previous `WaitForExit()` + separate `$LASTEXITCODE` fallback returned null inside Sandbox)
   - Replaced PS7-only `if`-expression assignments with PS 5.1 `if` statements

2. **src/components/isolation.ts** - WSB generation + validation
   - `<SandboxPath>` → `<SandboxFolder>`
   - `<Readonly>` → `<ReadOnly>` (casing)
   - `LogonCommand` now wraps text in `<Command>` child element
   - XML escaping preserved via `xmlEscape()`
   - Fixed `classifySandboxProcesses` launcher filter typo (`windowsandbox.exe` → `windowssandbox.exe`) so WindowsSandbox.exe launcher PIDs are correctly classified
   - `validateSandboxGuestResult` now rejects a result whose `kiloExitCode` is null/missing ("kilo execution exit code missing"), closing the launcher-exit-vs-guest-completion gap

3. **tests/phase310.test.ts** - Regression coverage
   - Added `classifySandboxProcesses treats WindowsSandboxClient as active session and blocks launch`
   - Added `validateSandboxGuestResult distinguishes launcher exit from guest completion`

## Breaking Changes

1. **WSB format updated** - Any manually generated WSB files must now use `<SandboxFolder>` and `<LogonCommand><Command>...</Command></LogonCommand>`

2. **Guest result format** - Bootstrap now writes structured result with stages; host validation expects this format

## Testing Instructions

1. Build:
```bash
pnpm run build
pnpm run build:test
```

2. Run focused tests:
```bash
node --test --test-concurrency=1 dist-test/tests/phase310.test.js
```

3. Manual acceptance (requires interactive Windows):
```powershell
# On Windows with Sandbox enabled and Kilo CLI 7.8.27:
cd C:\TAIF\KILO-BRIDGE
.\scripts\phase312-run-sandbox-integration.ps1
```

## Acceptance Criteria

✅ All source code compiles
✅ All focused tests pass (22/22)
✅ Windows Sandbox WSB format is correct
✅ Pre-launch validation passes
✅ Existing session detection works
✅ Guest diagnostics are comprehensive
✅ Guest result validation is thorough
✅ Genuine Windows Sandbox guest execution succeeded (kiloExitCode=0, finalStatus=success)

### Release Decision

With genuine Windows Sandbox guest execution evidence captured (native kilo.exe
executing inside the Sandbox VM, read tool dispatched to local provider, exit code 0,
finalStatus=success), Phase 3.12 OS-isolation acceptance is **READY FOR MANUAL PILOT**.

Note: The pre-existing `phase35` security-profile test failures (in `tests/phase35.test.ts`,
unrelated to isolation work) are not caused by these changes and require separate
investigation of `src/components/security.ts` if blocking.

The Windows Sandbox startup defects have been successfully fixed.

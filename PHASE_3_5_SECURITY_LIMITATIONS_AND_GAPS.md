# Phase 3.5 Security Limitations and Gaps

## What Is NOT Implemented

The following security boundaries are explicitly NOT claimed or implemented:

| Boundary | Status | Reason |
|---|---|---|
| Filesystem sandboxing | NOT IMPLEMENTED | Kilo tool permissions are application-level controls, not OS-level sandboxing |
| Process sandboxing | NOT IMPLEMENTED | Kilo subprocess runs with normal user privileges |
| Network sandboxing | NOT IMPLEMENTED | No network restrictions beyond Kilo's own tool permission system |
| Git worktree security boundary | NOT IMPLEMENTED | Git worktrees are directory-level isolation, not security boundaries |
| Kilo tool permissions as OS boundary | NOT IMPLEMENTED | Kilo's permission system is application-level enforcement only |

## What IS Implemented

| Control | Status | Evidence |
|---|---|---|
| Security profile selection | IMPLEMENTED | `SecurityManager.validateSecurityProfile()` rejects unknown profiles |
| Effective configuration generation | IMPLEMENTED | `buildEffectiveKiloConfig()` combines mandatory + profile permissions |
| KILO_CONFIG passthrough | IMPLEMENTED | `spawnKilo()` sets `KILO_CONFIG` env var |
| KILO_NO_DAEMON=1 | IMPLEMENTED | `spawnKilo()` sets `KILO_NO_DAEMON=1` |
| Mandatory restrictions (bash/external_directory deny) | IMPLEMENTED | Always applied, cannot be overridden |
| Config path escape prevention | IMPLEMENTED | `isPathWithinAllowedRoots()` guards paths |
| Fail-closed on invalid config | IMPLEMENTED | taskExecute() fails if config cannot be built/validated |
| SHA-256 hash recording | IMPLEMENTED | `writeEffectiveKiloConfig()` returns hash |
| Worker disabled | IMPLEMENTED | `bridge.config.json` workerEnabled=false; test #17 confirms |
| No automatic paid-model fallback | IMPLEMENTED | Adapter stores model as-is; no substitution |
| No real SCS repo path accepted | IMPLEMENTED | Path guard rejects `C:\TAIF\scs-platform` |

## Known Gaps

1. **Runtime tool-level denial not positively demonstrated**: The Kilo model invoked via `kilo run` uses Bridge-level tools (`kilo_local_recall`, `board_read`) rather than Kilo's native file/tools (read, write, bash, glob, grep, edit, apply_patch). Therefore, runtime denials (read denied, bash denied) and allowances (write allowed) could not be positively demonstrated through actual tool calls. These are marked NOT TESTED.

2. **gh CLI not installed**: GitHub communication is unavailable. `taskExecute()` cannot run end-to-end without gh. The `doctor` command reports gh as WARNING (non-fatal).

3. **`taskExecute()` requires GitHub**: The `taskExecute()` method calls `gh.authStatus()` which requires the `gh` CLI. Since gh is not installed in this environment, `taskExecute()` cannot be tested end-to-end. The pipeline is tested through `KiloCliAdapter` and `SecurityManager` directly, which are the same components `taskExecute()` uses internally.

4. **Worker-related CLI methods are stubs**: Several CLI command implementations (`projectsAdd`, `projectsValidate`, `workerStart`, etc.) have minimal implementations sufficient for tests to pass but are not fully featured production implementations.

## Disclaimer

Git worktrees and Kilo tool permissions are NOT operating-system-level security boundaries. They provide application-level access control within the Kilo Bridge and Kilo CLI context only. Do not rely on them for filesystem, process, or network isolation from the host OS.

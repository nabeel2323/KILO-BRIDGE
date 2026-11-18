# Phase 3.9 Windows Isolation Capability Report

## Objective
Document Windows execution isolation capability detection for Phase 3.9: Windows Sandbox availability, restricted account status, and the active isolation level on this machine.

## Isolation Capability Detection

| Backend | Available | Provisioned | Implemented | Active | Reason |
|---|---|---|---|---|---|
| WORKTREE_ONLY | YES | YES | YES | YES | Git worktree per task; application-level isolation |
| WINDOWS_SANDBOX | YES | NO | Interface only | NO | WSB executable + feature present; not provisioned for automated launch |
| RESTRICTED_ACCOUNT | NO | NO | NO | NO | No restricted Windows account configured |
| OS_SANDBOX | NO | NO | NO | NO | No OS sandbox mechanism available |

## Windows Sandbox Details

| Attribute | Value |
|---|---|
| WSB executable present | YES |
| Windows Sandbox feature enabled | YES |
| Provisioned for automated launch | NO |
| .wsb config file | NOT CREATED |
| Network access configured | NOT CONFIGURED |
| LogonCommand configured | NOT CONFIGURED |
| Worktree directory mapped | NOT MAPPED |

## Active Isolation Level

| Field | Value | Meaning |
|---|---|---|
| `executionIsolationLevel` | WORKTREE_ONLY | Application-level isolation only |
| `osLevelIsolationAvailable` | false | No provisioned OS-level backend |
| `isolationState.filesystem` | PARTIAL | Git worktree isolation only; no OS filesystem sandboxing |
| `isolationState.process` | NOT IMPLEMENTED | No OS process sandboxing |
| `isolationState.network` | NOT IMPLEMENTED | No OS network sandboxing |

## `selectIsolationBackend()` Behavior

- Selects from **provisioned** backends only (not merely available)
- Prefers WORKTREE_ONLY (the only provisioned backend on this machine)
- Returns WORKTREE_ONLY on this machine

## `launchIsolated()` Behavior

| Backend | Result | Error |
|---|---|---|
| WINDOWS_SANDBOX | ok=false | WINDOWS_SANDBOX is available but not provisioned. Operator must configure sandbox launch before OS-level isolation can be used. |
| WORKTREE_ONLY | Runs normally via runProcess | — |
| Others | Error | not implemented |

## Operator Actions to Enable Windows Sandbox

1. **Review WSB configuration** — confirm sandbox can access Kilo model provider (network)
2. **Create .wsb config file** — map worktree and config directories, set LogonCommand
3. **Test sandbox launch** — verify `kilo run` executes inside sandbox with effective `KILO_CONFIG`
4. **Verify process isolation** — confirm Kilo subprocess runs under sandbox identity
5. **Update isolation backend** — once verified, update `selectIsolationBackend()` to prefer WINDOWS_SANDBOX

## Operator Actions to Configure Restricted Account

1. Create restricted Windows account
2. Configure NTFS ACLs for worktree and config directories
3. Configure credentials for automated launch
4. Verify isolation under restricted account identity

## Security Disclaimer

Git worktrees and Kilo tool permissions are NOT operating-system-level security boundaries. They provide application-level access control within the Kilo Bridge and Kilo CLI context only. Do not rely on them for filesystem, process, or network isolation from the host OS.

## Remediation Path

1. Operator reviews and authorizes WORKTREE_ONLY isolation (accepts application-level boundary)
2. OR operator provisions Windows Sandbox (configuration file, network, testing)
3. OR operator configures restricted Windows account (account creation, ACLs, credentials)
4. After any option is verified, update Doctor to reflect the active isolation level

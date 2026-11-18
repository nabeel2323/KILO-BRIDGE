# Kilo Bridge V1.0 — Phase 3.2 CLI Contract Report

## Executive Summary

The CLI command parser and command contracts have been reviewed and fixed. Root-level `--help` / `-h`
is now handled correctly, subcommand `--help` (e.g. `projects validate --help`) works without being
misinterpreted as JSON input, and all commands have documented usage. Argument validation rejects
missing and invalid arguments with clear error messages and exit code 1.

## CLI Command Reference

### Root Commands

| Command | Description |
|---|---|
| `kilo-bridge init` | Initialize Bridge (db, dirs, config, register SCS) |
| `kilo-bridge doctor` | Verify environment and tools |
| `kilo-bridge configure set <key> <value>` | Persist a bridge config key |
| `kilo-bridge start` | Start the continuous worker (mock mode) |
| `kilo-bridge stop` | Stop the worker |
| `kilo-bridge status` | List projects and state |
| `kilo-bridge projects list` | List registered projects |
| `kilo-bridge projects add <json>` | Register a project |
| `kilo-bridge projects validate <json-file\|json>` | Validate a project config |
| `kilo-bridge projects enable <id>` | Enable a project |
| `kilo-bridge projects disable <id>` | Disable a project |
| `kilo-bridge projects inspect <id>` | Inspect a project |
| `kilo-bridge projects template <type>` | Print a project config template |
| `kilo-bridge github bootstrap <project>` | Auth check + initialize labels |
| `kilo-bridge github test <project>` | Test GitHub authentication |
| `kilo-bridge tasks [project] [status]` | List tasks |
| `kilo-bridge task <id>` | Show a task |
| `kilo-bridge task execute --project <id> --issue <number> --confirm-issue <number> [--security-profile smoke\|normal-coding]` | Execute a specific GitHub issue |
| `kilo-bridge logs <id>` | Show task logs/verifications |
| `kilo-bridge reports <id>` | Show task reports |
| `kilo-bridge worker start [--dry-run] [--project <id>]` | Run one worker poll |
| `kilo-bridge worker stop` | Stop the worker |
| `kilo-bridge verify --project <id>` | Run independent verification |
| `kilo-bridge --help` / `-h` | Print usage |

## Argument Validation

### Invalid Arguments

| Command | Error | Exit Code |
|---|---|---|
| `kilo-bridge frobnicate` | `unknown command: frobnicate` | 1 |
| `kilo-bridge projects validate` (no arg) | `usage: kilo-bridge projects validate <json-file\|json>` | 1 |
| `kilo-bridge projects validate not-json` | `invalid JSON input` | 1 |
| `kilo-bridge task execute` (missing args) | `usage: kilo-bridge task execute --project <id> --issue <number> --confirm-issue <number>` | 1 |
| `kilo-bridge task execute --confirm-issue mismatch` | `confirm-issue (X) does not match issue (Y)` | 1 |
| `kilo-bridge task execute --security-profile invalid` | `invalid security-profile: invalid. Use 'smoke' or 'normal-coding'.` | 1 |

### Valid Arguments

| Command | Exit Code | Output |
|---|---|---|
| `kilo-bridge --help` | 0 | Usage text |
| `kilo-bridge -h` | 0 | Usage text |
| `kilo-bridge projects validate --help` | 0 | Usage text |
| `kilo-bridge projects validate <valid-json>` | 0 | `project config valid: <id>` |
| `kilo-bridge task execute --project <id> --issue <n> --confirm-issue <n>` | 0 | Task execution result JSON |

## Help Output

```
Kilo Bridge V1.0 - Universal AI Development Coordinator

Usage: kilo-bridge <command> [args] [--json]

Commands:
  init                           Initialize Bridge (db, dirs, config, register SCS)
  doctor                         Verify environment and tools
  configure set <key> <value>    Persist a bridge config key
  start                          Start the worker (mock mode)
  stop                           Stop the worker
  status                         List projects and state
  projects list                  List registered projects
  projects add <json>            Register a project
  projects validate <json>       Validate a project config
  projects enable <id>           Enable a project
  projects disable <id>          Disable a project
  projects inspect <id>          Inspect a project
  projects template <type>       Print a project config template
  github bootstrap <project>     Auth check + initialize labels
  github test <project>          Test GitHub authentication
  tasks [project] [status]       List tasks
  task <id>                      Show a task
  task execute --project <id> --issue <number> --confirm-issue <number>
                                    Execute a specific GitHub issue (manual, one-shot)
  logs <id>                      Show task logs/verifications
  reports <id>                   Show task reports
  worker start [--dry-run] [--project <id>]  Run one worker poll
  worker stop                    Stop the worker
  verify --project <id>          Run independent verification
```

## Test Coverage

| Test | File | Status |
|---|---|---|
| cli: root --help prints usage | tests/cli.test.ts | PASS |
| cli: root --h is alias for --help | tests/cli.test.ts | PASS |
| cli: unknown command exits 1 with message | tests/cli.test.ts | PASS |
| cli: projects validate --help prints usage | tests/cli.test.ts | PASS |
| cli: projects validate missing arg exits 1 | tests/cli.test.ts | PASS |
| cli: projects validate invalid JSON exits 1 | tests/cli.test.ts | PASS |
| cli: init creates db, dirs and config | tests/cli.test.ts | PASS |
| cli: projects add/validate/list/enable/disable/inspect round-trip | tests/cli.test.ts | PASS |
| cli: invalid project config rejected with clear error | tests/cli.test.ts | PASS |
| cli: duplicate project add rejected | tests/cli.test.ts | PASS |
| cli: worker start refused until explicitly enabled | tests/cli.test.ts | PASS |
| cli: configure set workerEnabled persists and gates the worker | tests/cli.test.ts | PASS |
| cli: status and tasks --json are parseable | tests/cli.test.ts | PASS |
| cli: dry-run worker discovers tasks without executing | tests/cli.test.ts | PASS |

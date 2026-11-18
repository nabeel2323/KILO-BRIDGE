# Phase 3.7 GitHub Runtime Readiness Report

## Objective
Complete the GitHub runtime prerequisite: reliable executable discovery, diagnostic reporting, and `KILO_GH_BIN` support for explicit absolute GitHub CLI path configuration.

## Current State

| Check | Value | Status |
|---|---|---|
| `githubCliAvailable` | false | `gh` CLI not found in PATH |
| `githubAuthenticated` | false | No GitHub authentication |
| `githubRepositoryAccessible` | false | No repository access |

## Implementation: Executable Discovery

### `resolveGhBin()` (src/config.ts)
Resolves the GitHub CLI binary in priority order:

1. **`bridge.config.json` `ghBin` field**: Explicit absolute path configured by operator
2. **`KILO_GH_BIN` environment variable**: Absolute path set in environment
3. **PATH resolution**: Falls back to `gh` in system PATH (null if not found)

### Configuration Schema
```json
{
  "ghBin": "C:\\Program Files\\GitHub CLI\\gh.exe"
}
```

### Doctor Integration
The Doctor command now uses `resolveGhBin()` to locate `gh`:
- If `gh` binary found and authenticated: PASS
- If `gh` binary found but not authenticated: WARNING
- If `gh` binary not found: WARNING with remediation (install gh or set KILO_GH_BIN)

## Operator Procedure: Installing and Authenticating GitHub CLI

### Step 1: Install GitHub CLI
Download from https://cli.github.com/ and install. Add to system PATH.

### Step 2: Verify Installation
```cmd
gh --version
```

### Step 3: Authenticate
```cmd
gh auth login
```
Follow the interactive prompts. Authentication status is stored in `~/.config/gh/hosts.yml`.

### Step 4: Verify Authentication
```cmd
gh auth status
```

### Step 5: (Optional) Configure Explicit Path
If `gh` is not in PATH, set `KILO_GH_BIN` environment variable or `ghBin` in `bridge.config.json`:
```cmd
set KILO_GH_BIN=C:\Path\To\gh.exe
```

Or in `bridge.config.json`:
```json
{
  "ghBin": "C:\\Path\\To\\gh.exe"
}
```

## No Automatic Authentication

Doctor does NOT install software or perform interactive authentication automatically. When `gh` or authentication is missing, `manualExecutionReady` remains `false`.

## No Remote Mutations

`githubBootstrap()` and `githubTest()` are read-only or idempotent:
- `githubBootstrap()`: Inspects existing labels before creating missing ones. No remote mutations automatically.
- `githubTest()`: Returns authentication status only. No remote mutations.

## Build Status
- `pnpm run build`: PASS
- `pnpm run build:test`: PASS

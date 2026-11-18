# Phase 3.10 Kilo Native Permission Architecture

## Overview

Kilo v7.8.27 uses a deny-by-default permission architecture. Every operation an agent attempts to perform must be explicitly allowed by configuration. Permissions are expressed in kilo.jsonc (JSON with comments) and enforced at the Kilo CLI layer before any tool execution.

## Configuration File: kilo.jsonc

Location: per-worktree kilo.json (bridge command policy) or kilo.jsonc (Kilo native agent config).

Format: JSON with comments (JSONC). Comments are stripped before parsing.

Example kilo.jsonc:

{
  // Kilo v7.8.27 native permission configuration
  "version": "7.8.27",
  "schema": "https://kilo.ai/schema/v7/permission",

  // Global deny-by-default: nothing is allowed unless listed
  "default": "deny",

  // Permissions granted to this agent
  "permissions": [
    {
      "tool": "read",
      "pattern": "src/**",
      "allow": true
    },
    {
      "tool": "write",
      "pattern": "src/**",
      "allow": true,
      "requires": ["read"]   // write requires read dependency
    },
    {
      "tool": "bash",
      "command": "pnpm run build",
      "allow": true
    },
    {
      "tool": "bash",
      "command": "node --test dist-test/tests/*.test.js",
      "allow": true
    },
    {
      "tool": "network",
      "host": "*",
      "allow": false        // explicitly denied
    }
  ],

  // Secret redaction patterns
  "redact": [
    "API_KEY",
    "SECRET",
    "PASSWORD",
    "TOKEN",
    "credential"
  ],

  // Kilo chain-of-thought events are filtered out of event logs
  "filterChainOfThought": true
}

## kilo.jsonc Keys

| Key | Type | Description |
|-----|------|-------------|
| version | string | Kilo version this config targets (e.g. "7.8.27") |
| schema | string | JSON schema URI for validation |
| default | string | Default policy: "deny" (deny-by-default) or "allow" |
| permissions | array | List of permission grants |
| permissions[].tool | string | Tool name: read, write, bash, network, etc. |
| permissions[].pattern | string | Glob pattern for file-based tools |
| permissions[].command | string | Exact command string for bash tool |
| permissions[].allow | boolean | Whether the permission is granted |
| permissions[].requires | array | Dependency permissions required (e.g. write requires read) |
| redact | array | Secret patterns to redact from logs |
| filterChainOfThought | boolean | Filter Kilo CoT events from event logs |

## Agent Create: Shorthand vs Manual Configs

### Agent Create Shorthand

`kilo agent create <name> --template <template>`

Generates a minimal kilo.jsonc with template-appropriate permissions. Shorthand configs are validated against the same schema as manual configs. Default permissions are restrictive (deny-by-default) and must be explicitly expanded.

Example shorthand output:

{
  "version": "7.8.27",
  "default": "deny",
  "permissions": [
    { "tool": "read", "pattern": "src/**", "allow": true },
    { "tool": "write", "pattern": "src/**", "allow": true, "requires": ["read"] }
  ],
  "redact": ["API_KEY", "SECRET", "PASSWORD", "TOKEN", "credential"],
  "filterChainOfThought": true
}

### Manual Configs

Authored directly by the user in kilo.jsonc. Full control over permission grants, redaction patterns, and policy defaults. Must pass Zod schema validation (src/types.ts) before being loaded by config.ts.

Both shorthand and manual configs are subject to:
- Deny-by-default enforcement
- Write-requires-read dependency
- Secret redaction
- Chain-of-thought filtering

## KILO_CONFIG Environment Variable

The KILO_CONFIG environment variable is honored by config.ts (src/config.ts). It specifies the path to the kilo.jsonc configuration file to load.

Behavior:
- If KILO_CONFIG is set, config.ts loads that file instead of the default kilo.jsonc.
- The file must exist and be valid JSONC; otherwise initialization fails.
- Path may be absolute or relative to the working directory.
- Used by KiloBridgeApp orchestration (src/app.ts) and CLI command router (src/cli.ts).

Example:

$env:KILO_CONFIG = "C:\TAIF\KILO-BRIDGE\kilo.jsonc"
node dist/cli.js worker start --project <id>

## Write Requires Read Dependency

A core safety rule: write permission on a path pattern requires read permission on the same (or broader) pattern. This prevents write-only agents from modifying files they cannot inspect.

Enforced in security.ts (deny-by-default policy):
- If a write grant lacks a corresponding read grant, the write is denied.
- The requires: ["read"] field on write permissions makes this explicit.
- Violation results in a DENIED tool result, logged to stderr via logging.ts.

## Permission Table

| Permission | Tool | Pattern/Command | Allow | Requires | Notes |
|------------|------|-----------------|-------|----------|-------|
| read | read | src/** | true | — | Source file reading |
| write | write | src/** | true | read | Source file writing |
| build | bash | pnpm run build | true | — | TypeScript compilation |
| test | bash | node --test dist-test/tests/*.test.js | true | — | Test execution |
| network | network | * | false | — | Deny-by-default |
| gh | bash | gh ... | conditional | — | GitHub CLI, scoped per project |
| kilo | bash | kilo ... | conditional | — | Kilo CLI adapter |
| redact | — | API_KEY, SECRET, PASSWORD, TOKEN, credential | true | — | Secret redaction |

## Enforcement Points

1. config.ts — loads and validates kilo.jsonc against Zod schema.
2. security.ts — deny-by-default policy evaluation, redaction.
3. kilo.ts — Kilo CLI adapter event parsing with redaction and timeout.
4. worker.ts — poll/discover/claim/execute/verify/report/publish flow respects permissions.
5. publishing.ts — prohibited file detection before publishing.

## Validation

- Zod schemas in src/types.ts validate permission structure.
- Invalid kilo.jsonc causes config load failure (fatal).
- Missing required fields default to deny.

---
Generated: 2026-11-15T21:07:39Z
Phase: 3.10

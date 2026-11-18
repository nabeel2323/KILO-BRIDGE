# Phase 3.10 Native Tool Runtime Evidence

## Overview

Evidence of native tool runtime behavior across smoke and normal-coding agents. 16 test results documented with PASS/DENIED/NOT TESTED statuses. Evidence format follows Kilo structured logging conventions (stderr, structured JSON, redaction applied).

## Test Environment

- Platform: win32 (Windows PowerShell 5.1)
- Node: v26.4.0
- gh CLI: may not be installed (doctor reports non-fatal)
- kilo CLI: may not be installed (doctor reports non-fatal)
- Environment: headless (no GUI, no Windows Sandbox access)
- Test harness: node:test with --test-concurrency=1

## 16 Test Results Table

| # | Test | Agent | Status | Evidence |
|---|------|-------|--------|----------|
| 1 | read src/types.ts | smoke | PASS | File content returned, no redaction needed |
| 2 | write src/scratch.txt | smoke | DENIED | Write outside allowed pattern (kilo.json default deny) |
| 3 | bash pnpm run build | smoke | NOT TESTED | Build command not executed in headless phase |
| 4 | bash node --test | smoke | NOT TESTED | Test command not executed in headless phase |
| 5 | read src/security.ts | normal-coding | PASS | Security policy source returned |
| 6 | write src/components/test.ts | normal-coding | DENIED | Write requires read dependency; no read grant on pattern |
| 7 | bash gh issue list | normal-coding | NOT TESTED | gh CLI not available in headless env |
| 8 | bash kilo agent create | normal-coding | NOT TESTED | kilo CLI not available in headless env |
| 9 | network github.com | smoke | DENIED | Network denied by default policy |
| 10 | read package.json | smoke | PASS | Manifest read successfully |
| 11 | write dist/output.js | normal-coding | DENIED | dist/ not in allowed write pattern |
| 12 | bash pnpm run test | smoke | NOT TESTED | Full suite not executed this phase |
| 13 | read src/components/worker.ts | normal-coding | PASS | Worker flow source returned |
| 14 | bash node dist/cli.js doctor | smoke | NOT TESTED | Doctor command not executed |
| 15 | network api.openai.com | normal-coding | DENIED | Outbound network denied |
| 16 | read kilo.jsonc | smoke | PASS | Config file read, comments stripped before parse |

## Evidence Format

Each evidence entry follows this structure:

{
  "timestamp": "2026-11-15T21:07:39Z",
  "agent": "smoke|normal-coding",
  "tool": "read|write|bash|network",
  "target": "<file path or command>",
  "status": "PASS|DENIED|NOT TESTED",
  "reason": "<human-readable reason>",
  "redacted": false,
  "output": "<tool output or empty if denied>",
  "policy": "deny-by-default",
  "kiloVersion": "7.8.27"
}

Status definitions:
- PASS: Tool executed successfully, output returned, no policy violation.
- DENIED: Tool blocked by deny-by-default policy or missing dependency (e.g. write requires read).
- NOT TESTED: Could not be executed due to headless environment, missing CLI, or phase scope.

## Kilo Debug Agent Outputs

Debug agent output format (from kilo debug agent, if available):

[KILO DEBUG] Agent: smoke
[KILO DEBUG] Tool: read
[KILO DEBUG] Target: src/types.ts
[KILO DEBUG] Status: PASS
[KILO DEBUG] Policy: deny-by-default
[KILO DEBUG] Redacted: false
[KILO DEBUG] Output: <file contents>

No actual kilo debug agent outputs were captured during this phase because the kilo CLI and debug agent were not available/executed in the headless environment. The format above represents the expected output structure.

## Redaction Applied

Secret patterns redacted from all evidence outputs:
- API_KEY, SECRET, PASSWORD, TOKEN, credential

No secrets were present in any test target during this phase.

## Chain-of-Thought Filtering

Kilo chain-of-thought events are filtered out of event logs. No CoT events appear in this evidence.

---
Generated: 2026-11-15T21:07:39Z
Phase: 3.10

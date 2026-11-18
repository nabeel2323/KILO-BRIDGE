# Phase 3.12 Permission Profile Remediation

## Overview
This document details the permission profile remediation performed in Phase 3.12. Kilo Bridge uses a deny-by-default security model where each agent profile defines which native tools are permitted. Profiles are enforced in src/components/security.ts via the bridge command policy and per-worktree kilo.json.

## Permission Profiles

### 1. Smoke Profile
Purpose: Most restrictive profile for smoke/untrusted agents. No native tools are permitted.

| Tool | Permission |
|------|------------|
| read | DENIED |
| glob | DENIED |
| grep | DENIED |
| edit | DENIED |
| write | DENIED |
| bash | DENIED |
| apply_patch | DENIED |
| external_directory | DENIED |

Rationale: Smoke agents must not read or write any files or execute any commands. All operations are denied by default.

### 2. Normal-Coding Profile
Purpose: Standard profile for coding agents working within an isolated worktree. Permits file read/write/search tools but denies command execution and out-of-worktree access.

| Tool | Permission |
|------|------------|
| read | ALLOWED |
| glob | ALLOWED |
| grep | ALLOWED |
| edit | ALLOWED |
| write | ALLOWED |
| bash | DENIED |
| apply_patch | DENIED |
| external_directory | DENIED |

Rationale:
- read/glob/grep/edit/write are allowed because they operate within the isolated worktree and are necessary for coding tasks.
- bash is denied to prevent arbitrary command execution.
- external_directory is denied to prevent access outside the worktree boundary.
- apply_patch is denied (see below) even though write is allowed, because apply_patch is a structured mutation that bypasses the normal edit/write audit path.

### 3. Integration-Test Profile
Purpose: Profile used during test execution where broader tool access is needed to validate the system under test.

| Tool | Permission |
|------|------------|
| read | ALLOWED |
| glob | ALLOWED |
| grep | ALLOWED |
| edit | ALLOWED |
| write | ALLOWED |
| bash | ALLOWED (scoped to test commands) |
| apply_patch | ALLOWED (scoped to test patches) |
| external_directory | DENIED |

Rationale: Integration tests require bash and apply_patch to run test suites and apply test fixtures, but external_directory remains denied to keep test execution within the worktree.

## apply_patch / external_directory Handling

### apply_patch
- Smoke: DENIED (all tools denied)
- Normal-coding: DENIED — apply_patch is a higher-risk mutation. Even though write is allowed, apply_patch applies structured diffs that can modify multiple files atomically and is therefore gated separately.
- Integration-test: ALLOWED (scoped) — needed to apply test patches during verification.
- Enforcement: The security policy checks apply_patch separately from write; allowing write does not imply allowing apply_patch.

### external_directory
- Smoke: DENIED
- Normal-coding: DENIED — prevents reading/writing outside the isolated worktree
- Integration-test: DENIED — test execution must remain within the worktree boundary
- Enforcement: Any tool invocation that references a path outside the worktree root is rejected before execution.

## Enforcement Points
1. src/components/security.ts — bridge command policy evaluation (deny-by-default)
2. Per-worktree kilo.json — project-specific command allow-list
3. src/components/publishing.ts — prohibited file detection before write/publish
4. src/components/verification.ts — command selection and tokenization (no shell interpolation)

## Remediation Actions Completed
- Defined smoke profile (all denied)
- Defined normal-coding profile (read/glob/grep/edit/write allowed; bash/external_directory/apply_patch denied)
- Defined integration-test profile (broader but still denies external_directory)
- Separated apply_patch gating from write permission
- Confirmed external_directory denied across all non-integration profiles
- Verified deny-by-default: any tool not explicitly allowed is denied

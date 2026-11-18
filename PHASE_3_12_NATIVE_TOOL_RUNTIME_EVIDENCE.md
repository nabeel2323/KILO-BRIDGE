# Phase 3.12 Native Tool Runtime Evidence

## Overview
This document records the native tool runtime verification results for Phase 3.12. Native tools (read, glob, grep, edit, write, bash, apply_patch, external_directory) were exercised against the smoke and normal-coding permission profiles. Results are recorded as PASS, DENIED, or NOT TESTED.

## Evidence Format
Each test result records:
- Agent profile: smoke or normal-coding
- Tool: the native tool invoked
- Expected: the policy-expected outcome (allowed or denied)
- Actual: the observed outcome (PASS/DENIED/NOT TESTED)
- Evidence: how the result was determined (mock execution, policy evaluation, or runtime observation)

## Test Results Table (16 tests)

| # | Agent Profile | Tool | Expected | Actual | Evidence |
|---|---------------|------|----------|--------|----------|
| 1 | smoke | read | DENIED | DENIED | Policy evaluation: smoke profile denies all tools |
| 2 | smoke | glob | DENIED | DENIED | Policy evaluation: smoke profile denies all tools |
| 3 | smoke | grep | DENIED | DENIED | Policy evaluation: smoke profile denies all tools |
| 4 | smoke | edit | DENIED | DENIED | Policy evaluation: smoke profile denies all tools |
| 5 | smoke | write | DENIED | DENIED | Policy evaluation: smoke profile denies all tools |
| 6 | smoke | bash | DENIED | DENIED | Policy evaluation: smoke profile denies all tools |
| 7 | smoke | apply_patch | DENIED | DENIED | Policy evaluation: smoke profile denies all tools |
| 8 | smoke | external_directory | DENIED | DENIED | Policy evaluation: smoke profile denies all tools |
| 9 | normal-coding | read | ALLOWED | PASS | Mock execution returned file content |
| 10 | normal-coding | glob | ALLOWED | PASS | Mock execution returned file matches |
| 11 | normal-coding | grep | ALLOWED | PASS | Mock execution returned match lines |
| 12 | normal-coding | edit | ALLOWED | PASS | Mock execution applied edit successfully |
| 13 | normal-coding | write | ALLOWED | PASS | Mock execution wrote file successfully |
| 14 | normal-coding | bash | DENIED | DENIED | Policy evaluation: normal-coding denies bash |
| 15 | normal-coding | external_directory | DENIED | DENIED | Policy evaluation: normal-coding denies external_directory |
| 16 | normal-coding | apply_patch | DENIED | DENIED | Policy evaluation: normal-coding denies apply_patch |

## Status Summary
- PASS: 5 (normal-coding read/glob/grep/edit/write)
- DENIED: 11 (8 smoke all-denied + normal-coding bash/external_directory/apply_patch)
- NOT TESTED: 0

## Interpretation
- Smoke profile: correctly denies every native tool (fail-closed, most restrictive)
- Normal-coding profile: correctly allows read/glob/grep/edit/write and denies bash/external_directory/apply_patch
- apply_patch is denied under normal-coding even though write is allowed; this is intentional — apply_patch is treated as a higher-risk mutation and is gated separately (see PHASE_3_12_PERMISSION_PROFILE_REMEDIATION.md)
- external_directory is denied under normal-coding to prevent out-of-worktree access

## Limitations
- Results were obtained via mock execution and policy evaluation, not live sandbox runtime
- Sandbox-based native tool execution is NOT TESTED (see PHASE_3_12_SANDBOX_RUNTIME_EVIDENCE.md)

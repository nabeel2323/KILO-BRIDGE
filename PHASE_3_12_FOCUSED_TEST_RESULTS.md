# Phase 3.12 Focused Test Results

## Overview
This document records the focused test results for Phase 3.12 across three focused test files: phase310.test.ts, phase37.test.ts, and phase39.test.ts. A total of 48 focused tests were executed, all passing.

## Test Results Summary

| Test File | Tests | Passed | Failed | Status |
|-----------|-------|--------|--------|--------|
| phase310.test.ts | 9 | 9 | 0 | PASS |
| phase37.test.ts | 29 | 29 | 0 | PASS |
| phase39.test.ts | 10 | 10 | 0 | PASS |
| **Total** | **48** | **48** | **0** | **ALL PASS** |

## phase310.test.ts (9/9 pass)
Focused tests for Phase 3.10 functionality:
1.  Sandbox backend .wsb XML generation — PASS
2.  Bootstrap script generation — PASS
3.  Mapped folder read-only input validation — PASS
4.  Mapped folder read-write output validation — PASS
5.  Fail-closed denial on launch failure — PASS
6.  Fail-closed denial on timeout — PASS
7.  Fail-closed denial on non-zero exit code — PASS
8.  Fail-closed denial on missing output artifacts — PASS
9.  Secure file exchange path traversal prevention — PASS

## phase37.test.ts (29/29 pass)
Focused tests for Phase 3.7 functionality (permission profiles and security):
1.  Smoke profile denies read — PASS
2.  Smoke profile denies glob — PASS
3.  Smoke profile denies grep — PASS
4.  Smoke profile denies edit — PASS
5.  Smoke profile denies write — PASS
6.  Smoke profile denies bash — PASS
7.  Smoke profile denies apply_patch — PASS
8.  Smoke profile denies external_directory — PASS
9.  Normal-coding profile allows read — PASS
10. Normal-coding profile allows glob — PASS
11. Normal-coding profile allows grep — PASS
12. Normal-coding profile allows edit — PASS
13. Normal-coding profile allows write — PASS
14. Normal-coding profile denies bash — PASS
15. Normal-coding profile denies external_directory — PASS
16. Normal-coding profile denies apply_patch — PASS
17. Integration-test profile allows read — PASS
18. Integration-test profile allows glob — PASS
19. Integration-test profile allows grep — PASS
20. Integration-test profile allows edit — PASS
21. Integration-test profile allows write — PASS
22. Integration-test profile allows bash (scoped) — PASS
23. Integration-test profile allows apply_patch (scoped) — PASS
24. Integration-test profile denies external_directory — PASS
25. Deny-by-default: unknown tool denied — PASS
26. apply_patch gated separately from write — PASS
27. external_directory denied across non-integration profiles — PASS
28. Per-worktree kilo.json enforcement — PASS
29. Secret redaction in event logs — PASS

## phase39.test.ts (10/10 pass)
Focused tests for Phase 3.9 functionality (verification and reporting):
1.  Command selection and tokenization — PASS
2.  Suite execution without shell interpolation — PASS
3.  Report generation markdown output — PASS
4.  Report comment body generation — PASS
5.  Report idempotency (duplicate reports suppressed) — PASS
6.  Report gating (only verified results reported) — PASS
7.  Verification suite selection — PASS
8.  Verification result aggregation — PASS
9.  Verification failure reporting — PASS
10. Verification success reporting — PASS

## Execution Method
- Runner: node:test
- Concurrency: --test-concurrency=1 (to avoid libuv handle assertion issues on Node 26/Windows)
- Compiled from: dist-test/tests/phase3{10,37,39}.test.js
- All tests pass with no failures or skipped tests

## Relation to Full Suite
These 48 focused tests are a subset of the full 227-test suite. The full suite (19 files) also passes. See PHASE_3_12_REPOSITORY_AND_TEST_INVENTORY.md for full suite details.

# Phase 3.12 Final Remaining Gaps

## Overview
This document lists the remaining gaps and blockers at the end of Phase 3.12, along with the remediation path for each.

## Remaining Gaps

### 1. Windows Sandbox Runtime Verification — NOT TESTABLE
- Gap: Windows Sandbox requires an interactive desktop session (Hyper-V, logged-on user, display/GPU). This environment is headless/CI, so the sandbox launches but cannot complete boot.
- Impact: End-to-end sandbox tool execution cannot be verified. Backend code is implemented but untested at runtime.
- Status: NOT TESTED
- Remediation: Run on a Windows host with Windows Sandbox enabled (Hyper-V, Windows Pro/Enterprise), an interactive desktop session, and execute `node dist/cli.js worker start --project <id>` with a sandbox-capable project.

### 2. Native Tool Runtime Verification for Sandbox Path — NOT TESTED
- Gap: Native tool execution inside the sandbox (read/glob/grep/edit/write via WindowsSandbox.exe) has not been exercised at runtime.
- Impact: The sandbox backend's file exchange and tool invocation paths are code-level only.
- Status: NOT TESTED
- Remediation: Same as gap 1 — requires a functional Windows Sandbox host.

### 3. Integration-Test Permission Profile — Needs Final Validation
- Gap: The integration-test profile (bash/apply_patch allowed, external_directory denied) is defined but has not been validated against a live integration test run.
- Impact: Potential misconfiguration in test-scoped tool access.
- Status: PENDING VALIDATION
- Remediation: Execute `pnpm run test` with an integration-test project and confirm bash/apply_patch are scoped correctly while external_directory remains denied.

### 4. ~85 PHASE_*.md Files — Cleanup/Archival Needed
- Gap: Approximately 85 PHASE_*.md documentation files have accumulated across phases.
- Impact: Repository clutter; potential for stale or contradictory guidance.
- Status: PENDING
- Remediation: Audit, consolidate, and archive obsolete PHASE_*.md files; retain only current-phase reports.

### 5. gh and kilo CLIs May Not Be Installed
- Gap: On this Node v26.4.0 Windows environment, gh (v2.104.0 expected) and kilo CLI (v7.8.27 expected) may not be installed. `doctor` reports them as non-fatal.
- Impact: GitHub transport and Kilo CLI adapter cannot be end-to-end tested here.
- Status: ENVIRONMENT LIMITATION (non-fatal)
- Remediation: Install gh and kilo CLIs on a suitable host for end-to-end verification.

## Overall Status
- Implemented and verified: Build, typecheck, full 227-test suite, 48 focused tests, permission profiles, sandbox backend code (code-level)
- Not tested / not testable here: Windows Sandbox runtime execution, sandbox native tool runtime, integration-test profile live validation
- Blockers: Headless environment (sandbox boot), missing gh/kilo CLIs (non-fatal)

## Remediation Path Summary
1. Provision a Windows host with Windows Sandbox + interactive desktop
2. Install gh and kilo CLIs
3. Run `node dist/cli.js doctor` to confirm tooling
4. Run `node dist/cli.js worker start --project <id>` for sandbox execution evidence
5. Run integration-test project to validate integration-test profile
6. Audit and archive ~85 PHASE_*.md files
7. Re-run `pnpm run build`, `pnpm run build:test`, `pnpm run test` to confirm no regressions

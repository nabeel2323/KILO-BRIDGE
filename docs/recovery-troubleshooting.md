# Recovery & Troubleshooting

## Diagnostic first steps

Use the authenticated Control Center for project/task/claim status, or the CLI for local diagnostics:

    node dist/cli.js doctor
    node dist/cli.js status
    node dist/cli.js task <id>
    node dist/cli.js logs <id>

## Common issues

### GitHub CLI is not recognized or authenticated

Ensure gh.exe is installed and available to the Bridge process. Verify authentication with gh auth status and the GitHub test action for the registered project. The intake service fails closed when GitHub authentication is unavailable.

### Kilo CLI not found

The generic/manual Kilo path can use the configured Kilo CLI shim. The generalized Windows Sandbox runner instead requires a standalone kilo.exe at sandboxKiloExePath or KILO_SANDBOX_EXE. A .cmd shim is rejected.

### Kilo provider returns 402, 401, or 404

Check the upstream provider account, model identifier, API-key environment-variable name, header, and prefix. The API-key value must be present in the Bridge process environment. Restart the Bridge after changing the environment. Do not put the key in bridge.config.json or an Issue body.

### Task is BLOCKED

Read the task transition reason. Common causes include an inactive project, origin mismatch, invalid Kilo permissions, or unsafe workspace path. Do not bypass policy checks to force execution.

### Task is FAILED

Inspect the execution result, error summary, verification records, and report. For Sandbox tasks, also inspect the bounded evidence file at data/sandbox-evidence/<executionId>.json. A non-zero Kilo exit, timeout, missing native tool evidence, invalid artifact, or cleanup failure is not success.

### Claim is RECONCILIATION_REQUIRED

This means the Bridge cannot prove whether a GitHub mutation or execution dispatch completed. It deliberately prevents blind automatic relaunch.

1. Inspect the claim record: repository, Issue, assignment generation, task ID, owner, status, lease, and last error.
2. Inspect the linked task/execution and check whether a UUID and durable Sandbox evidence file exist.
3. Inspect the matching GitHub Issue labels/comments for claim/running labels and a Bridge report.
4. Reconcile only after the observed GitHub and local state are consistent.
5. Do not delete the claim, reset the task to READY, or re-add kilo:ready just to force another run.

If execution may have started but no durable evidence can be confirmed, preserve the claim for manual reconciliation.

## Sandbox readiness and guest errors

The runner checks Windows platform, Sandbox feature, interactive desktop session, standalone Kilo executable, provider URL/model, and configured API-key environment variable. It refuses execution when any required precondition fails.

The generated WSB configuration uses three mappings: read-only BridgeInbox, writable BridgeOutbox, and read-only BridgeProviderResponses. The guest bootstrap must be invoked from the mapped BridgeInbox path. Missing mappings or required stages cause BOOT_FAILED or EVIDENCE_INCOMPLETE.

The result manifest must match the execution UUID and protocol, include required guest/provider/Kilo stages and native tool evidence, report a zero Kilo exit code, and declare safe artifacts with valid hashes/sizes. Do not infer success from a Sandbox window closing.

## Artifact rollback recovery

Artifact import validates the entire manifest before changing the task worktree. If an apply operation fails, rollback restores prior files. If rollback itself is incomplete, recovery material is retained under data/sandbox-recovery/rollback-<id>. Preserve that folder until the worktree has been reconciled; do not delete it as routine cleanup.

## Live configuration and stopping intake

The intake loop re-reads Bridge configuration on each poll. Turning off githubIntakeEnabled, sandboxExecutionEnabled, ghEnabled, kiloEnabled, or clearing the trusted repository list causes the next polling tick to stop the intake service. Stop does not forcibly terminate a task already executing; allow it to finish or retain the uncertain claim for reconciliation.

## Windows-specific notes

- Process-tree timeouts use Windows task termination to avoid orphaned child processes.
- The Windows Sandbox readiness check requires the optional Sandbox feature and an interactive desktop session.
- The host relays provider traffic only to the configured provider URL; the guest itself has networking disabled.
- The provider key is read in the host process and never included in guest files.

## Evidence locations

- Bounded Sandbox evidence: data/sandbox-evidence/<executionId>.json.
- Rollback recovery (only on incomplete rollback): data/sandbox-recovery/rollback-<id>.
- Task verification results: reports/verification.
- Generated task reports: reports.
- Audit history: audit_log table and Control Center activity view.

See Windows Sandbox Task Execution and Control Center Operations for the operator workflow and current release gates.

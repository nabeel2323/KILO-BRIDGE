# KILO BRIDGE V1.0 — Universal AI Development Coordinator

## Project mission

Build a reusable, production-quality Windows application named **Kilo Bridge**.

Kilo Bridge must connect ChatGPT, GitHub repositories, local development workspaces, and the Kilo Code coding agent.

The system must allow ChatGPT to:
1. Create implementation tasks in GitHub.
2. Deliver detailed technical specifications to a local Kilo agent through GitHub.
3. Retrieve implementation reports and test evidence from GitHub.
4. Request corrections and additional implementation work.
5. Inspect resulting branches and pull requests.
6. Review multiple projects through the same communication infrastructure.

This is a reusable multi-project application. Do not create a bridge that is hardcoded exclusively for SCS Platform.

## 1. Development environment

Build the application in:

`C:\TAIF\KILO-BRIDGE`

Target environment:
- Windows 11
- Node.js 22
- TypeScript
- SQLite
- GitHub CLI (`gh`)
- Git
- Kilo Code CLI (`@kilocode/cli`)

Use stable, maintained dependencies.

Use PowerShell-compatible scripts and ensure paths work correctly on Windows.

Use `cross-spawn` or Node.js `spawn` with explicit argument arrays. Never interpolate task content into shell commands.

Do not modify any files in the SCS Platform repository while implementing this project.

All Bridge source code, tests, configuration templates and documentation must remain inside the Bridge directory.

## 2. Architecture

Build these independent components:

1. Project Registry
2. GitHub Communication Provider
3. Task Queue and Lifecycle Manager
4. Local Worker
5. Kilo CLI Adapter
6. Git Worktree Manager
7. Security and Permission Manager
8. Independent Verification Engine
9. Report Generator
10. SQLite Persistence Layer
11. CLI Administration Interface
12. Logging and Windows Notification Service

Use interfaces between components so the communication transport can later be extended to an authenticated MCP integration without rewriting the execution engine.

For V1, GitHub Issues and Comments are the communication transport.

Do not implement a public HTTP server, public tunnel, inbound webhook listener or unauthenticated remote execution endpoint.

Do not claim that GitHub polling is live bidirectional streaming. It is a persistent task and feedback handoff mechanism.

## 3. Multi-project architecture

Implement a project registry supporting an unlimited practical number of independent projects.

Every project must have its own:

- Project ID
- GitHub repository
- Local workspace path
- Base development branch
- Worktree root
- Authorized GitHub users
- Runtime configuration
- Verification command definitions
- Kilo agent/model preference
- Task timeout
- Publishing policy
- Security policy

Support multiple project types, including:

- Node.js and TypeScript
- Laravel and PHP
- Python and Django
- Odoo modules
- Flutter
- Other Git repositories with configurable commands

Do not assume all projects use npm, pnpm, Node.js or the same test commands.

Support project-specific command profiles.

Do not automatically execute package installation commands, migrations, database seeds or deployments.

Provide a project configuration example and validation schema.

Implement commands to register, list, validate, inspect, enable and disable projects.

## 4. First registered project: SCS Platform

Register the following project during initialization:

```json
{
  "id": "scs-platform",
  "name": "Smart Commerce & Supply Platform",
  "repository": "nabeel2323/scs-platform",
  "localPath": "C:\\TAIF\\scs-platform",
  "baseBranch": "develop",
  "releaseBranch": "main",
  "worktreeRoot": "C:\\TAIF\\_kilo-worktrees\\scs-platform",
  "branchPrefix": "ai/kilo",
  "allowedAuthors": [
    "nabeel2323"
  ],
  "runtime": {
    "nodeVersion": "22",
    "packageManager": "pnpm",
    "packageManagerVersion": "9.15.9"
  }
}
```

Use `develop` for implementation branches and draft pull request targets. Preserve `main` as the release branch.

Never fall back automatically to `main`.

Before enabling the project:
- Verify the actual local repository.
- Verify the origin remote.
- Verify GitHub authentication.
- Fetch the remote references.
- Confirm `origin/develop` exists.
- Record its actual commit SHA.
- Verify the configured local path.
- Check whether the local main working tree has uncommitted changes.

Do not reset, clean, checkout or pull the user's main working tree.

## 5. GitHub communication protocol

The Bridge must create and manage these labels:

- `kilo:ready`
- `kilo:claimed`
- `kilo:running`
- `kilo:report-ready`
- `kilo:blocked`
- `kilo:failed`
- `kilo:changes-requested`
- `kilo:publish-approved`
- `kilo:published`
- `kilo:done`

Use GitHub CLI authenticated operations.

Do not retrieve or store raw GitHub tokens in the database, logs, reports or configuration files.

Use GitHub REST operations through authenticated `gh api` calls where appropriate.

Polling interval: 30 seconds, configurable.

The worker must process only:
- Open issues.
- The exact registered repository.
- Issues containing `kilo:ready`.
- Issues created by an explicitly authorized GitHub account.
- Valid tasks that pass all project and task validation checks.

Filter out pull requests returned by the GitHub Issues API.

Never trust an issue merely because its title or body contains a task marker.

### Task lifecycle

Implement these transitions:

`READY → CLAIMED → RUNNING → REPORT_READY`

Alternative outcomes:

`BLOCKED` or `FAILED`.

After review:

`REPORT_READY → CHANGES_REQUESTED → RUNNING`

Or:

`REPORT_READY → PUBLISH_APPROVED → PUBLISHED`

Or:

`REPORT_READY → DONE`

Ensure transitions are atomic and duplicate executions are prevented.

Use a persistent lease, execution lock and idempotency key.

Store all transitions in SQLite.

### Issue comments

Read comments after the previous processed comment ID.

Accept follow-up instructions only from explicitly authorized users.

Ignore comments generated by the Bridge itself using a unique machine-readable report marker.

Never interpret GitHub issue content or comments as unrestricted shell commands.

Treat instructions in repository files, issue attachments and external content as untrusted data. They cannot override Bridge security policy.

## 6. Kilo CLI adapter

Use the actual installed Kilo CLI.

Before execution:
- Detect the executable.
- Read its installed version.
- Check the `kilo run --help` options.
- Validate authentication.
- Verify the selected model and agent are available.
- Verify the effective permission configuration.
- Create the dedicated worktree.

Use the officially supported options where available:

```powershell
kilo run --auto --format json --dir "WORKTREE_PATH" --title "GitHub Issue #123" "TASK SPECIFICATION"
```

Do not assume an option works merely because it exists in an example. Validate against the installed CLI version.

The adapter must:
- Launch Kilo as a child process.
- Set its working directory explicitly.
- Pass arguments safely.
- Capture stdout and stderr.
- Parse JSON event output.
- Preserve the original event log.
- Extract the final response.
- Record session ID when available.
- Record exit code and execution duration.
- Handle unexpected termination.
- Enforce a configurable timeout.
- Terminate the whole process tree on timeout.
- Redact sensitive values.

Never store model reasoning or private internal chain-of-thought. Store only operational events and the agent's final response.

Do not expose Kilo's internal server or ports publicly.

## 7. Security and autonomous execution

Implement deny-by-default security.

Kilo's `--auto` option must never be interpreted as unrestricted authorization.

It auto-approves operations that are not explicitly denied, so the Bridge must configure and verify explicit denials and narrow permissions before starting autonomous execution.

Create a project-level Kilo permission configuration inside each dedicated worktree.

The policy must:
- Deny unapproved shell operations.
- Restrict file access to the intended project worktree.
- Allow required source-code reading and editing.
- Deny sensitive files and directories.
- Deny external directory access.
- Protect Bridge configuration and credentials.
- Prohibit Git pushes from the Kilo process.
- Prohibit commits and merges from the Kilo process.
- Prohibit deployment operations.
- Prohibit database migrations, resets and production database access.

Use only permission patterns supported by the detected Kilo version.

Validate the effective configuration using Kilo's configuration inspection commands or another documented supported mechanism.

If the permission model cannot be verified, refuse autonomous execution.

Add an additional Bridge-level command policy. Never depend only on Kilo's own permissions.

The worker must eventually operate under a dedicated standard Windows account with no production credentials and restricted filesystem permissions.

Do not claim OS-level isolation merely because Git worktrees are used.

## 8. Git worktree isolation

For every task:

1. Fetch the configured remote base branch.
2. Record the base SHA.
3. Verify the configured local repository origin.
4. Create a unique feature branch.
5. Create a separate worktree under the configured worktree root.
6. Verify the worktree is clean before starting.
7. Run Kilo only in that worktree.
8. Preserve the worktree and branch after execution.
9. Collect the final diff.
10. Never alter the original working directory.

Use branch names such as:

`ai/kilo/issue-123`

Add a unique attempt suffix for retries.

If an existing worktree or branch conflicts, stop safely and report the conflict. Do not delete or overwrite existing work.

## 9. Independent verification

The Bridge must execute its own configured verification commands after Kilo exits.

Do not rely on agent-reported test results.

Do not assume that successful Kilo execution means successful implementation.

For SCS Platform, configure:

### Required checks

```powershell
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
```

### Advisory check

```powershell
pnpm format:check
```

### Conditional API coverage check

```powershell
pnpm --filter @scs/api test:coverage
```

Run conditional checks when relevant files change.

Integration tests must require an explicitly configured disposable Docker/PostgreSQL/Redis environment.

Never run integration tests against production services.

The following commands must not be part of ordinary autonomous task execution:

```text
pnpm db:migrate
pnpm db:seed
pnpm db:reset
pnpm infra:up
pnpm infra:down
```

They require a separate explicitly authorized execution workflow.

Record every verification command, start time, end time, exit code and captured result.

## 10. Structured implementation reports

Create a Markdown report for each task.

Include:

- Task ID and issue URL
- Project identifier
- Execution ID
- Start/end timestamps
- Kilo version
- Selected model and agent where available
- Kilo session ID where available
- Base commit SHA
- Feature branch
- Implementation summary
- Changed file inventory
- Git diff statistics
- Verification commands
- Actual verification exit codes
- Test failures
- Documentation changes
- Security observations
- Unmet acceptance criteria
- Outstanding issues
- Final result

Allowed final statuses:

`COMPLETE`, `PARTIAL`, `BLOCKED`, `FAILED`.

Never mark a task COMPLETE when required tests failed or were not executed.

Post the report as a comment on the original GitHub issue.

Include a compact summary at the top and detailed evidence below.

Provide a local report file for each execution.

## 11. Follow-up and correction workflow

Support authorized follow-up instructions on the original task issue.

When an authorized user adds a new comment and the issue is labeled `kilo:changes-requested`:

1. Retrieve the new comment.
2. Validate its author.
3. Validate the task state.
4. Create a new execution attempt.
5. Preserve the previous execution report.
6. Send the correction instruction to Kilo.
7. Run independent verification again.
8. Publish a new report.

Never overwrite previous reports.

Keep all attempts linked to their original task ID.

## 12. Controlled publishing

Publishing must be disabled by default.

When an authorized user applies `kilo:publish-approved`, the Bridge may:

1. Validate the task and feature branch.
2. Ensure the worktree contains no prohibited files.
3. Confirm the expected verification policy.
4. Commit the approved changes through the Bridge's own Git process.
5. Push only the task's feature branch.
6. Create a GitHub draft pull request targeting the project's configured development branch.
7. Add the PR URL to the original task issue.
8. Apply the `kilo:published` label.

Never merge a pull request.

Never push directly to `main` or `develop`.

Never deploy.

Never publish merely because Kilo said that the work was finished.

## 13. Application CLI

Implement:

```powershell
kilo-bridge init
kilo-bridge doctor
kilo-bridge configure
kilo-bridge start
kilo-bridge stop
kilo-bridge status

kilo-bridge projects list
kilo-bridge projects add
kilo-bridge projects validate
kilo-bridge projects disable

kilo-bridge github bootstrap
kilo-bridge github test

kilo-bridge tasks
kilo-bridge task <id>
kilo-bridge logs <id>
kilo-bridge reports <id>

kilo-bridge worker start --dry-run
kilo-bridge worker start --project scs-platform
kilo-bridge verify --project scs-platform
```

Provide:
- Human-readable CLI output.
- Structured JSON output for automation.
- Clear error messages.
- Windows PowerShell installation scripts.
- Graceful shutdown.
- Persistent worker recovery.

Task execution must be disabled until the configuration, authentication and security readiness checks pass and the user explicitly enables the worker.

## 14. Project administration

Implement a configuration-driven multi-project registry.

Adding another project must not require modifying source code.

For each new project, require:
- GitHub repository owner/name.
- Local project path.
- Development/base branch.
- Authorized authors.
- Worktree location.
- Runtime and verification commands.

Offer configuration templates for Node.js, Laravel, Django, Odoo and Flutter.

Require explicit configuration rather than guessing verification commands.

Keep projects independently isolated.

Do not allow a task from one project to access another project's worktree.

## 15. Testing strategy

Implement unit, integration and end-to-end tests.

Test:

- Configuration validation.
- Multiple project registration.
- GitHub authentication failure.
- GitHub API and rate-limit failures.
- Unauthorized task authors.
- Unauthorized follow-up comments.
- Pull request exclusion.
- Duplicate task prevention.
- Concurrent worker protection.
- Lease expiry and recovery.
- Kilo process launch.
- JSON event parsing.
- Kilo execution failure.
- Task timeout.
- Test failure handling.
- Worktree isolation.
- Path traversal attempts.
- Shell command injection attempts.
- Secret redaction.
- Permission configuration validation.
- Publishing approval enforcement.
- Draft PR creation.
- Multiple independent project execution.

Use mocked GitHub and Kilo processes first.

Never use a real production repository task to test unsafe execution behavior.

## 16. Initial operating mode

Implement V1 in these rollout stages.

**Stage A — Core application**

Build the project, database, registry, GitHub client, CLI and test framework.

**Stage B — GitHub integration**

Implement authentication checks, label initialization, issue polling and comments.

**Stage C — Simulated Kilo execution**

Verify the lifecycle using a mocked Kilo executable.

**Stage D — Real Kilo execution**

Perform one harmless test task in a disposable worktree after security validation.

**Stage E — SCS Platform registration**

Validate the actual SCS configuration and enable its worker only after manual review.

The bridge must not begin unattended task processing merely because the application was installed.

## 17. Documentation

Create complete professional documentation:

- README
- Architecture overview
- Installation guide
- Windows configuration guide
- GitHub authentication guide
- Kilo CLI integration guide
- Multi-project registration guide
- Task lifecycle reference
- Security model
- Operations manual
- Recovery and troubleshooting
- Developer guide
- Testing guide
- Release notes

Document actual implemented behavior. Mark incomplete capabilities accurately.

## 18. Definition of Done

V1 is complete only when:

1. The application builds successfully.
2. Its automated tests pass.
3. SQLite persistence works.
4. The SCS Platform configuration validates.
5. GitHub authentication is verified.
6. Required GitHub labels can be initialized.
7. A test issue can be discovered and claimed.
8. A mock Kilo run completes.
9. Independent verification results are stored.
10. An implementation report is published to the test issue.
11. Unauthorized tasks are rejected.
12. Publishing approval is enforced.
13. The worktree does not modify the original workspace.
14. The multi-project registry works.
15. The installation and operations guides are complete.

A real Kilo run must also be demonstrated before declaring real agent execution operational.

If any requirement cannot be verified, report it as outstanding rather than claiming success.

## 19. Final deliverables

Deliver:
- Complete TypeScript application.
- SQLite schema and migrations.
- Example configuration.
- Registered SCS Platform project.
- GitHub task protocol.
- Kilo CLI adapter.
- Git worktree management.
- Security configuration templates.
- Verification engine.
- Reporting engine.
- PowerShell scripts.
- Automated tests.
- End-to-end test report.
- Complete installation and operational documentation.

Do not stop after creating an architecture plan. Implement the complete V1, test it, and report precisely what is operational and what still requires manual configuration.

Begin by inspecting the current environment and documenting the implementation plan. Then execute the stages in order. Do not modify any project outside `C:\TAIF\KILO-BRIDGE`.
# Security Model

Kilo Bridge is **deny-by-default**. Autonomous execution is permitted only inside an isolated worktree, only with an explicitly verified permission configuration, and only for operations on a narrow allow-list. `--auto` never means unrestricted.

## Threat model

The agent processes task text that originates from GitHub issues/comments. That text is **untrusted input**. The Bridge assumes the agent may attempt to read secrets, escape the worktree, push code, run migrations, or deploy. Every one of those is explicitly denied and independently checked.

## Layers of defense

### 1. Authorization (who may create work)

- Only issues created by a project's `allowedAuthors` are processed.
- Only follow-up comments from `allowedAuthors` trigger corrections.
- Everyone else is rejected and written to the audit log.
- An issue is never trusted merely because its title/body contains a task marker.
- Pull requests are filtered out and never treated as tasks.

### 2. Isolation (where work happens)

- Each task runs in a dedicated git worktree under the project's `worktreeRoot`, on branch `ai/kilo/issue-N[-attempt-K]`, created from the recorded base SHA of `origin/<baseBranch>`.
- The user's main checkout is **never** reset, cleaned, checked out, or pulled.
- Origin is verified against the registered repository before execution (`ORIGIN_MISMATCH` blocks).
- A path guard (`isPathWithinWorktree`, case-insensitive on Windows) rejects traversal outside the worktree.

> Worktrees are **filesystem isolation, not an OS sandbox**. For production, run the worker under a dedicated standard Windows account with no production credentials. See [Windows configuration](windows-configuration.md).

### 3. Kilo permission config (what the agent may do)

Before execution the Bridge writes `kilo.json` into the worktree and verifies it. Schema verified against the installed Kilo CLI (`https://app.kilo.ai/config.json`). Because `--auto` auto-approves anything not explicitly denied, **every dangerous operation is an explicit `deny`, never `ask`**.

- `permission.read` / `permission.edit`: allow `**`, then deny `.env*`, `**/secrets/**`, `**/credentials/**`, `**/*.pem`, `**/*.key`, `**/id_rsa*`, `**/id_ed25519*`, `.git/**`, `**/node_modules/**`, and the entire Bridge install root.
- `permission.bash`: default `"*": "deny"`, then a narrow allow-list (read-only git, `pnpm lint/typecheck/test/build/format`, version probes), then explicit denies for `git push/commit/merge/reset/checkout/clean`, `*db:migrate*`, `*db:seed*`, `*db:reset*`, `*infra:up*`, `*infra:down*`, `*kubectl*`, `*docker*`, `gh *`, destructive removal, network fetchers (`curl/wget/Invoke-*`), `ssh/scp/ftp`, `*deploy*`, `*production*`, and shells (`powershell/pwsh/cmd/bash/sh/...`).
- `external_directory`, `webfetch`, `websearch`, `doom_loop`: all `deny`.

**Verification is two-sided** (`verifyEffectivePermissions`):
1. Bridge assertion — `findMissingDenials` confirms every required denial is present (tamper/merge check).
2. Kilo validation — `kilo config check` in the worktree must pass.

If either fails, execution is **refused** and the task is `BLOCKED`. (The Kilo-side check is skipped only in mock mode.)

### 4. Bridge command policy (independent of Kilo)

A `bridge.command-policy.json` (default `deny`) is written alongside, and the verification engine independently refuses prohibited commands (`db:migrate`, `db:seed`, `db:reset`, `infra:up`, `infra:down`) regardless of what the agent or config requests.

### 5. Publishing control (what leaves the machine)

- Publishing is **disabled by default** (`publishingEnabled: false`).
- Even when enabled, it requires the `kilo:publish-approved` label on the issue, a `REPORT_READY` task, passing required verification, and a clean prohibited-file scan.
- The **Bridge** (not Kilo) commits, pushes the feature branch, and opens a **draft** PR to the configured base branch.
- Protected branches (`main`, `develop`, the base branch, release branch) are never pushed. Kilo never merges or deploys.

### 6. Secret handling

- **No GitHub token is ever read, stored, or logged.** Authentication is delegated to `gh`.
- `redactSecrets` masks `ghp_…`, `github_pat_…`, `sk-…`, and long base64-like strings in all logs/outputs, while preserving 40/64-hex git SHAs.
- Model reasoning / chain-of-thought is never stored.

## Audit trail

Every security-relevant event is appended to `audit_log`: task discovery, rejection (with reason), claim, execution, failure, lease recovery, comment rejection, config changes, and GitHub bootstrap.

## Known residual risks

- Worktree isolation is not OS-level isolation (mitigate with a dedicated worker account).
- The allow-listed `pnpm test*`/`build*` commands execute project code; a malicious project script could still do damage within the worktree's reach. Only register repositories you trust.
- Deny patterns are glob-based; they are verified for presence but cannot anticipate every obfuscated shell invocation. The default-deny bash rule is the backstop.
# Multi-Project Registration Guide

The Bridge is configuration-driven and supports any number of independent projects. Each project has its own repository, local checkout, base branch, worktree root, authorized authors, and verification suite. Projects are fully isolated — a task for one project never touches another's worktree, branch, or database rows.

## Register a project

```powershell
# Validate first (no writes)
node dist/cli.js projects validate examples/projects/scs-platform.json

# Register
node dist/cli.js projects add examples/projects/scs-platform.json

# List / inspect
node dist/cli.js projects list
node dist/cli.js projects inspect scs-platform
```

`projects add` accepts a path to a JSON file **or** an inline JSON string.

## Configuration schema

Every project config is validated with zod (`ProjectConfigSchema`). Required fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string | lowercase alphanumeric + hyphens, `^[a-z0-9][a-z0-9-]*$` |
| `name` | string | display name |
| `repository` | string | `owner/name` on GitHub |
| `localPath` | string | absolute path to the local checkout |
| `baseBranch` | string | integration branch to branch from (SCS: `develop`) |
| `worktreeRoot` | string | absolute dir for this project's worktrees |
| `branchPrefix` | string | e.g. `ai/kilo` → branches `ai/kilo/issue-N` |
| `allowedAuthors` | string[] | ≥1 GitHub username; only these may create tasks/comments |

Optional fields:

| Field | Default | Notes |
|---|---|---|
| `releaseBranch` | — | protected release branch (SCS: `main`); never pushed |
| `runtime` | — | `{ nodeVersion, packageManager, packageManagerVersion, phpVersion, pythonVersion }` |
| `projectType` | — | `node`, `laravel`, `django`, `odoo`, `flutter`, `other` |
| `verificationCommands` | `[]` | **required** checks; all must pass for COMPLETE |
| `advisoryCommands` | `[]` | reported but never gate completion |
| `conditionalVerification` | `[]` | run only when `apps/api/**` or `packages/**` changed |
| `kiloModel` / `kiloAgent` | — | passed to `kilo run` after preflight validation |
| `taskTimeoutMs` | bridge default | per-task Kilo timeout |
| `pollIntervalMs` | bridge default | per-project poll interval |
| `publishingEnabled` | `false` | must be explicitly enabled; still requires per-issue approval |
| `state` | `active` | `active` or `disabled` |

## Templates

Generate a starting config for a runtime:

```powershell
node dist/cli.js projects template node
node dist/cli.js projects template laravel
node dist/cli.js projects template django
node dist/cli.js projects template odoo
node dist/cli.js projects template flutter
```

Ready-made examples live in `examples/projects/` (`node`, `laravel`, `django`, `odoo`, `flutter`, `scs-platform`).

## The SCS Platform project

`examples/projects/scs-platform.json` is the reference registration:

- repository `nabeel2323/scs-platform`, local `C:\TAIF\scs-platform`
- base `develop`, release `main`, worktrees under `C:\TAIF\_kilo-worktrees\scs-platform`
- allowed author `nabeel2323`
- required verification: `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm build`
- advisory: `pnpm format:check`
- conditional: `pnpm --filter @scs/api test:coverage`
- `publishingEnabled: false`

## Enable / disable

```powershell
node dist/cli.js projects disable scs-platform   # worker skips it
node dist/cli.js projects enable scs-platform
```

Only `active` projects are polled. Disabling a project does not delete its tasks or reports.

## Isolation guarantees

- Worktrees are created under each project's own `worktreeRoot`.
- Branch names are namespaced by `branchPrefix` + issue number.
- Tasks, executions, verifications, reports, and audit rows are keyed by `projectId`.
- The idempotency key is `sha256(projectId:issueNumber)`, so the same issue number in two projects is two distinct tasks.
- Origin is verified against the registered `repository` before any execution (`ORIGIN_MISMATCH` blocks the task).

See `tests/multi-project.test.ts` for an end-to-end two-project isolation test.
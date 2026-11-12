# Kilo Bridge V1.0

**Universal AI Development Coordinator** — connects ChatGPT, GitHub repositories, local development workspaces, and the Kilo Code coding agent.

Kilo Bridge lets ChatGPT create implementation tasks as GitHub Issues, delivers detailed specifications to a local Kilo agent through GitHub, retrieves implementation reports with independent test evidence, requests corrections, and inspects resulting branches and draft pull requests — across an unlimited practical number of independent projects.

> **Transport note:** V1 uses GitHub Issues + Comments as a *persistent task and feedback handoff mechanism* (30 s polling, configurable). It is **not** live bidirectional streaming. There is no public HTTP server, tunnel, inbound webhook, or unauthenticated remote execution endpoint.

## How it works

```
ChatGPT ──creates issue──▶ GitHub (kilo:ready)
                              │  poll (gh api, authenticated)
                              ▼
                        Kilo Bridge worker
                              │  claim → isolated git worktree
                              ▼
                        Kilo CLI (--auto, deny-by-default permissions)
                              │  implementation
                              ▼
                        Independent verification (your configured commands)
                              │
                              ▼
                        Markdown report ──comment──▶ GitHub issue
                              │
              authorized follow-up / publish approval
                              ▼
                        corrections / draft PR (never merged by the Bridge)
```

## Requirements

- Windows 11, Node.js >= 22, pnpm
- Git, GitHub CLI (`gh`) authenticated, Kilo CLI (`@kilocode/cli`) authenticated
- SQLite (embedded via `sql.js` — no separate server)

## Quick start

```powershell
pnpm install
pnpm build
node dist/cli.js init
node dist/cli.js doctor
node dist/cli.js projects add examples/projects/scs-platform.json
node dist/cli.js github bootstrap scs-platform   # requires gh auth login
node dist/cli.js worker start --dry-run          # safe discovery, no execution
```

Task execution stays **disabled** until you explicitly enable it after review:

```powershell
node dist/cli.js configure set workerEnabled true
node dist/cli.js start                            # persistent worker, Ctrl+C to stop
```

## CLI

| Command | Purpose |
|---|---|
| `init` / `doctor` / `configure [set k v]` | Setup, environment checks, configuration |
| `start` / `stop` / `status` | Persistent worker lifecycle |
| `projects list/add/validate/enable/disable/inspect/template` | Multi-project registry |
| `github bootstrap/test [project]` | Auth check + label initialization |
| `tasks` / `task <id>` / `logs <id>` / `reports <id>` | Task inspection |
| `worker start [--dry-run] [--mock] [--project id]` | One worker poll |
| `verify --project <id>` | Re-run independent verification |

Add `--json` to any command for structured automation output.

## Documentation

- [Architecture](docs/architecture.md) · [Installation](docs/installation.md) · [Windows configuration](docs/windows-configuration.md)
- [GitHub authentication](docs/github-authentication.md) · [Kilo CLI integration](docs/kilo-cli-integration.md)
- [Multi-project registration](docs/multi-project-registration.md) · [Task lifecycle](docs/task-lifecycle.md)
- [Security model](docs/security-model.md) · [Operations manual](docs/operations-manual.md)
- [Recovery & troubleshooting](docs/recovery-troubleshooting.md) · [Developer guide](docs/developer-guide.md)
- [Testing guide](docs/testing-guide.md) · [Release notes](docs/release-notes.md) · [E2E test report](docs/e2e-test-report.md)

## Safety guarantees

- Deny-by-default Kilo permissions per worktree, verified before every autonomous run.
- Kilo can never push, commit, merge, deploy, or run migrations — the Bridge owns publishing.
- Every task runs in an isolated git worktree; your main working tree is never reset, cleaned, checked out, or pulled.
- Publishing is disabled by default and requires an authorized `kilo:publish-approved` label; only draft PRs to the configured development branch are created. The Bridge never merges.
- No GitHub tokens are ever read, stored, or logged. Model reasoning is never stored.

## Status

V1 is feature-complete: **131/131 automated tests pass**, and a **real Kilo execution was demonstrated and independently verified** (Stage D). The SCS Platform project is registered and validated.

**Outstanding manual step:** GitHub authentication (`gh auth login`) is not yet completed, so live label bootstrap and live test-issue discovery/reporting are pending. The worker is intentionally **disabled** until you review the security model and enable it explicitly.

See [release notes](docs/release-notes.md) and the [Definition-of-Done test report](docs/e2e-test-report.md) for precisely what is operational and what requires manual configuration.
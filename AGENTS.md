# Kilo Bridge V1.0 — AGENTS.md

## Project
Kilo Bridge is a universal AI development coordinator that bridges GitHub Issues/Comments transport (polling) with local AI agent execution via isolated Git worktrees. No public HTTP server, tunnel, or webhook is required.

## Directory Layout
```
src/                 TypeScript source
  app.ts             KiloBridgeApp orchestration
  cli.ts             CLI command router
  config.ts          bridge.config.json load/save
  db.ts              SqliteStore (sql.js) schema/migrations/CRUD
  types.ts           shared constants, Zod schemas, domain/result types
  components/
    github.ts        GitHub Issues/Comments/Labels/PR via gh CLI
    kilo.ts          Kilo CLI adapter (event parsing, redaction, timeout)
    lifecycle.ts     task status transitions, lease management
    logging.ts       structured logger (stderr for console)
    process.ts       runProcess (spawn, timeout, Windows handling)
    publishing.ts    prohibited file detection
    report.ts        report generator (markdown, comment body)
    security.ts      deny-by-default policy, kilo.json, redaction
    verification.ts  command selection/tokenization, suite execution
    worker.ts        poll/discover/claim/execute/verify/report/publish flow
    worktree.ts      isolated worktree lifecycle, diff, commit, push
tests/               node:test suites (compiled to dist-test/tests/)
  helpers/           mock-gh, mock-kilo, worker-env, fixtures
dist/                compiled CLI output (tsc)
dist-test/           compiled test output (tsc)
```

## Available Commands

| Command | Purpose |
|---------|---------|
| `pnpm run build` | Compile TypeScript source to `dist/` |
| `pnpm run build:test` | Compile test TypeScript to `dist-test/` |
| `pnpm run test` | Run full test suite (`node --test dist-test/tests/*.test.js`) |
| `node dist/cli.js init` | Initialize Bridge (db, dirs, config, register SCS) |
| `node dist/cli.js doctor` | Verify environment and tools |
| `node dist/cli.js projects list|add|validate|enable|disable|inspect|template` | Project management |
| `node dist/cli.js github bootstrap|test` | GitHub auth check + label bootstrap |
| `node dist/cli.js worker start [--dry-run] [--project <id>]` | Run one worker poll |
| `node dist/cli.js verify --project <id>` | Run independent verification |
| `node dist/cli.js tasks|task|logs|reports` | Query task state |

## Test Suites (131 tests)
All suites run under `node:test`:
- `cli.test.js` — CLI command behavior
- `db.test.js` — SqliteStore CRUD, migrations, persistence
- `github.test.js` — GitHubProvider mock interactions
- `kilo.test.js` — KiloCliAdapter event parsing/redaction/timeout
- `lifecycle.test.js` — task transitions, leases, corrections
- `logging.test.js` — structured logger
- `process.test.js` — runProcess spawn/timeout/kill behavior
- `publishing.test.js` — prohibited file detection, refusal comments
- `report.test.js` — report generation, idempotency, gating
- `registry.test.js` — project registration, validation, templates
- `security.test.js` — deny-by-default policy, kilo.json, redaction
- `smoke.test.js` — end-to-end smoke checks
- `verification.test.js` — command selection, suite execution
- `worker.test.js` — poll/discover/execute/verify/report/publish flow
- `worktree.test.js` — isolated worktree lifecycle, diff, commit, push

## Key Design Decisions
- **SQLite via sql.js** (not better-sqlite3): works on Node 26 without Visual Studio build tools.
- **Polling transport**: GitHub Issues/Comments via `gh` CLI, no webhooks or public server.
- **Deny-by-default security**: per-worktree `kilo.json`, bridge command policy, secret redaction.
- **No reasoning stored**: Kilo chain-of-thought events are filtered out of event logs.
- **Worker lock**: file-based lock prevents concurrent workers.
- **Git worktree isolation**: each task gets its own worktree and feature branch.

## Environment Notes
- Node v26.4.0 on Windows: `gh` and `kilo` CLIs may not be installed; `doctor` reports them as non-fatal.
- Test harness uses `node --test --test-concurrency=1` to avoid libuv handle assertion issues on Node 26/Windows.
- `better-sqlite3` was replaced with `sql.js` due to missing Visual Studio build tools on Node 26.
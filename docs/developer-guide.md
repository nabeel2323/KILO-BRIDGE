# Developer Guide

For engineers extending or maintaining Kilo Bridge.

## Stack

- **TypeScript** (strict, `target ES2022`, `module Node16`, CommonJS output).
- **Node ≥ 22** (developed on v26). Windows-first (`os: ["win32"]`).
- **zod** for all config/schema validation.
- **sql.js** (WASM SQLite) with persist-on-write.
- **cross-spawn** for Windows `.cmd` shim resolution (pnpm/kilo/gh) — explicit argv, never a shell string.
- **node:test** as the test runner (no external framework).

## Layout

```
src/
  cli.ts            CLI entry (argv parsing, human + --json output)
  app.ts            KiloBridgeApp: init/doctor/configure/projects/github/tasks/worker/verify
  config.ts         bridge.config.json load/save/validate
  db.ts             SqliteStore: schema, migrations, persist-on-write, queries
  types.ts          zod schemas, constants (labels, statuses), result helpers
  components/
    registry.ts     project registration/validation/templates
    github.ts       gh api transport (issues/comments/labels/PRs/rate limits)
    lifecycle.ts    state machine, leases, idempotency, recovery
    worker.ts       polling loop + execution pipeline + corrections + publishing
    kilo.ts         Kilo CLI adapter (preflight, argv, event parsing, redaction)
    worktree.ts     origin verify, worktree prep, diff, commit/push
    security.ts     deny-by-default kilo.json, policy, path guard, redaction
    verification.ts config-driven command suites, required/advisory/conditional
    report.ts       per-execution Markdown reports + comment bodies
    publishing.ts   approval enforcement, prohibited-file scan, draft PR
    process.ts      cross-spawn runner, capture, timeout, process-tree kill
    logging.ts      JSON line logs + Windows notifications
tests/              node:test suites + helpers (mock gh/kilo, fixture repos)
examples/projects/  ready-made project configs
scripts/            PowerShell ops scripts + stage demo/validation scripts
docs/               this documentation suite
```

## Build & run

```powershell
pnpm install
pnpm build          # tsc -p tsconfig.json      → dist/      (app only)
pnpm build:test     # tsc -p tsconfig.test.json → dist-test/ (src + tests)
pnpm typecheck      # both projects, --noEmit
pnpm test           # build + build:test + node --test
node dist/cli.js help
```

Two tsconfigs: `tsconfig.json` compiles `src/` → `dist/` (the shipped app, with declarations); `tsconfig.test.json` compiles `src/` + `tests/` → `dist-test/` so tests import real source. Tests run from `dist-test/tests/**/*.test.js`.

## Conventions

- **Result pattern**: components return `BridgeResult<T>` (`{ ok, data?, error?, code? }`) via `okResult`/`failResult`. Error `code`s are stable strings (e.g. `ORIGIN_MISMATCH`, `LEASE_HELD`). The worker maps `blocked: true` errors to `BLOCKED`, others to `FAILED`.
- **No shell interpolation**: every external command goes through `runProcess(cmd, args[], opts)` with an explicit argv array. GitHub content is never tokenized — only trusted project config is (`tokenizeCommand`).
- **Persist on every write**: `SqliteStore.mutate()` writes the DB to disk (temp + rename) after each mutation so state survives crashes.
- **Node16 imports**: relative imports need the `.js` extension in emitted CJS; prefer static imports over dynamic `import()` for local modules.
- **Windows exit**: set `process.exitCode`, never `process.exit()` while pipes may be pending (libuv assertion).
- **git safety**: pass `-c safe.directory=<dir>` per command; never modify stored git config. Use `git config --get remote.origin.url` (not `remote get-url`, which expands `insteadOf`).

## Adding a verification command

Edit the project's `verificationCommands` (required), `advisoryCommands`, or `conditionalVerification`. Conditional commands run only when `apps/api/**` or `packages/**` changed. Prohibited commands (`db:migrate/seed/reset`, `infra:up/down`) are always refused by the engine.

## Adding a GitHub transport

`GitHubProvider` is the only component that knows about GitHub. The worker depends on its method surface (`authStatus`, `listOpenIssues`, `getIssue`, `listComments`, `addComment`, `ensureLabels`, `addLabels`, `removeLabel`, `createDraftPr`, `getRateLimit`). A future authenticated MCP transport can implement the same surface without touching the execution engine.

## Extending the state machine

Add the transition to `ALLOWED_TRANSITIONS` in `lifecycle.ts`, the label mapping to `STATUS_LABEL` in `worker.ts`, and a test in `tests/lifecycle.test.ts`. Illegal transitions are rejected at runtime.

## Where to look when something breaks

- Task stuck → `lifecycle.ts` (transitions/leases) + `worker.ts` (pipeline).
- Wrong report status → `worker.ts` (`executeTask` status logic) + `report.ts` (`shouldBeComplete`).
- Permission refusal → `security.ts` (`findMissingDenials`, `verifyEffectivePermissions`).
- GitHub errors → `github.ts` (`classifyError`).
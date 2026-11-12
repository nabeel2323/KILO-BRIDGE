# Testing Guide

## Running the suite

```powershell
pnpm test            # build + build:test + node --test dist-test/tests/**/*.test.js
pnpm test:coverage   # same, with --experimental-test-coverage
```

The suite uses the built-in **node:test** runner. As of this release: **131 tests across 15 files, all passing.**

## Test files

| File | Covers |
|---|---|
| `smoke.test.ts` | build/import sanity |
| `process.test.ts` | cross-spawn runner, capture, timeout, stdin close |
| `db.test.ts` | schema, migrations, persist-on-write, queries, exitCode 0 mapping |
| `registry.test.ts` | registration, validation, templates, enable/disable |
| `lifecycle.test.ts` | transitions, leases, idempotency, corrections, recovery |
| `security.test.ts` | deny-by-default config, denial verification, redaction, path guard |
| `worktree.test.ts` | origin verify, worktree prep, diff, protected-branch push guard |
| `verification.test.ts` | command suites, glob matching, prohibited commands, required gating |
| `report.test.ts` | per-execution reports, COMPLETE gating, comment marker |
| `github.test.ts` | gh api argv, PR filtering, label bootstrap, rate-limit classification |
| `kilo.test.ts` | preflight, argv ordering, session extraction, reasoning exclusion |
| `worker.test.ts` | 15 end-to-end lifecycle tests (mock gh + mock kilo) |
| `publishing.test.ts` | approval enforcement, prohibited files, verification gating |
| `cli.test.ts` | 10 CLI integration tests (human + --json) |
| `multi-project.test.ts` | two-project isolation end-to-end |

## Test infrastructure

### Mock executables
- `tests/helpers/mock-gh.cjs` — a fixture-driven `gh` stand-in. Reads `MOCK_GH_FIXTURES` (JSON of endpoint→response), records calls to `MOCK_GH_CALLS` (JSONL). Invoked via `GitHubProvider({ ghBin: process.execPath, ghPrefixArgs: [mock] })`.
- `tests/helpers/mock-kilo.cjs` — a fixture-driven `kilo` stand-in (`MOCK_KILO_FIXTURES`/`MOCK_KILO_CALLS`). Emits JSON events, can create files, simulate failures/timeouts. **Help goes to stderr** to match the real CLI and prevent regressions.

### Fixture git repos
`tests/helpers/fixtures.ts` builds real local git repos (with a bare origin) in temp dirs. `makeWorkerEnv` (`tests/helpers/worker-env.ts`) wires a full `Worker` against them:

- The fixture origin URL is set to `https://github.com/test-owner/test-repo.git`, and a **git `insteadOf` rewrite via `GIT_CONFIG_COUNT/KEY_0/VALUE_0` env** transparently routes fetch/push to the local bare repo. This lets origin-verification logic run against a real GitHub-style URL **without network access and without modifying stored git config**.
- Notifications are disabled; each env has an isolated SQLite store, registry, worktree root, and cleanup.

This means the end-to-end worker tests exercise the **real** worktree, security, verification, report, and lifecycle code — only the GitHub and Kilo boundaries are mocked.

## Writing a new test

1. Put it in `tests/<name>.test.ts`, import from `../src/...`.
2. For worker/pipeline tests, use `makeWorkerEnv`, set fixtures with `setGhFixtures`/`setKiloFixtures`, call `worker.pollOnce()` or `executeTask`, then assert on the store and `ghCalls()`/`kiloCalls()`.
3. Always `cleanup()` in a `finally`/`after` hook.
4. Run `pnpm build:test` then `node --test dist-test/tests/<name>.test.js`.

## Real-execution demos (not part of `pnpm test`)

- `scripts/stage-d-real-kilo-demo.cjs` — runs the **real** Kilo CLI in a disposable repo/worktree, independently verifies the produced file, and confirms the main tree is untouched. Set `DEMO_MODEL` (default `kilo/kilo-auto/free`).
- `scripts/stage-e-validate-scs.cjs` — read-only validation of the registered SCS repo (origin, fetch, base SHA, branch, dirty state).

## End-to-end evidence

See [e2e-test-report.md](e2e-test-report.md) for the Definition-of-Done mapping with evidence and outstanding items.
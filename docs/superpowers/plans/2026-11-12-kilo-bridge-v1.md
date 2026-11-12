# Kilo Bridge V1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution is inline in this session per the spec's explicit directive: "Do not stop after creating an architecture plan. Implement the complete V1."

**Goal:** Repair and complete the existing partial Kilo Bridge implementation into a production-quality, multi-project Windows coordinator between ChatGPT (via GitHub Issues), local workspaces, and the Kilo Code CLI.

**Architecture:** TypeScript (CJS, Node16 modules) on Node >= 22; sql.js (WASM SQLite) persistence with persist-on-write; components behind interfaces (registry, github provider, lifecycle, worker, kilo adapter, worktree, security, verification, report, logging); CLI administration; GitHub Issues/Comments as the V1 transport via authenticated `gh api`; no inbound server.

**Tech Stack:** Node 26.4.0 (installed; target >= 22), TypeScript ~5.6, zod, sql.js, cross-spawn (Windows .cmd-safe spawning), node:test runner, gh 2.103.3, git 2.45.2, Kilo CLI 7.8.27.

**Spec:** `docs/spec/kilo-bridge-v1-spec.md` (verbatim copy of the user-provided specification).

## Environment Inspection Results (2026-11-12)

| Item | Status |
|---|---|
| Node.js | v26.4.0 (>= 22 required) OK |
| pnpm | 9.15.9 OK |
| git | 2.45.2.windows.1 OK |
| gh | 2.103.3 installed at `C:\Program Files\GitHub CLI\gh.exe`; on machine PATH (not in current session); **not authenticated — user is running `gh auth login`** |
| Kilo CLI | 7.8.27 at `%APPDATA%\npm\kilo.cmd`; authenticated (Kilo Gateway oauth + nvidia provider) |
| `kilo run` options | `--auto --format json --dir --title --model --agent --session` all verified present in installed version |
| Kilo permission schema | Verified from `https://app.kilo.ai/config.json`: legacy `permission` object (read/edit/glob/grep/bash/external_directory/webfetch/websearch/doom_loop/... each `"ask"\|"allow"\|"deny"` or pattern→action map) + new `permissions` ordered ruleset `{action,resource,effect}`. `kilo config check` validates config. |
| Global Kilo config | `~/.config/kilo/kilo.jsonc` has `permission.bash = "allow"` → worktree-level explicit denies are MANDATORY (spec §7) |
| SCS repo | `C:\TAIF\scs-platform` exists; origin = `https://github.com/nabeel2323/scs-platform.git`; `origin/develop` exists; user is on `feature/buyer-staging-deployment-remediation` with untracked scratch files — must NOT be touched |
| Existing Bridge code | Partial; several runtime bugs (below); no tests/docs/scripts; not a git repo |

## Global Constraints (verbatim from spec)

- All Bridge source, tests, config templates, docs stay inside `C:\TAIF\KILO-BRIDGE`. Do not modify any files in the SCS Platform repository (or any other project) while implementing.
- Use `cross-spawn` or Node `spawn` with explicit argument arrays. Never interpolate task content into shell commands.
- No public HTTP server, tunnel, inbound webhook, or unauthenticated remote execution endpoint.
- Do not retrieve or store raw GitHub tokens in database, logs, reports, or configuration files.
- Never reset, clean, checkout or pull the user's main working tree.
- Never fall back automatically to `main`; `develop` is the SCS base/PR target.
- Never merge a PR; never push directly to `main` or `develop`; never deploy.
- Never store model reasoning / chain-of-thought; only operational events + final response.
- Never mark COMPLETE when required tests failed or were not executed.
- Publishing disabled by default; requires `kilo:publish-approved` from an authorized user.
- Task execution disabled until readiness checks pass and user explicitly enables the worker.
- Polling interval 30 s, configurable. GitHub polling is a persistent handoff mechanism, not live streaming.
- If a requirement cannot be verified, report it as outstanding rather than claiming success.

## Existing-Code Defect Inventory (must fix)

1. `github.ts`: `gh issue list --json htmlUrl,isPullRequest` — invalid fields (gh has `url`, no `isPullRequest`); raw gh author/labels shapes not normalized; `listComments` uses invalid jq template `.[].{...}`; `addComment` cannot obtain comment id (gh prints URL); `authStatus` reads only stdout (gh writes status to stderr); `ensureLabels` does N search calls; no rate-limit detection; no PR creation.
2. `kilo.ts`: `detectExecutable`/`readHelp`/`validateAuth` pass `[kiloBin, ...]` as args → executes `kilo kilo --version`; probe cwd may not exist → false ENOENT; sessionId never captured; blanket 40+ char redaction destroys git SHAs; stdin never closed (child may hang); no permission verification.
3. `worktree.ts`: `show-ref --verify --refs/heads/x` invalid (double dash); no origin-match validation; diff inventory misses untracked files; no Bridge-owned commit/push.
4. `db.ts`: persists only on close (crash loses leases/state); `require("node:crypto")` inline; no audit helpers; no project+issue lookup.
5. `lifecycle.ts`: `claimTask` bumps attempt on first claim (off-by-one); `expiredLeases` is a stub.
6. `verification.ts`: `import type { okResult, failResult }` (values imported as types); `spawn("pnpm")` fails on Windows (.cmd needs cross-spawn); no per-command timeout; SCS profile hardcoded in app.
7. `report.ts`: report file named by taskId only → overwrites previous attempts (spec §11 forbids); `shouldBeComplete` ignores required-command coverage.
8. `app.ts`: worker is a stub (marks everything BLOCKED, no worktree/Kilo/verification/report); doctor return logic broken; no follow-up, publishing, lease recovery, worker loop, readiness gate.
9. `cli.ts`: missing `projects enable/inspect`, `--json`, real `configure`, persistent `start`/`stop`/`status`, human-readable task output.
10. Windows spawning: `kilo`/`pnpm` are `.cmd` shims — plain `spawn` without shell fails on Node >= 22 (EINVAL). Use cross-spawn everywhere.

## File Structure

```
src/
  types.ts                 constants, zod schemas, result helpers (exists; extend)
  config.ts                bridge config load/save (exists; extend)
  db.ts                    SqliteStore + migrations (exists; repair)
  app.ts                   application facade (exists; rewire to worker)
  cli.ts                   CLI entry (exists; complete)
  components/
    process.ts             NEW shared cross-spawn runner: capture, timeout, tree-kill
    registry.ts            project registry + templates (exists; extend)
    github.ts              gh api transport (exists; repair)
    lifecycle.ts           transitions, leases, idempotency (exists; repair)
    worktree.ts            git worktree isolation + Bridge git ops (exists; repair)
    security.ts            kilo.json permission generation + policy checks (exists; rewrite config gen)
    kilo.ts                Kilo CLI adapter (exists; repair)
    verification.ts        independent verification engine (exists; repair)
    report.ts              markdown reports + issue comments (exists; repair)
    worker.ts              NEW worker loop + execution pipeline + follow-up + recovery
    publishing.ts          NEW controlled publishing (commit/push/draft PR)
    logging.ts             JSON logs + Windows toast (exists)
tests/
  helpers/                 mock gh/kilo executables, fixture repo builder, temp dirs
  *.test.ts                one suite per component + e2e lifecycle
tsconfig.test.json         NEW compiles src+tests → dist-test (CJS) for node --test
examples/projects/         scs-platform.json, node.json, laravel.json, django.json, odoo.json, flutter.json
scripts/                   install.ps1, start-worker.ps1, stop-worker.ps1, doctor.ps1
docs/                      full documentation suite (spec §17)
```

---

## Stage A — Core application

### Task A1: Toolchain & scaffolding
**Files:** Modify `package.json`; Create `tsconfig.test.json`, `.gitignore`, `docs/spec/kilo-bridge-v1-spec.md`; `git init` + initial commit.
- [ ] `pnpm add cross-spawn`; `pnpm add -D @types/cross-spawn`.
- [ ] `tsconfig.test.json`: extends tsconfig, `rootDir: "."`, `outDir: "dist-test"`, `include: ["src/**/*.ts","tests/**/*.ts"]`, `declaration:false`, `declarationMap:false`.
- [ ] package.json scripts: `"build:test": "tsc -p tsconfig.test.json"`, `"test": "pnpm build:test && node --test dist-test/tests/**/*.test.js"`, `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit"`.
- [ ] `.gitignore`: node_modules, dist, dist-test, data, logs, reports, .scratch, *.log.
- [ ] Save spec verbatim to `docs/spec/kilo-bridge-v1-spec.md`.
- [ ] Smoke: one trivial test runs green via `pnpm test`; `pnpm build` green; commit.

### Task A2: Shared process runner
**Files:** Create `src/components/process.ts`, `tests/process.test.ts`.
**Interfaces:** `runProcess(cmd: string, args: string[], opts?: { cwd?: string; input?: string; timeoutMs?: number; env?: Record<string,string> }): Promise<ProcessResult>`; `ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }`. Uses cross-spawn (handles .cmd), explicit args, closes stdin when no input, `taskkill /F /T /PID` on timeout (win32), SIGKILL otherwise, code 127 on spawn ENOENT.
- [ ] Tests: echo via `node -e`; exit code propagation; stdin input; timeout kills tree (spawn node child that spawns child); nonexistent binary → 127; .cmd shim resolution (pnpm --version).

### Task A3: Persistence repair
**Files:** Modify `src/db.ts`; Create `tests/db.test.ts`.
- Persist-on-write: private `exec`/`run` wrappers call `fs.writeFileSync(dbPath, db.export())` after every mutation; public `persist()`; `close()` final persist.
- Top-level `import crypto from "node:crypto"`; remove `require` hack.
- Add `getTaskByProjectIssue(projectId, issueNumber)`, `insertAudit({projectId?, actor?, action, detail?})`, `listAudit(projectId?, limit?)`, `listTasksByStatuses(statuses[])`.
- Tests: CRUD round-trip for all entities; persistence across close/reopen (lease survives); migrations idempotent on reopen; audit insert/list; project+issue lookup.

### Task A4: Registry & config completion
**Files:** Modify `src/components/registry.ts`, `src/config.ts`, `src/types.ts`; Create `tests/registry.test.ts`, `examples/projects/*.json`.
- Types: add `advisoryCommands: string[]` (default []) and `integrationNote` optional to ProjectConfig; keep `verificationCommands` (required) and `conditionalVerification`.
- Registry: `validate` also checks `localPath` absolute, `worktreeRoot` absolute and NOT inside `localPath`, `repository` matches `owner/name` regex, `allowedAuthors` non-empty, `baseBranch` non-empty; `add` rejects duplicates; `enable`/`disable`/`inspect` exist.
- Templates: `ProjectRegistry.template(type)` returns full registration input; write matching JSON files under `examples/projects/` (node, laravel, django, odoo, flutter, scs-platform). Laravel/Django/Odoo templates must NOT auto-run installers/migrations as verification (spec §3: no auto package install/migrations) — verification commands are test/lint only (e.g. `php artisan test`, `python manage.py test`, `flutter analyze`, `flutter test`); Odoo: explicit empty + note requiring user configuration.
- `scsPlatform()` includes advisory `pnpm format:check` and conditional `pnpm --filter @scs/api test:coverage` (already present; keep).
- Tests: valid/invalid configs (bad id, relative paths, worktree inside repo, empty authors, bad repo), duplicate add, enable/disable/inspect, multi-project isolation, template validity for all 6 types.

### Task A5: Lifecycle repair
**Files:** Modify `src/components/lifecycle.ts`; Create `tests/lifecycle.test.ts`.
- `claimTask`: does NOT bump attempt (attempt starts at 1 on discovery); sets lease holder/expiry; idempotent re-claim by same holder with valid lease returns current; different holder with valid lease → fail LEASE_HELD; expired lease → allow reclaim.
- `beginCorrection(taskId)`: REPORT_READY/CHANGES_REQUESTED → attempt+1, status RUNNING via allowed path; preserves history.
- `recoverExpiredLeases(tasks, now)`: pure function returning tasks CLAIMED/RUNNING with expired lease; worker resets them to READY (with transition record) or FAILED after max attempts (3).
- Tests: every legal transition in spec §5; illegal transitions rejected; duplicate claim prevented; lease expiry/recovery; idempotency key stability; author validation; PR exclusion helper.

### Task A6: Security manager — real Kilo permission config
**Files:** Modify `src/components/security.ts`; Create `tests/security.test.ts`.
- `writeKiloPermissionFile(worktree, policy)` writes **`kilo.json`** (verified schema) into the worktree:
  - `permission.edit`: `{ "**": "allow", ".env*": "deny", "**/.env*": "deny", "**/secrets/**": "deny", "**/credentials/**": "deny", "**/*.pem": "deny", "**/*.key": "deny", "**/id_rsa*": "deny", "**/id_ed25519*": "deny", ".git/**": "deny", "**/node_modules/**": "deny" }`
  - `permission.read`: same deny patterns, `"**": "allow"`.
  - `permission.bash`: deny-by-default map `{ "*": "deny", "git status*": "allow", "git diff*": "allow", "git log*": "allow", "git show*": "allow", "ls*": "allow", "dir*": "allow", "cat *": "allow", "pnpm lint*": "allow", "pnpm typecheck*": "allow", "pnpm test*": "allow", "pnpm build*": "allow", "pnpm format*": "allow", "node --version": "allow", "git push*": "deny", "git commit*": "deny", "git merge*": "deny", "git reset*": "deny", "git checkout*": "deny", "git clean*": "deny", "*db:migrate*": "deny", "*db:seed*": "deny", "*db:reset*": "deny", "*infra:up*": "deny", "*infra:down*": "deny", "*kubectl*": "deny", "*docker*": "deny", "rm *": "deny", "del *": "deny", "rmdir *": "deny", "Remove-Item*": "deny", "gh *": "deny", "curl *": "deny", "wget *": "deny", "Invoke-WebRequest*": "deny" }` (explicit denies listed AFTER allows so order-based engines still deny; map semantics: most-specific pattern wins in opencode — denies are more specific).
  - `permission.external_directory: "deny"`, `webfetch: "deny"`, `websearch: "deny"`, `doom_loop: "deny"`.
  - `"$schema": "https://app.kilo.ai/config.json"`.
- `verifyEffectivePermissions(worktree)`: assert kilo.json exists, parse, assert every required denial present (edit/read/bash denies, external_directory deny); then run `kilo config check` (cwd=worktree) via process runner; refuse on error output/nonzero. Returns BridgeResult with detail.
- Keep `bridge.command-policy.json` writer + `isCommandDenied` + `isPathWithinWorktree` (make case-insensitive on win32, reject absolute targets outside root) + `redactSecrets` (fix SHA preservation: skip pure-hex 40/64 tokens).
- Tests: generated config contains all required denies; tampered config (bash allow) fails verification; path traversal (`..\\..\\x`, absolute external, case variations) rejected; redaction keeps 40-char SHA, redacts ghp_/sk- tokens; denied commands list.

### Task A7: Worktree manager repair
**Files:** Modify `src/components/worktree.ts`; Create `tests/worktree.test.ts` (fixture git repos in temp dir).
- Fix `show-ref --verify refs/heads/<b>` / `refs/remotes/origin/<b>` (use `--quiet`, exit-code based).
- `verifyOriginMatches(expected: string)`: normalize https/ssh URLs + `.git` suffix, compare `owner/name` case-insensitively.
- `hasUncommittedChanges()`, `getCurrentBranch()` for the user's main tree (read-only).
- `prepareTaskWorktree(issueNumber, attempt)`: fetch origin base → record baseSha → branch `prefix/issue-N[-attempt-K]` → dir under worktreeRoot (guarded: resolved dir must stay under root) → conflict → fail BRANCH_EXISTS/WORKTREE_EXISTS (never overwrite) → `git worktree add` → clean check. Returns `{branch, dir, baseSha}`.
- `collectChangeInventory(dir)`: `git diff --name-only HEAD` + `git ls-files --others --exclude-standard` (dedup); `collectDiff` uses `git diff HEAD` + untracked file list; `diffStats` via `git diff --stat HEAD`.
- Bridge-owned publishing ops: `commitAll(dir, message)` (`git add -A` + `git commit`), `pushBranch(dir, branch)` with guard rejecting `main`/`develop`/base/release names; `headSha(dir)`.
- Tests (real fixture repos): prepare creates isolated worktree at base SHA; main tree untouched (incl. dirty main tree); branch/worktree conflict → safe failure; inventory includes untracked; push guard rejects protected branches (no remote push in tests — guard unit-tested); origin match normalization.

### Task A8: Verification engine repair
**Files:** Modify `src/components/verification.ts`; Create `tests/verification.test.ts`.
- Remove bad type-only value imports; use process runner (cross-spawn) with per-command timeout (default 30 min, configurable) and tree kill.
- `commandsFromProject(config, worktree)`: tokenize configured strings (whitespace split honoring double quotes) → required commands; advisory → required:false; conditional → conditional:true with `conditionFiles` from config (default `apps/api/**`, `packages/**` for SCS coverage check). Never accepts commands from issue content.
- Prohibited check (db:migrate/seed/reset, infra:up/down) before spawn → recorded as failed with reason, never executed.
- `allRequiredPassed` unchanged semantics; results recorded with start/end/exit/duration/stdout/stderr paths.
- Tests: tokenizer quoting; conditional selection glob; prohibited command never spawns (assert via mock); failing command → passed:false; timeout kills; required coverage logic.

### Task A9: Report generator repair
**Files:** Modify `src/components/report.ts`; Create `tests/report.test.ts`.
- Report file per execution: `<taskId>/attempt-<n>-<executionId>.md` under reportsDir (never overwrite; assert exists → fail).
- `shouldBeComplete(results, requiredNames[])`: true only if every required name has a result with passed===true and no required failure.
- Markdown includes marker `[kilo-bridge-report]`, all spec §10 fields, compact summary top + evidence below; comment body likewise.
- Tests: no-overwrite across attempts; COMPLETE gating (failed required, missing required, advisory failure still COMPLETE-eligible); marker present; all sections rendered.

### Task A10: CLI & app facade completion
**Files:** Modify `src/cli.ts`, `src/app.ts`; Create `tests/cli.test.ts` (spawn built CLI against temp KILO_BRIDGE_ROOT).
- Global `--json` flag → structured output; default human-readable for status/tasks/task/logs/reports.
- Commands: init, doctor, configure (show + `configure set <key> <value>` for workerEnabled/pollIntervalMs/defaultTaskTimeoutMs with zod validation), start (persistent worker, graceful SIGINT), stop (writes stop signal / kills via lock pid), status (worker state + projects + task counts), projects list/add/validate/enable/disable/inspect/template, github bootstrap/test, tasks/task/logs/reports, worker start [--dry-run] [--project id] [--once] [--mock], verify --project id.
- doctor: node/git/gh(+auth)/kilo(+version)/sqlite checks; gh resolved via GH_BIN or `C:\Program Files\GitHub CLI\gh.exe` fallback; correct ok/fail aggregation.
- Tests: init creates dirs/db/config; projects add/validate/list/enable/disable round-trip via CLI; --json parseable; unknown command → exit 1 + message; worker start without enable → WORKER_DISABLED.

## Stage B — GitHub integration

### Task B1: GitHub provider repair (gh api transport)
**Files:** Modify `src/components/github.ts`; Create `tests/github.test.ts`, `tests/helpers/mock-gh.cjs`.
- All calls via process runner + `GH_BIN` (default `gh`, fallback to installed path if spawn 127).
- `authStatus()`: parse stdout+stderr for `Logged in as`; nonzero → unauthenticated.
- `listOpenIssues({labels})`: `gh api repos/{o}/{r}/issues?state=open&labels=...&per_page=100 --paginate` → normalize `{number,title,body,state,url,htmlUrl,author:user.login,labels:labels[].name,pullRequest:!!pull_request}`; filter PRs.
- `getIssue(n)`: `gh api repos/{o}/{r}/issues/{n}` normalized.
- `listComments(n)`: `gh api repos/{o}/{r}/issues/{n}/comments --paginate` → normalize; `isBridge` = body includes `[kilo-bridge-report]` marker ONLY.
- `addComment(n, body)`: write temp JSON `{body}` → `gh api repos/{o}/{r}/issues/{n}/comments --input <file>` → return real comment id.
- `ensureLabels`: one `gh api .../labels --paginate` listing; create missing via POST (name/color/description); idempotent.
- `addLabels`/`removeLabel`: `gh api -X POST .../issues/{n}/labels` with JSON input `{labels:[...]}`; `DELETE .../issues/{n}/labels/{name}` (404 tolerated).
- `createDraftPr({title,body,head,base})`: `gh pr create --draft --repo o/r --head b --base base --title t --body-file f` → parse URL.
- Rate limit: stderr match `rate limit|403|429` → code RATE_LIMITED; `getRateLimit()` via `gh api rate_limit`.
- Mock gh: Node script dispatching on argv, fixture-driven via env `MOCK_GH_FIXTURES` (JSON file); records calls to `MOCK_GH_CALLS` file.
- Tests: auth success/failure; issue normalization + PR exclusion; unauthorized author filtered at worker level; comment id returned; marker-only bridge detection; label create/idempotent; rate-limit classification; draft PR args (never merge).

### Task B2: Bootstrap & readiness
- `github bootstrap <project>`: auth check + ensureLabels + repo access check (`gh api repos/{o}/{r}` → permissions). `github test`: auth + rate limit.
- Readiness gate in app: `workerEnabled` config + gh authenticated + project active + (real mode) kilo detected + permission verification capability. Dry-run/mock bypass kilo only.
- Real verification after user's `gh auth login`: `github test scs-platform` + `github bootstrap scs-platform` (creates 10 labels on nabeel2323/scs-platform).

## Stage C — Simulated Kilo execution (mocked end-to-end)

### Task C1: Worker pipeline
**Files:** Create `src/components/worker.ts`; Modify `src/app.ts`; Create `tests/worker.test.ts`, `tests/helpers/mock-kilo.cjs`, `tests/helpers/fixtures.ts`.
- `Worker` class: deps-injected (store, registry, githubFactory, kiloFactory, worktreeFactory, security, verification, reports, logger, config).
- `pollOnce(project)`: readiness → ensureLabels → listOpenIssues(kilo:ready) → for each: skip PRs, validate author, idempotency (sha256 project:issue), create task READY → claim (lease 10 min) → GitHub label claimed/running → prepareTaskWorktree → write kilo.json + command policy → verifyEffectivePermissions (skipped only in mock mode) → run Kilo (mock or real) → collect inventory/diff → run verification suite → generate+store report → post comment → labels report-ready → transition REPORT_READY. Failures → BLOCKED/FAILED with report + labels. Lease released in finally.
- `runForever()`: interval poll (config), worker.lock singleton (pid + heartbeat; stale lock takeover), stop-file graceful shutdown, lease recovery on start, persist after each step.
- Mock kilo: emits NDJSON operational events + final response, creates/edits a file in --dir, exits 0/1/timeout per fixture env.
- E2E test (mock gh + mock kilo + fixture repo): full READY→…→REPORT_READY; report comment posted with marker; labels transition; worktree preserved; main tree untouched; duplicate issue not re-executed; unauthorized author rejected; PR skipped; verification failure → PARTIAL/FAILED not COMPLETE.

### Task C2: Follow-up & correction flow
- Worker scans tasks REPORT_READY with GitHub label `kilo:changes-requested`: listComments after lastCommentId, authorized authors only, ignore bridge marker; new attempt (attempt+1, new branch suffix, new worktree), previous reports preserved; correction instruction = original spec + new comments; re-verify; new report; labels back to report-ready.
- Tests: unauthorized comment ignored; bridge comment ignored; attempt chain linked; old report intact.

### Task C3: Controlled publishing
**Files:** Create `src/components/publishing.ts`; tests in `tests/publishing.test.ts`.
- Trigger: authorized `kilo:publish-approved` label + project.publishingEnabled + task REPORT_READY.
- Steps: validate branch/worktree → prohibited-file scan (`.env*`, secrets, keys, bridge config) → verification policy re-check (required passed in latest execution) → Bridge `git add -A && git commit` → push feature branch only (guard) → `gh pr create --draft` targeting config.baseBranch → comment PR URL → label published → transition PUBLISHED. Never merge/push base/deploy.
- Tests: disabled by default; unapproved label ignored; prohibited file blocks; failing verification blocks; draft PR targets develop not main; push guard; full mock happy path.

### Task C4: Recovery & concurrency
- Tests: expired lease recovered to READY and re-executed once; two workers → second exits (lock); crash mid-run (persisted lease) → recovery; max-attempts → FAILED.

## Stage D — Real Kilo execution

### Task D1: Kilo adapter repair
**Files:** Modify `src/components/kilo.ts`; Create `tests/kilo.test.ts` (mock executable).
- Fix double-bin args; probe cwd = existing dir; close stdin; capture sessionId (`session_id`/`sessionID`/`data.session_id`); final response = last assistant text part (skip reasoning/thinking parts); SHA-safe redaction; timeout tree-kill; `--format json --dir --title` + positional spec; `--model/--agent` only when configured AND validated available (`kilo models`, `kilo agent list`); `--auto` only after permission verification passes.
- `preflight()`: detectExecutable → readHelp → assert required options exist in installed help → validateAuth (`kilo auth list` non-empty) → model/agent availability when configured.
- Tests: args built safely (spec with quotes/`;`/`$()` passed as single arg); event parsing; session capture; reasoning excluded from stored log; timeout; exit code; auth failure.

### Task D2: Real harmless execution
- Disposable fixture repo under `C:\TAIF\KILO-BRIDGE\.scratch\real-demo` (NOT SCS): task "create hello.txt with content hello-kilo". Real `kilo run --auto --format json` in its worktree with generated kilo.json; `kilo config check` must pass first; verify file created, main tree untouched, report generated. If Kilo auth/model fails → report outstanding, do not fake success.

## Stage E — SCS Platform registration

- Register from `examples/projects/scs-platform.json` via CLI; validate: repo exists, origin matches, gh auth, fetch origin develop, record SHA, local path exists, main-tree dirty state recorded (read-only). Bootstrap labels (requires user auth). Worker remains DISABLED pending manual review (spec). Output validation report.

## Documentation (spec §17)

`README.md` + `docs/`: architecture.md, installation.md, windows-configuration.md, github-authentication.md, kilo-cli-integration.md, multi-project-registration.md, task-lifecycle.md, security-model.md, operations-manual.md, recovery-troubleshooting.md, developer-guide.md, testing-guide.md, release-notes.md. Document actual behavior; mark outstanding items accurately.

## Final Verification (Definition of Done)

Build green; `pnpm test` green; persistence verified; SCS config validates; gh auth verified (user-dependent); labels initialized; test issue discovered+claimed (real repo, harmless test issue created by authorized user or via gh with user consent); mock run completes; verification stored; report published; unauthorized rejected; publishing approval enforced; worktree isolation proven; multi-project registry works; docs complete. Real Kilo run demonstrated or reported outstanding. Produce `docs/e2e-test-report.md` with evidence per item.

## Assumptions

- User completes `gh auth login` (in progress). If not authenticated by Stage B verification, real-GitHub items are reported outstanding.
- Real Kilo execution uses the user's authenticated Kilo Gateway; a harmless demo task is run in a disposable fixture repo, never SCS.
- Bridge local git repo initialized for change tracking (no remote).
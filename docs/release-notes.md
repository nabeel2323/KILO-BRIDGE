# Release Notes — Kilo Bridge V1.0.0

**Release date:** 2026-11-12
**Status:** Feature-complete V1. Automated suite green. Real Kilo execution demonstrated. **GitHub authentication is the one outstanding manual step** before live GitHub task processing can be verified end-to-end.

## What V1.0.0 delivers

A configuration-driven, multi-project coordinator that connects ChatGPT-authored GitHub issues to the local Kilo Code agent, with independent verification, controlled publishing, and persistent recovery — all on Windows, with no public server, tunnel, or webhook.

- **12 independent components** (registry, GitHub provider, lifecycle, worker, Kilo adapter, worktree, security, verification, report, SQLite, CLI, logging) plus publishing and a shared process runner.
- **Full CLI** (`init`, `doctor`, `configure`, `start`, `stop`, `status`, `projects`, `github`, `tasks`, `task`, `logs`, `reports`, `worker`, `verify`) with human and `--json` output.
- **Deny-by-default security** with two-sided permission verification before any autonomous run.
- **Git worktree isolation** per task/attempt; the user's main tree is never modified.
- **Independent verification** (required / advisory / conditional) — agent results are never trusted.
- **Per-execution reports** posted as issue comments; COMPLETE is gated on passing required verification.
- **Controlled publishing** (disabled by default; draft PRs only, never merge/push protected branches).
- **Persistent SQLite** with persist-on-write, leases, idempotency, and crash recovery.
- **PowerShell scripts**: `install.ps1`, `doctor.ps1`, `start-worker.ps1`, `stop-worker.ps1`.
- **Complete documentation suite** (14 guides) and an end-to-end test report.

## Verification results

- **Build:** `pnpm build` and `pnpm build:test` succeed (strict TypeScript, Node16).
- **Automated tests:** **131 / 131 passing** across 15 files (`pnpm test`), including 15 end-to-end worker lifecycle tests and a two-project isolation test.
- **Real Kilo execution (Stage D): COMPLETE.** A real `kilo run` produced `hello.txt` with content `hello-kilo` in an isolated worktree; independent verification passed; the main tree was untouched.
  - Session: `ses_e2f7f7ab5ffeAaygWaSszBNkJI`, exit 0, ~46 s.
  - Model: **`kilo/kilo-auto/free`** (see "Known limitations" below).
- **SCS Platform (Stage E):** registered and validated. Origin matches `nabeel2323/scs-platform`, `origin/develop` fetched, base SHA `a85d201c42fca6b84d952a2417ba88d87bdefa99` recorded, current branch `feature/buyer-staging-deployment-remediation` and its uncommitted changes left untouched.

## Outstanding (requires manual configuration)

These are **not** claimed as verified. They are blocked on a single manual step:

1. **GitHub authentication** — `gh auth login` has not been completed on this machine. Until then:
   - `github test` / `github bootstrap` cannot run against the live repository.
   - The ten `kilo:*` labels cannot be created on `nabeel2323/scs-platform`.
   - A real test issue cannot be discovered/claimed/reported end-to-end.
   - The corresponding logic **is** fully implemented and covered by mock-based end-to-end tests; only the live confirmation is pending.
2. **Worker enablement** — intentionally left **disabled** (`workerEnabled=false`) pending manual security review and explicit enablement (spec §16).

## Known limitations

- **Kilo model credits:** the Kilo Gateway account has **zero credits** (paid models → HTTP 402) and the default NVIDIA provider model returns HTTP 404. Real execution currently requires a free model (`kilo/kilo-auto/free`) or added credits / a configured working provider. Set per project via `kiloModel`.
- **Worktree isolation is not an OS sandbox.** For production, run the worker under a dedicated standard Windows account.
- **Transport is polling**, not live streaming. No webhook/tunnel/public endpoint by design.

## Upgrade / first-run notes

- Run `.\scripts\install.ps1`, then `.\scripts\doctor.ps1`.
- Authenticate (`gh auth login`), register a project, bootstrap labels, review the security model, then explicitly enable the worker.
- See [installation](installation.md) and [operations manual](operations-manual.md).

## Definition of Done

See [e2e-test-report.md](e2e-test-report.md) for the item-by-item mapping with evidence. Items dependent on GitHub authentication are marked **OUTSTANDING** rather than claimed.
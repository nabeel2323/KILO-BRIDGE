# Kilo CLI Integration Guide

The Bridge drives the Kilo Code CLI (`@kilocode/cli`) as a child process. It never embeds an SDK and never trusts the agent's own account of what it did — the Bridge independently verifies the result.

## Verified against the installed CLI

All behavior below was validated against **Kilo CLI 7.8.27** (the version installed on this machine), not assumed from documentation:

- `kilo run` accepts `--auto`, `--format`, `--dir`, `--title`, `--model`, `--agent`.
- **All options must precede the positional task message.** Kilo uses a variadic positional argument; anything after the first positional is consumed as message content. The adapter builds argv accordingly.
- `kilo run --help` prints its banner to **stderr**. The adapter reads both streams when validating options.
- The permission schema is `permission` (per-tool rules), verified against `https://app.kilo.ai/config.json`.

## Preflight (before any real execution)

`KiloCliAdapter.preflight()` runs, in order, and refuses execution on any failure:

1. **Detect** — `kilo --version` (exit 127 → `KILO_NOT_FOUND`).
2. **Help/option validation** — `kilo run --help`; confirms `--auto`, `--format`, `--dir`, `--title` are present (`KILO_OPTIONS_MISSING` otherwise).
3. **Auth** — `kilo auth list`; rejects "0 credentials / not logged in" (`KILO_AUTH_FAILED`).
4. **Model** (if configured) — `kilo models`; the configured `kiloModel` must be listed (`KILO_MODEL_UNAVAILABLE`).
5. **Agent** (if configured) — `kilo agent list`; the configured `kiloAgent` must be listed (`KILO_AGENT_UNAVAILABLE`).

Preflight runs only in **real** mode. Mock and dry-run modes skip it.

## Execution

```
kilo run --auto --format json --dir <worktree> --title "GitHub Issue #N" [--model M] [--agent A] "<task spec>"
```

- Spawned via `cross-spawn` with an **explicit argv array** — the task spec is a single positional argument, never interpolated into a shell string.
- `cwd` is the isolated worktree, never the user's main checkout.
- `--auto` is passed **only after** the worktree's deny-by-default permission config has been written and verified (see [security model](security-model.md)). `--auto` auto-approves anything not explicitly denied, so explicit denials are mandatory.
- Timeout: project `taskTimeoutMs`, else `defaultTaskTimeoutMs` (default 6 h). On timeout the whole process tree is killed (`taskkill /F /T` on Windows) and the execution is marked `TIMEOUT`.

## Output capture

- stdout is parsed line-by-line; each JSON line is an event. Non-JSON lines are ignored.
- **Session id** is extracted from `session_id` / `sessionID` / `properties.info.id` / `properties.part.sessionID`.
- **Final response** is the last assistant text part. **Reasoning / thinking / chain-of-thought parts are never stored.**
- The operational event log (reasoning filtered out, secrets redacted) is written to `<worktree>/.kilo-bridge/kilo-events-<ts>.json`.
- stdout/stderr returned to the worker are passed through secret redaction.

## Model selection and credits

The model is set per project via `kiloModel`. On this machine:

- The **Kilo Gateway** account currently has **zero credits** — paid models return HTTP 402 ("Paid Model – Credits Required").
- The default **NVIDIA** provider model returns HTTP 404 ("Function not found for account").
- The free model **`kilo/kilo-auto/free`** works and was used for the successful Stage D real-execution demo.

To run real tasks, either add credits to the Kilo Gateway account or configure a working free/local model:

```powershell
# per-project (edit the project config, then re-register), e.g. "kiloModel": "kilo/kilo-auto/free"
node dist/cli.js projects add examples/projects/scs-platform.json
```

List what your account can actually use:

```powershell
kilo models
kilo auth list
```

## Executable resolution

`kilo` is an npm `.cmd` shim. The Bridge resolves it with `cross-spawn` (no shell). Override with `KILO_BIN` if it is not on PATH:

```powershell
$env:KILO_BIN = "C:\Users\<you>\AppData\Roaming\npm\kilo.cmd"
```

## What Kilo is never allowed to do

The worktree permission config explicitly denies `git push`, `git commit`, `git merge`, `git reset`, `git checkout`, `git clean`, database migrations/seeds/resets, infra up/down, `gh`, docker, kubectl, network fetchers, and shells. Publishing (commit/push/draft PR) is performed **only by the Bridge**, only after explicit approval. See [security model](security-model.md).
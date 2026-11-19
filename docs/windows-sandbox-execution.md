# Windows Sandbox Task Execution

## Purpose

The generalized runner executes one Bridge task inside a disposable Windows Sandbox guest. It is used by the dedicated GitHub intake dispatcher and has no fallback to the host Kilo CLI.

This document describes the implemented source contract and its remaining runtime acceptance requirement. It is not a declaration that the generalized runner has already completed a task on the operator's machine.

## Preconditions

The runner requires:

- Windows with the Windows Sandbox feature enabled.
- An interactive desktop session (the readiness check looks for the Windows Explorer session).
- A configured standalone kilo.exe executable. It must be an existing absolute-path regular file; a .cmd shim is not accepted.
- A provider base URL using HTTPS, or HTTP only for 127.0.0.1 / localhost.
- A provider model ID and, when authentication is required, an environment variable containing the API key in the Bridge process.
- sandboxExecutionEnabled=true for actual execution.
- For autonomous intake, githubIntakeEnabled=true, ghEnabled=true, kiloEnabled=true, a trusted repository, active project mapping, and allowed Issue author.

Fresh-install defaults keep sandboxExecutionEnabled, githubIntakeEnabled, and workerEnabled false and the trusted repository list empty.

## Three-folder data exchange

A per-execution directory is created below data/sandbox-runs/<executionId>. The runner writes a Windows Sandbox configuration (.wsb) and maps:

1. Inbox (read-only): standalone kilo.exe, Node runtime, generated Kilo config, provider bridge, filtered project payload, and task specification.
2. Outbox (read/write): provider request envelopes, Kilo operational logs, guest result manifest, and changed output files.
3. Provider responses (read-only): host-authored response stream files. This directory is separate from the writable outbox so guest code cannot alter host response data.

The guest uses a loopback HTTP provider bridge. Requests are written to the outbox; the Bridge process validates and forwards each request to the configured upstream provider; responses are written to the separate read-only response mapping. Guest networking remains disabled.

The provider key stays in the Bridge process environment. It is never serialized into the guest Kilo config, task payload, provider bridge script, or durable operational evidence. The configured upstream request rejects redirects.

## Worktree staging and artifact policy

The runner stages the task worktree rather than the operator's main checkout. It refuses symbolic links and bounds the staged file count and total bytes. Git metadata, dependency folders, Kilo/Bridge internals, and sensitive configuration/credential/key material are omitted or rejected.

The guest receives the Issue title/body as untrusted task content and explicit execution boundaries. It must work only in its isolated workspace and must not commit, push, merge, publish, deploy, run database migrations/resets/seeds, or read/write credentials.

A completed guest manifest is accepted only when its protocol version and execution UUID match, required guest/provider/Kilo stages succeeded, the Kilo exit code is zero, native tool-call evidence is present, and all artifact declarations are valid. Artifact paths must be relative and non-sensitive. Added/modified files must match their declared SHA-256 digest and byte size.

The host validates the entire artifact set before changing the worktree. It prepares temporary files and backups outside guest-mapped folders, applies the changes, and attempts rollback if an application step fails. If rollback itself is incomplete, recovery data is retained under data/sandbox-recovery.

## Durable evidence and cleanup

Bounded operational evidence is stored at data/sandbox-evidence/<executionId>.json. It includes stage names/timestamps, execution identity, Kilo version/exit code, provider request count, tool names/event types, artifact actions/hashes/sizes, validation errors, and sanitized errors. It intentionally excludes prompts, provider request bodies, credentials, raw Kilo stdout/stderr, and reasoning.

Temporary run folders are cleaned after the host has collected the manifest and imported valid artifacts. Cleanup failure is reported in the result and prevents the worker from treating the execution as successful. An incomplete manifest, missing native-tool evidence, mismatched UUID, non-zero exit code, invalid artifact, or failed cleanup is not a successful Sandbox task.

## Current enforced limits

- Task title: 256 characters.
- Task body: 48 KiB.
- Staging: 30,000 files and 2 GiB.
- Guest provider requests: 128 maximum, 8 MiB per request.
- Provider response: 128 MiB per response and 256 MiB total per execution.
- Provider request timeout: 15 minutes.
- Task timeout: bounded to 30 seconds minimum and 6 hours maximum, plus launcher allowance.

## Operator configuration

Use the authenticated local Control Center Settings page to configure the standalone kilo.exe path (or clear it to use KILO_SANDBOX_EXE), OpenAI-compatible provider base URL and model ID, and API-key environment-variable name/header/prefix.

The Control Center never accepts the API-key value. Set the secret in the Windows environment used by the Bridge process and restart the process so it is available. The settings read model returns only whether the environment variable is present; it does not return the value or the full executable path.

Provider URL validation rejects embedded credentials, query strings, fragments, non-HTTPS URLs (except loopback HTTP), and invalid API-key header/prefix values.

## Verification status and release gate

Source, generated WSB XML, provider bridge JavaScript, manifest/path checks, fail-closed gate behavior, claim-bound lifecycle, and Control Center settings are covered by Windows CI.

Real guest runtime acceptance remains outstanding. Current CI does not provision the operator's Kilo executable, upstream provider credentials, or interactive Windows Sandbox session. The generalized runner must still complete a one-time verification task in a disposable workspace on the operator's actual Windows machine. Until an operator-facing verification/attestation workflow is implemented and that verification succeeds, keep sandboxExecutionEnabled=false and githubIntakeEnabled=false. Do not edit configuration manually to bypass this release gate.

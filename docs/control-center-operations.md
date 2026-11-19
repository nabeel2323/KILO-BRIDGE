# Control Center Operations

## Scope

The Kilo Bridge Control Center is an authenticated browser interface served by the local Bridge process. It binds to IPv4 loopback only, reads actual Bridge database/configuration state, exposes audited operator settings, and provides explicit Start/Stop controls for the dedicated GitHub intake service.

The dedicated intake service uses durable GitHub claims and a claim-bound Windows Sandbox dispatcher. It does not use generic worker polling and never falls back to host Kilo. The dispatcher continues through Bridge worktree, security, verification, report, and GitHub feedback lifecycle. Dedicated intake does not approve publication, push, merge, or deploy.

**Current release gate:** the operator-hosted one-time verification and signed attestation workflow is implemented in source. It has not yet completed on the operator's actual Windows Sandbox. Keep all execution gates off until the Settings action succeeds on that machine and the local attestation status is VALID.

## Requirements

- Supported Node.js runtime and a locally initialized Bridge directory.
- Permission to create files under the Bridge data directory.
- Windows host with an interactive desktop and Windows Sandbox for future guest acceptance.
- Browser on the same Windows machine.

## First-time setup

Run in PowerShell from the Kilo Bridge repository:

    pnpm run build
    node .\dist\cli.js init
    node .\dist\cli.js control-center setup

The setup command prints a high-entropy, one-time bootstrap token. The Bridge stores only its SHA-256 digest. Use the token once in the browser to configure a strong local password (minimum 14 characters).

Start the Control Center:

    node .\dist\cli.js control-center start

Open the loopback URL printed by the command (default port 4190). Keep the terminal open; Ctrl+C stops the server. Use another local port when required:

    node .\dist\cli.js control-center start 4191

Set KILO_BRIDGE_ROOT before running the commands when using a non-default Bridge root.

## Security model

- Server binding is exactly 127.0.0.1; non-loopback peers and unexpected Host headers are rejected.
- Browser POST requests require same-origin Origin and per-session CSRF validation.
- One-time setup token is high entropy and stored only as a digest. Passwords use scrypt with random salt.
- Session IDs are random and held server-side in memory; they expire and are invalidated by server restart.
- Session cookies are HttpOnly and SameSite=Strict. The loopback server uses HTTP, so Secure cookie is not set.
- CSP and other security headers are applied; request bodies are bounded; login attempts are throttled.
- The UI omits local paths, worktree paths, claim tokens, raw audit details, and API-key values.
- GitHub task content is rendered as escaped text and is untrusted input.
- Settings changes use a cross-process config lock and atomic same-directory replacement. Changes are audited.
- Authenticated SSE sends a change notification and current operational revision; reconnecting clients reload an authoritative database-backed snapshot.

Protect data/control-center-auth.json and the Bridge data directory with appropriate Windows account ACLs. Never share the bootstrap token.

## Browser areas

- Overview: feature gates, actual project/task/claim counts, worker state, and recent tasks.
- Projects: registered project/repository identity, state, and allowed authors; local paths are omitted.
- GitHub intake: dispatcher readiness, trusted repositories, durable claim queue, and Start/Stop controls.
- Tasks/executions: task body, lifecycle, execution summary, verifications, and reports.
- Review: report-ready, blocked, failed, and correction states; it does not grant publication approval.
- Activity/audit: operator actions and timestamps.
- Settings: provider/runtime configuration, trusted repository list, polling interval, prerequisite switches, signed runtime-attestation status, and staged execution-gate controls.

The page refreshes the current authoritative view when SSE reports an operational change. It also supports manual refresh; missed SSE events are not replayed as historical audit events.

## Preparing the Sandbox runtime

The Settings page accepts non-secret configuration:

- Standalone Kilo executable path. It must be an existing absolute-path regular .exe; a .cmd shim is not accepted. Only its filename is returned in the read model.

### Identify the installed Kilo command

Run this in PowerShell from the Windows machine that runs Kilo Bridge:

```powershell
$kiloCommand = Get-Command kilo -ErrorAction Stop
$kiloCommand | Format-List Name,CommandType,Source,Path,Definition
where.exe kilo
kilo --version
```

The Phase 3.3 runtime report records Kilo CLI version `7.8.27`. Compare the version printed by the actual executable you intend the Sandbox to run with that accepted host version and record any difference before attesting.

The Sandbox setting must point to a **standalone `kilo.exe`**, not an npm-generated `kilo.cmd` shim. Check the resolved path:

```powershell
$kiloPath = $kiloCommand.Source
if (-not $kiloPath -or [System.IO.Path]::GetExtension($kiloPath) -ine ".exe") {
    throw "The 'kilo' command is a shim or script, not a standalone kilo.exe."
}
& $kiloPath --version
Get-FileHash -LiteralPath $kiloPath -Algorithm SHA256
```

When the command resolves to `.cmd` or another script, obtain the standalone Windows CLI archive from the [official Kilo CLI documentation](https://kilo.ai/docs/code-with-ai/platforms/cli) and [Kilo releases](https://github.com/Kilo-Org/kilocode/releases). Extract it to a dedicated tools folder outside the Bridge repository, for example:

```powershell
$installRoot = "C:\Tools\Kilo\standalone"
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
# Extract the downloaded official Windows x64 ZIP into $installRoot first.
$kiloPath = Join-Path $installRoot "kilo.exe"
if (-not (Test-Path -LiteralPath $kiloPath -PathType Leaf)) {
    throw "kilo.exe was not found in the extracted archive."
}
& $kiloPath --version
Get-FileHash -LiteralPath $kiloPath -Algorithm SHA256
```

Use the full absolute path to that `kilo.exe` in **Settings → Sandbox runtime → Standalone Kilo executable path**. Do not commit the binary to Git, place it in the project worktree, or point the setting at `npm.cmd`, `pnpm.cmd`, or a wrapper script. The attestation binds to the executable's hash and version, so replacing or updating it requires a fresh attestation.
- OpenAI-compatible provider base URL and upstream model ID.
- API-key environment-variable name, header, and prefix. The API key value is never accepted by the UI or stored in bridge.config.json.
- GitHub and Kilo prerequisite toggles.
- Trusted repository allowlist and polling interval.

The API-key value must be provisioned in the environment of the Bridge process and the Bridge restarted after it changes. The UI only reports whether the named environment variable is present. If the custom Kilo path field is blank, the current setting is preserved; use the clear-path checkbox to remove it and fall back to KILO_SANDBOX_EXE.

Provider URLs must use HTTPS, except HTTP on 127.0.0.1 or localhost; embedded credentials, query strings, and fragments are rejected. The host relay refuses redirects.

### One-time runtime verification

After configuring the executable, provider URL/model, and API-key environment-variable name, make sure `workerEnabled`, `sandboxExecutionEnabled`, and `githubIntakeEnabled` are all false and stop any running intake service. Then select **Run one-time Sandbox verification** in Settings.

Before starting the guest, the attestation service acquires three locks: its own verification lock, the same cross-process `data/github-intake.lock` used by `GitHubIntakeService.pollOnce`, and `bridge.config.json.lock`, the shared configuration-write lock used by the CLI and Control Center. If another Bridge process is in an active poll/dispatch or config update, verification is refused. If a continuous poller is between ticks, the shared intake lock prevents its next poll from claiming or dispatching while the guest runs; the persistent execution gates remain off, so the poller stops on its next configuration check. The configuration lock prevents supported settings updates from changing provider/gate state mid-run. All locks are held until guest cleanup and post-run identity validation finish. An out-of-band manual file edit is still detected by the final config/runtime re-read and prevents signing.

The Bridge creates a disposable empty workspace under `data/sandbox-runtime-verification`. It uses an in-memory runner configuration that temporarily sets only `sandboxExecutionEnabled=true`; it does not change `bridge.config.json`. The guest is asked to write one execution-ID/nonce-bound marker using Kilo's native `write` tool. Acceptance requires a matching execution UUID, successful guest/provider/Kilo stages, zero Kilo exit code, at least one upstream provider request, a native write-tool event, exact marker content, a matching artifact SHA-256/size declaration, the runner's bounded evidence file, and complete cleanup.

On success, the Bridge writes an HMAC-signed local attestation with a 24-hour expiry. The signing key is stored separately under `data`. The attestation contains no task prompt, nonce, provider request body, API-key value, or raw Kilo output. It is bound to the Kilo/Sandbox executable hashes and versions, provider URL/model, API-key environment-variable name/header/prefix, a local-keyed HMAC of the current API-key value, Node/OS identity, and runner contract hash. The API-key value and a plain unsalted hash are never written to the attestation. Rotating the provider key invalidates the proof even when the environment variable name and presence remain unchanged. A missing/invalid signature, expiry, key rotation, or runtime fingerprint change requires a new verification. A still-valid attestation is not run again unnecessarily. Runtime-bound executable/provider settings can only be changed while both dedicated execution gates are off; a request cannot combine a provider change with Sandbox/intake activation. After changing those settings, run a new verification before re-enabling Sandbox.

## Execution gates and automatic intake

| Gate | Purpose | Fresh-install default |
|---|---|---:|
| workerEnabled | Existing generic worker | false |
| sandboxExecutionEnabled | Generalized Windows Sandbox task execution | false |
| githubIntakeEnabled | Dedicated autonomous GitHub Issue discovery | false |

The repository allowlist defaults to empty; this trusts no repository. ghEnabled and kiloEnabled are prerequisites, not automatic execution gates.

The dedicated intake path checks both intake and Sandbox gates plus the current signed runtime attestation before GitHub discovery and dispatch. It re-reads live config and revalidates the attestation on every readiness/dispatch check. Expiry or runtime drift makes dispatcher readiness false. The dispatcher constructs its Worker with `workerEnabled=false`; a dedicated task can execute only through the Sandbox runner.

The Settings workflow has three separate steps:

1. **Verify:** run the one-time disposable Sandbox verification while all execution gates are off. Only a successful current attestation is accepted.
2. **Enable Sandbox:** after `runtimeAttestation.valid=true`, explicitly enable `sandboxExecutionEnabled`. This does not enable GitHub intake.
3. **Enable intake:** after Sandbox is already enabled, GitHub/Kilo prerequisites are enabled, at least one trusted repository is configured, and dispatcher readiness is true, explicitly enable `githubIntakeEnabled`. Then use the separate GitHub intake **Start** control to begin polling. Enabling a gate never starts polling automatically.

The legacy `workerEnabled` gate cannot be enabled through this Control Center workflow. The API refuses enabling intake and disabling Sandbox in the same request, and requires intake to be disabled before Sandbox can be turned off. Do not edit the config file manually to bypass the attestation or activation rules.

Stop prevents new polling ticks; it does not forcibly terminate an execution already running. Allow it to finish and reconcile its durable claim before restarting.

## Current verification

Windows CI run [44436858231](https://github.com/nabeel2323/KILO-BRIDGE/actions/runs/44436858231) on source commit `b652fdeb13e220776add26a0a6225300da7bae87` passed dependency installation, source/test TypeScript checking, build, and the complete suite: **307 tests, 302 passed, 0 failed, 5 skipped**. It includes the version-2 HMAC provider-credential binding and provider-key rotation regression.

The tracker-inclusive follow-up run [44437249678](https://github.com/nabeel2323/KILO-BRIDGE/actions/runs/44437249678) on commit `ec93d0954e4daef94a69e7f3742afa4638814921` also passed dependency installation, TypeScript, build, and all tests with the same totals. A later progress-tracker-only commit reconciled the documentation status; it did not alter runtime source.

These are code-level CI results only. They do not demonstrate that the generalized runner completed a real task inside the operator's Windows Sandbox guest or that the local browser interface has been accepted on the operator's machine.

## Troubleshooting

### Authentication or origin error

Use the exact loopback URL printed by the Control Center, including its port. A different hostname or remote interface is intentionally rejected.

### Lost setup token

Before password configuration, run control-center setup again to rotate the one-time token. Once a password is configured, the setup command will not reset it. Account-recovery tooling is not currently available; do not manually edit the auth JSON.

### Runtime attestation is invalid or requires retest

Check the reason shown in Settings. Common causes include missing Windows Sandbox feature/interactive desktop, missing standalone `kilo.exe`, invalid provider URL/model, missing API-key environment variable, expired 24-hour attestation, or a changed runtime fingerprint. Keep gates off, correct the prerequisite, and run the one-time verification again. If a previous verification failed, inspect the bounded evidence file under `data/sandbox-evidence`; do not manually create or edit an attestation file.

### Intake cannot start

Inspect Settings and the intake status reason. Preconditions include a current valid runtime attestation, both dedicated gates, GitHub/Kilo prerequisites, non-empty repository trust, exactly one active project mapping, allowed authors, GitHub authentication, Windows Sandbox readiness, a standalone executable, and valid provider settings.

### Task/claim missing or uncertain

Confirm the same KILO_BRIDGE_ROOT is used by the operator CLI and Control Center. For RECONCILIATION_REQUIRED, inspect the claim, task, execution/evidence file, and matching GitHub Issue labels/comments. Never reset the task or replay a potentially started execution simply to clear the status.

See Windows Sandbox Task Execution, Recovery & Troubleshooting, and the implementation tracker.

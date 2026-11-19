# Control Center Operations

## Scope

The Kilo Bridge Control Center is an authenticated browser interface served by the local Bridge process. It binds to IPv4 loopback only, reads actual Bridge database/configuration state, exposes audited operator settings, and provides explicit Start/Stop controls for the dedicated GitHub intake service.

The dedicated intake service uses durable GitHub claims and a claim-bound Windows Sandbox dispatcher. It does not use generic worker polling and never falls back to host Kilo. The dispatcher continues through Bridge worktree, security, verification, report, and GitHub feedback lifecycle. Dedicated intake does not approve publication, push, merge, or deploy.

**Current limitation:** the generalized Sandbox runner has source, build, Windows CI, and regression-test coverage, but a real guest task has not yet been verified on the operator's Windows machine. The Control Center currently rejects attempts to enable execution gates until a real guest verification/attestation workflow has been implemented.

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
- Settings: provider/runtime configuration, trusted repository list, polling interval, prerequisite switches, and gate status.

The page refreshes the current authoritative view when SSE reports an operational change. It also supports manual refresh; missed SSE events are not replayed as historical audit events.

## Preparing the Sandbox runtime

The Settings page accepts non-secret configuration:

- Standalone Kilo executable path. It must be an existing absolute-path regular .exe; a .cmd shim is not accepted. Only its filename is returned in the read model.
- OpenAI-compatible provider base URL and upstream model ID.
- API-key environment-variable name, header, and prefix. The API key value is never accepted by the UI or stored in bridge.config.json.
- GitHub and Kilo prerequisite toggles.
- Trusted repository allowlist and polling interval.

The API-key value must be provisioned in the environment of the Bridge process and the Bridge restarted after it changes. The UI only reports whether the named environment variable is present. If the custom Kilo path field is blank, the current setting is preserved; use the clear-path checkbox to remove it and fall back to KILO_SANDBOX_EXE.

Provider URLs must use HTTPS, except HTTP on 127.0.0.1 or localhost; embedded credentials, query strings, and fragments are rejected. The host relay refuses redirects.

## Execution gates and automatic intake

| Gate | Purpose | Fresh-install default |
|---|---|---:|
| workerEnabled | Existing generic worker | false |
| sandboxExecutionEnabled | Generalized Windows Sandbox task execution | false |
| githubIntakeEnabled | Dedicated autonomous GitHub Issue discovery | false |

The repository allowlist defaults to empty; this trusts no repository. ghEnabled and kiloEnabled are prerequisites, not automatic execution gates.

The dedicated intake path checks both intake and Sandbox gates before GitHub discovery and re-reads live config on every poll. Disabling either gate, a prerequisite, or the allowlist stops future polling. The dispatcher constructs its Worker with workerEnabled=false; a dedicated task can execute only through the Sandbox runner.

**Do not enable an execution gate or start automatic intake yet.** Settings can prepare provider/runtime configuration and trusted repositories, and can switch gates off. The Settings API rejects attempts to switch workerEnabled, sandboxExecutionEnabled, or githubIntakeEnabled on until a real Sandbox guest verification/attestation path exists and has passed. Do not edit the config file manually to bypass this restriction.

Once that release prerequisite exists, the intended workflow is an explicit operator activation followed by an explicit Start automatic intake action. From then on eligible kilo:ready Issues are processed automatically; there is no per-Issue Run button.

Stop prevents new polling ticks; it does not forcibly terminate an execution already running. Allow it to finish and reconcile its durable claim before restarting.

## Current verification

Windows CI run 44431059408, commit d654e5f18c6e99ce136c613da727915cb21b7b17, passed dependency installation, source/test TypeScript checking, build, and the full test suite: **295 tests, 290 passed, 0 failed, 5 skipped**.

This result is code-level CI evidence. It does not demonstrate that the generalized runner completed a real task inside the operator's Windows Sandbox guest or that the browser has been visually accepted on the operator's machine.

## Troubleshooting

### Authentication or origin error

Use the exact loopback URL printed by the Control Center, including its port. A different hostname or remote interface is intentionally rejected.

### Lost setup token

Before password configuration, run control-center setup again to rotate the one-time token. Once a password is configured, the setup command will not reset it. Account-recovery tooling is not currently available; do not manually edit the auth JSON.

### Intake cannot start

Inspect Settings and the intake status reason. Preconditions include both dedicated gates, GitHub/Kilo prerequisites, non-empty repository trust, exactly one active project mapping, allowed authors, GitHub authentication, Windows Sandbox readiness, a standalone executable, and valid provider settings.

### Task/claim missing or uncertain

Confirm the same KILO_BRIDGE_ROOT is used by the operator CLI and Control Center. For RECONCILIATION_REQUIRED, inspect the claim, task, execution/evidence file, and matching GitHub Issue labels/comments. Never reset the task or replay a potentially started execution simply to clear the status.

See Windows Sandbox Task Execution, Recovery & Troubleshooting, and the implementation tracker.

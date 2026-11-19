# Control Center Operations

## Scope

The Kilo Bridge Control Center is an authenticated browser interface served by the local Bridge process. It is loopback-only, provides database-backed operational views, and supports a limited set of audited project/configuration updates. Its GitHub intake page exposes explicit Start and Stop actions for the dedicated intake service.

The service is connected to a claim-bound Windows Sandbox dispatcher and the existing Worker verification/report lifecycle. It does not use the generic worker polling loop and does not fall back to host Kilo. It does not approve publication, open pull requests, merge, or deploy. The generalized Sandbox runner has passed source, build, and Windows CI checks, but a real task execution by this generalized runner inside a Windows Sandbox guest has not yet been verified on the operator's machine.

## Requirements

- Node.js version supported by this Kilo Bridge release.
- A locally initialized Kilo Bridge directory.
- Permission to create files under the Bridge `data` directory.
- A browser on the same Windows machine.

## First-time setup

Run the following commands in PowerShell from the Kilo Bridge repository:

```powershell
pnpm run build
node .\dist\cli.js init
node .\dist\cli.js control-center setup
```

The setup command prints a high-entropy, one-time bootstrap token to the terminal. Copy it immediately. The Bridge stores only a SHA-256 digest of the token, not the plaintext value. The token is consumed when the local password is configured.

Start the Control Center:

```powershell
node .\dist\cli.js control-center start
```

Open the loopback URL printed by the command (default port 4190). On the first browser visit, enter the one-time setup token and choose a strong password of at least 14 characters.

Keep the terminal open while using the Control Center. Press Ctrl+C in that terminal to stop it.

A different port can be selected when needed:

```powershell
node .\dist\cli.js control-center start 4191
```

To use a non-default Bridge root, set `KILO_BRIDGE_ROOT` before running either command. The Control Center uses the same root as the Bridge database and configuration.

## Security model

- The server binds explicitly to `127.0.0.1`. Non-loopback binding is rejected by the server constructor.
- Requests with a non-loopback peer address or unexpected Host header are rejected.
- Browser POST requests must carry the exact same-origin Origin header.
- Authenticated state-changing requests must also include the per-session CSRF token.
- The first-run token is high entropy, one-time, and stored only as a digest.
- The local operator password is derived with Node.js scrypt and a random salt. The plaintext password is never written to disk.
- Session identifiers are random, held server-side in memory, and expire after eight hours. Restarting the server invalidates existing sessions.
- The authenticated /api/events SSE stream is read-only, limited to two connections per session, and closed when the operator logs out. It sends an initial operational revision snapshot, then revision-change notifications and keep-alive heartbeats.
- On initial connection or reconnect, the browser fetches the current database-backed view again. The SSE stream is a change-notification mechanism, not a durable event archive or substitute for the database task/audit history.
- Session cookies are HttpOnly and SameSite=Strict. The current server uses plain HTTP on loopback, so the Secure cookie attribute is not set; the listener is not exposed to LAN/public interfaces.
- Request bodies are limited to 64 KiB. Login attempts are rate-limited.
- CSP, frame denial, content-type sniffing protection, referrer restrictions, and a restrictive Permissions Policy are applied.
- Project local paths, worktree paths, credential fields, raw audit details, and claim tokens are not included in the UI read models.
- Task bodies and other GitHub-sourced task content are untrusted. The page renders them as escaped text rather than HTML.
- Configuration writes use a cross-process lock and atomic same-directory file replacement. CLI and Control Center setting updates use the locked read-modify-write helper.
- Project state changes and settings updates create audit records. Audit entries record changed setting names and counts, not submitted credentials or raw task bodies.

The authentication file is located at `data/control-center-auth.json`. Protect the Bridge data directory using the Windows account ACLs appropriate for the operator. Do not copy this file or share the bootstrap token.

## Implemented browser areas

- Overview: configured feature gates, projects/tasks/claim counts, worker heartbeat information, and recent persisted tasks.
- Projects: project identity, repository mapping, state, and allowed authors (filesystem paths are omitted).
- GitHub intake: durable claim records, trusted repository list, dispatcher readiness, and explicit Start/Stop controls. The page never starts polling merely by being opened or refreshed.
- Tasks & executions: task instructions, lifecycle transitions, execution summaries, and verification outcomes.
- Review center: tasks in report-ready, blocked, failed, correction, or publication-review states.
- Activity & audit: action, actor, project, and timestamp (raw audit detail is omitted).
- Settings: current gate values, trusted repository allowlist, and polling interval. Repository allowlist and polling interval can be updated and are audited.
- Project controls: an operator can enable or disable a registered project; the change is audited.

All displayed information is derived from the Bridge database, registry, and configuration file. The UI refreshes the current view when the authenticated SSE feed detects a change to the operational database watermark. Manual refresh remains available. Reconnection fetches a new authoritative snapshot; missed event notifications are not replayed as an audit history.

## GitHub intake operation and safety gates

The dedicated intake service is integrated with `KiloBridgeApp` and the Control Center. The GitHub intake page reports whether the intake gate is enabled, whether the service is running, whether the Sandbox dispatcher reports ready, and which repositories are trusted.

The Start action is explicit. It requires all of the following at start time:

- `githubIntakeEnabled=true` and `sandboxExecutionEnabled=true`.
- `ghEnabled=true` and `kiloEnabled=true`.
- At least one repository in `githubIntakeAllowedRepositories`, with an active registered project mapping and an allowed task author.
- Windows Sandbox enabled on the host, an interactive Windows desktop session, a configured standalone `kilo.exe`, and a valid OpenAI-compatible provider endpoint/model. The optional API key is read from the named environment variable in the Bridge process; the key itself is not stored in configuration or copied into the guest.

The service does not start automatically when the Bridge or Control Center starts. An operator must click **Start automatic intake** after all prerequisites are prepared. Once started, it polls at the configured interval and automatically processes eligible Issues bearing the ready label; there is no per-Issue Run Task action. The generic `workerEnabled` gate is independent and remains false for this dedicated path. The dispatcher constructs a Worker with its generic polling gate explicitly false and executes only a task already claimed by the intake owner.

**Do not enable the gates or start intake until the generalized Sandbox runner has completed a real guest execution on the operator's Windows machine using a disposable test repository and a controlled provider.** Hosted Windows CI validates the generated JavaScript, PowerShell bootstrap, WSB XML, TypeScript, build, and test suite; it does not prove the new runner has completed a real guest task. The gates remain false by default. The Control Center settings API currently rejects attempts to turn either execution gate on, while still allowing operators to turn them off and edit the trusted repository list/poll interval.

The Stop action stops future polling ticks; it does not forcibly terminate a task already in the middle of the Worker/Sandbox/verification/report lifecycle. Allow that execution to finish and reconcile its durable claim before restarting intake.

## Current limitations

- The generalized runner has not yet completed a real end-to-end task inside Windows Sandbox on the user's host.
- Browser-level acceptance on the user's local Windows browser has not been independently observed in this session.
- Review actions, publication approval, pull request creation, merge, and deployment are not available.

## Troubleshooting

### Browser displays an authentication error

Confirm the server is running in the terminal and use the exact loopback URL it printed, including its port. The Host and Origin checks intentionally reject alternate hostnames and remote access.

### Setup token is lost

Before a password is configured, run `control-center setup` again to rotate the one-time token. Once an account is configured, this command refuses to reset it. Account recovery/reset tooling is not part of the current milestone; do not manually edit the authentication JSON.

### Port is already in use

Start the server on another local port, for example `control-center start 4191`.

### Tasks or claims are missing

The Control Center reads the Bridge database under the selected `KILO_BRIDGE_ROOT`. Confirm that the same root is used by the CLI that registered the project or recorded the task. The server does not discover arbitrary GitHub repositories by browsing the UI.

### Start automatic intake is disabled

The intake gate or Sandbox execution gate is off, prerequisites are missing, the trusted repository allowlist is empty, or the Sandbox readiness check failed. Open the Settings and GitHub intake pages to inspect the reported reason. Do not switch gates on until a real generalized Sandbox guest execution has been verified on a disposable repository.

## Verification

Automated coverage is provided in `tests/control-center.test.ts` for bootstrap-token hashing/consumption, loopback binding, password/session setup, authentication, Origin/CSRF controls, database-backed read models, path omission, fail-closed automation gates, audited repository/polling settings, audited project-state changes, authenticated SSE snapshot/change notifications, and authenticated intake Start/Stop controls. The current Windows CI run `44425572765` passed the build and full suite: 291 tests, 286 passed, 0 failed, 5 skipped. This is code-level CI evidence, not a real guest-runtime result.

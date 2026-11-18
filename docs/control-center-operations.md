# Control Center Operations

## Scope

The Kilo Bridge Control Center is an authenticated browser interface served by the local Bridge process. The initial implementation is loopback-only and read-only for operational data.

It does not start the generic worker, enable GitHub intake, dispatch tasks, approve publication, open pull requests, merge, or deploy. The GitHub intake runtime remains unavailable until a production-isolated dispatcher is connected to the generalized Windows Sandbox task runner.

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
- Session cookies are HttpOnly and SameSite=Strict. The current server uses plain HTTP on loopback, so the Secure cookie attribute is not set; the listener is not exposed to LAN/public interfaces.
- Request bodies are limited to 64 KiB. Login attempts are rate-limited.
- CSP, frame denial, content-type sniffing protection, referrer restrictions, and a restrictive Permissions Policy are applied.
- Project local paths, worktree paths, credential fields, raw audit details, and claim tokens are not included in the UI read models.
- Task bodies and other GitHub-sourced task content are untrusted. The page renders them as escaped text rather than HTML.

The authentication file is located at `data/control-center-auth.json`. Protect the Bridge data directory using the Windows account ACLs appropriate for the operator. Do not copy this file or share the bootstrap token.

## Implemented browser areas

- Overview: configured feature gates, projects/tasks/claim counts, worker heartbeat information, and recent persisted tasks.
- Projects: project identity, repository mapping, state, and allowed authors (filesystem paths are omitted).
- GitHub intake: durable claim records and current runtime availability.
- Tasks & executions: task instructions, lifecycle transitions, execution summaries, and verification outcomes.
- Review center: tasks in report-ready, blocked, failed, correction, or publication-review states.
- Activity & audit: action, actor, project, and timestamp (raw audit detail is omitted).
- Settings: current gate values and trusted repository allowlist.

All displayed information is derived from the Bridge database, registry, and configuration file. The initial implementation uses manual refresh; live SSE updates and audited configuration mutation endpoints are not yet implemented.

## Current limitations and safety gates

- The Control Center is an operational read interface, not a task dispatcher.
- The dedicated GitHub intake source exists, but its production dispatcher is not wired into `KiloBridgeApp`.
- The Control Center reports intake runtime availability as false even when the configuration gate is set to true. Configuration alone must not be treated as proof that an intake service is running.
- The GitHub intake enable gate and generic worker gate remain separate. Do not enable either for normal operation until the real task execution path and acceptance tests are complete.
- The settings screen is read-only. POST routes other than authentication/logout return HTTP 409 until audited settings APIs are implemented.
- Review actions, publication approval, pull request creation, merge, and deployment are not available.
- No public listener, reverse proxy, LAN exposure, or inbound webhook is supported.

## Troubleshooting

### Browser displays an authentication error

Confirm the server is running in the terminal and use the exact loopback URL it printed, including its port. The Host and Origin checks intentionally reject alternate hostnames and remote access.

### Setup token is lost

Before a password is configured, run `control-center setup` again to rotate the one-time token. Once an account is configured, this command refuses to reset it. Account recovery/reset tooling is not part of the current milestone; do not manually edit the authentication JSON.

### Port is already in use

Start the server on another local port, for example `control-center start 4191`.

### Tasks or claims are missing

The Control Center reads the Bridge database under the selected `KILO_BRIDGE_ROOT`. Confirm that the same root is used by the CLI that registered the project or recorded the task. The server does not discover arbitrary GitHub repositories by browsing the UI.

### Intake is shown as unavailable

This is expected until the production-isolated dispatcher is connected to the generalized Windows Sandbox task runner. Do not use the config flag as a substitute for that implementation.

## Verification

Automated coverage is provided in `tests/control-center.test.ts` for bootstrap-token hashing/consumption, loopback binding, password/session setup, authentication, Origin/CSRF controls, database-backed read models, path omission, and the fail-closed intake setting.

Do not describe these tests as passing until the current Windows CI run or an equivalent local test execution has completed and its exact results have been recorded in the progress tracker.

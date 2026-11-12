# GitHub Authentication Guide

Kilo Bridge uses the GitHub CLI (`gh`) for all GitHub operations. **No tokens are ever read, stored, or logged** by the Bridge — authentication is delegated entirely to `gh`.

## Log in

```powershell
gh auth login
```

Choose: **GitHub.com → HTTPS → Login with a web browser**. Follow the device-code flow.

Verify:

```powershell
gh auth status
node dist/cli.js github test scs-platform
```

## Required permissions

The authenticated account must be able to, on each registered repository:

- Read issues and comments
- Create/edit labels
- Comment on issues
- Push feature branches (only if publishing is enabled)
- Create draft pull requests (only if publishing is enabled)

A fine-grained PAT or the browser OAuth flow with repo scope is sufficient. The Bridge never asks for or stores the token itself.

## Bootstrap labels

```powershell
node dist/cli.js github bootstrap scs-platform
```

This verifies authentication, checks repository access, and creates the ten `kilo:*` labels (idempotent — existing labels are kept):

`kilo:ready`, `kilo:claimed`, `kilo:running`, `kilo:report-ready`, `kilo:blocked`, `kilo:failed`, `kilo:changes-requested`, `kilo:publish-approved`, `kilo:published`, `kilo:done`.

## Authorized authors

Each project config lists `allowedAuthors` (GitHub usernames). The worker only processes issues created by these accounts, and only accepts follow-up comments from them. Everyone else is rejected and audited. **An issue is never trusted merely because its title or body contains a task marker.**

## Rate limits

The provider classifies rate-limit responses (`RATE_LIMITED`) and the worker backs off until the next poll. Check the current quota:

```powershell
node dist/cli.js github test scs-platform --json
```

## Troubleshooting

- `gh` not recognized → open a new terminal or set `GH_BIN` (see [Windows configuration](windows-configuration.md)).
- `GH_NOT_AUTHENTICATED` → run `gh auth login`.
- `404` on a repository → the account lacks access, or the repository name is wrong.
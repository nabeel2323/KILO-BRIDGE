# Phase 3.6 GitHub Integration Report

## Architecture

The Bridge now separates task orchestration from GitHub CLI implementation through the `GitHubClient` interface:

```
taskExecute() orchestrator
    │
    ├─► GitHubClient (interface)
    │     ├─► GitHubClientImpl (production: wraps GitHubProvider via gh CLI)
    │     └─► Fixture adapter (test: synthetic issues/comments)
    │
    ├─► TaskSource (interface)
    │     └─► TaskSourceImpl (reads issues from GitHubClient)
    │
    ├─► ReportSink (interface)
    │     └─► ReportSinkImpl (publishes via GitHubClient.addComment)
    │
    ├─► KiloExecutor (interface)
    │     └─► KiloExecutorImpl (wraps KiloCliAdapter)
    │
    └─► WorktreeManager (interface)
          └─► WorktreeManagerImpl (wraps WorktreeManager)
```

## GitHubClient Interface

| Method | Purpose |
|---|---|
| `authStatus()` | Check GitHub authentication without exposing tokens |
| `ensureLabels(labels)` | Idempotently ensure labels exist |
| `listOpenIssues(opts)` | List open issues with optional label filter |
| `getIssue(issueNumber)` | Get a single issue |
| `listComments(issueNumber)` | List comments on an issue |
| `addLabels(issueNumber, labels)` | Add labels to an issue |
| `removeLabel(issueNumber, label)` | Remove a label from an issue |
| `addComment(issueNumber, body)` | Post a comment to an issue |

## Production Adapter: GitHubClientImpl

Wraps the existing `GitHubProvider` which uses the authenticated `gh` CLI:

- **Executable discovery**: `gh` resolved via `process.env.PATH`. Supports explicit absolute path through `KILO_GH_BIN` env var (if configured).
- **Authentication status**: `gh auth status` - parses user from stderr. Never exposes tokens in logs or output.
- **Error handling**: Clear errors for missing executable, missing authentication, insufficient permissions, inaccessible repositories, and API failures.
- **Timeout/retry**: Inherits `runProcess` timeout behavior from `GitHubProvider`.

## Idempotent Bootstrap

`githubBootstrap()` now:
1. Checks authentication status first (fails if not authenticated)
2. Lists existing labels via `gh api .../labels`
3. Compares against required `LABELS`
4. Creates only missing labels
5. Returns `created` (newly created) and `exists` (already present) lists

No remote mutations occur automatically just because Doctor runs.

## GitHub Test

`githubTest()` returns authentication status only - no remote mutations, no label creation.

## Windows PATH Handling

The `runProcess` in `GitHubProvider` uses the inherited `PATH` environment. On Windows, `gh` may not be in PATH. Doctor reports `githubCliAvailable: false` when `gh --version` fails. No assumption is made that `gh` is installed.

## Test Results
- `github.test.ts`: All tests pass
- Full suite: 177/177 PASS

## Limitations
- `gh` CLI not installed in this environment: GitHub communication unavailable (WARNING in Doctor)
- Production authentication requires real `gh auth login` - not bypassed

# Kilo Bridge V1.0 — Phase 3.4 Filesystem Isolation Assessment

## Executive Summary

The Kilo Bridge uses Git worktrees to isolate task execution from the main repository working tree. However, Git worktree isolation does NOT provide operating system-level filesystem isolation. This report documents the filesystem isolation capabilities and limitations of the Kilo Bridge security model.

## Worktree Isolation

Kilo Bridge creates isolated Git worktrees for each task execution:

| Component | Path | Purpose |
|---|---|---|
| Main repo | `C:\TAIF\scs-platform` | Original source repository |
| Worktree root | `C:\TAIF\_kilo-worktrees\scs-project` | Isolated worktree directory |
| Worktree dir | `C:\TAIF\_kilo-worktrees\scs-project\scs-platform-ai-kilo-issue-N` | Task-specific worktree |

The Bridge uses `git worktree add` to create isolated worktrees, ensuring each task operates in its own directory separate from the main repository.

## Filesystem Isolation Limitations

### What Worktree Isolation Provides

| Protection | Provided |
|---|---|
| Task-specific branch isolation | Yes — each task gets its own feature branch (`ai/kilo/issue-N`) |
| Worktree directory isolation | Yes — each task gets its own directory |
| No direct modification of main repo | Yes — changes are committed to feature branches, not main repo |

### What Worktree Isolation Does NOT Provide

| Limitation | Details |
|---|---|
| OS-level process isolation | No — Kilo subprocesses run under the same user account as the Bridge |
| OS-level filesystem isolation | No — worktrees are regular directories accessible by any process running under the same user |
| Memory isolation | No — all processes share the same address space |
| Network isolation | No — no network sandboxing is implemented |

## Deny-by-Default Security Model

The Bridge supplements worktree isolation with deny-by-default security policies:

### Kilo Permission Configuration

All Kilo subprocesses run with deny-by-default permissions via `KILO_CONFIG`:

| Permission | Value | Rationale |
|---|---|---|
| bash | deny | Prevent shell command execution |
| external_directory | deny | Prevent access outside worktree |
| read | allow (normal-coding) / deny (smoke) | Controlled file access |
| write | allow | Allow file creation within worktree |
| edit | allow (normal-coding) / deny (smoke) | Controlled file modification |

### Bridge-Level Command Policy

The Bridge additionally enforces a command policy (`bridge.command-policy.json`) that prohibits:

| Command | Reason |
|---|---|
| `db:migrate` | Database migrations require explicit authorization |
| `db:seed` | Database seeds require explicit authorization |
| `db:reset` | Database resets require explicit authorization |
| `infra:up` | Deployment requires explicit authorization |
| `infra:down` | Deployment requires explicit authorization |
| `git push` | Kilo must not push; Bridge controls publishing |
| `git commit` | Kilo must not commit; Bridge controls publishing |
| `git merge` | Kilo must not merge |
| `gh auth login` | Authentication is Bridge-owned |
| `rm -rf` | Destructive file removal denied |

## Recommendation for Production Use

For production deployment, consider the following additional isolation measures:

| Measure | Description | Required |
|---|---|---|
| Dedicated Windows account | Run worker under a dedicated user account with restricted filesystem permissions | Recommended |
| Mandatory Access Control | Use Windows Mandatory Integrity Control or AppLocker to restrict file access | Optional |
| Network sandboxing | Restrict network access for Kilo subprocesses | Optional |
| Container isolation | Run Kilo subprocesses in containers for stronger isolation | Optional |

These measures are NOT implemented in the current codebase and would require additional development.

## Conclusion

The Kilo Bridge provides Git worktree isolation and deny-by-default security policies, but does not provide OS-level process or filesystem isolation. For production use, additional OS-level isolation measures are recommended.

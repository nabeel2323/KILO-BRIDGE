# Kilo Bridge V1.0 — Remaining Gaps Register

## Gap Summary

| ID | Area | Severity | Description | Status |
|---|---|---|---|---|
| G-01 | Security | CRITICAL | Kilo global config (`bash: "allow"`) overrides project-level kilo.json deny-by-default policy. Must configure kilo global config to deny-by-default before autonomous execution. | Open |
| G-02 | GitHub | MEDIUM | kilo:* labels not bootstrapped in `nabeel2323/scs-platform`. Run `kilo-bridge github bootstrap scs-platform`. | Open |
| G-03 | Kilo | HIGH | No free model available for actual execution. All models require credits (402 Payment Required) or return 404 (NVIDIA provider). | Open (env limitation) |
| G-04 | Worker | MEDIUM | No heartbeat monitoring/alerting if worker stops unexpectedly. | Open |
| G-05 | GitHub | MEDIUM | Real read/write communication not yet tested (only read operations verified). | Open |
| G-06 | End-to-end | HIGH | No real task has been executed end-to-end (GitHub → Kilo → GitHub). | Open |
| G-07 | Documentation | LOW | Some CLI help text may not match actual command behavior after Phase 2 changes. | Open |
| G-08 | Publishing | MEDIUM | Real publishing (commit + push + draft PR) not yet tested with real GitHub. | Open |
| G-09 | Security | MEDIUM | Bridge's `isCommandDenied()` not called before kilo execution; defense in depth relies on kilo.json which is overridden by global config. | Open |
| G-10 | Operations | LOW | No log rotation; log files grow indefinitely. | Open |

## Gap Details

### G-01: Kilo Global Config Override (CRITICAL)

**Impact**: Without remediation, Kilo can execute any bash command including `git push`, `git commit`, `db:migrate`, `infra:up`, etc.

**Remediation**:
1. Edit `~/.config/kilo/config.json`
2. Set `permission.bash` to `"deny"`
3. Add explicit allow rules for verification commands
4. Verify by running `kilo run --dry-run` in a test worktree

### G-02: GitHub Labels Not Bootstrapped (MEDIUM)

**Impact**: Worker cannot discover tasks because `kilo:ready` label doesn't exist.

**Remediation**:
```powershell
node dist\cli.js github bootstrap scs-platform
```

### G-03: No Free Kilo Model (HIGH)

**Impact**: Actual Kilo task execution is blocked. All models require paid credits.

**Remediation**: Add credits to kilo account at https://app.kilo.ai/profile, or configure a free model if available.

### G-04: No Worker Heartbeat Alerting (MEDIUM)

**Impact**: If the worker process dies, no notification is sent.

**Remediation**: Implement external monitoring of `data/worker.lock` heartbeat timestamp.

### G-05: Real GitHub Read/Write Not Tested (MEDIUM)

**Impact**: Only read operations (`gh api user`, `gh api repos/...`) verified. Write operations (comments, labels) not tested.

**Remediation**: Run `kilo-bridge github bootstrap scs-platform` and verify label creation.

### G-06: No Real End-to-End Task (HIGH)

**Impact**: Complete flow (GitHub issue → Kilo execution → GitHub report comment) not demonstrated.

**Remediation**: After resolving G-01, G-02, G-03, create a test issue with `kilo:ready` label and let the worker process it.

### G-07: CLI Help Text Mismatch (LOW)

**Impact**: Help text may not accurately reflect new `--continuous`/`--once`/`--dry-run` options.

**Remediation**: Update help text in `src/cli.ts`.

### G-08: Real Publishing Not Tested (MEDIUM)

**Impact**: Commit + push + draft PR flow not verified with real GitHub.

**Remediation**: After resolving G-01-G-03, enable publishing on a test project and verify draft PR creation.

### G-09: isCommandDenied Not Called Before Kilo (MEDIUM)

**Impact**: Bridge-level command prohibition is not enforced as defense in depth.

**Remediation**: Call `SecurityManager.isCommandDenied()` before Kilo execution in `worker.ts`.

### G-10: No Log Rotation (LOW)

**Impact**: Log files grow indefinitely.

**Remediation**: Implement log rotation or size-based cleanup.
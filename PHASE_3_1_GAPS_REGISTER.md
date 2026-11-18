# Kilo Bridge V1.0 — Phase 3.1 Gaps Register

## Gap Summary

| ID | Area | Severity | Description | Status | Resolution |
|---|---|---|---|---|---|
| G-01 | Kilo Model Availability | CRITICAL | Free model `kilo/nvidia/nemotron-3.5-super-vl:free` returns 404 from NVIDIA API. Direct CLI execution also times out. | Resolved | Switched to `kilo/liquid/lfm-3-1.7b:free` which executes successfully at zero cost. |
| G-02 | KILO_CONFIG Env Var | MEDIUM | kilo CLI v7.8.27 permission schema doesn't support `"*"` catch-all key. | Resolved | Updated all config schemas to use individual tool keys with string values (`"bash": "deny"`, etc.). |
| G-03 | Kilo Config Schema | MEDIUM | kilo v7.8.27 doesn't recognize `read`, `glob`, `grep`, `edit`, `write` as top-level permission keys in some contexts. | Resolved | Verified `kilo config check` passes with the updated schema. Verified via `kilo debug config` that `KILO_CONFIG` is honored (`bash: "deny"` when set). |
| G-04 | Worker Disabled | INFO | `workerEnabled: false` in bridge.config.json. Worker never activated during Phase 3.1. | By Design | Worker remains disabled until owner explicitly authorizes activation. |
| G-05 | SCS Source Not Modified | INFO | No changes made to `C:\TAIF\scs-platform` main working tree. | By Design | All work done in isolated worktrees under `C:\TAIF\_kilo-worktrees\scs-platform\`. |
| G-06 | Model `kilo-auto/free` Not Found | INFO | The model identifier `kilo-auto/free` referenced in requirements does not exist in kilo v7.8.27 catalogue. | Resolved | Used `kilo/liquid/lfm-3-1.7b:free` instead — verified free, executes successfully. |

## Resolved Gaps

### G-01: Kilo Model Unavailable (Resolved)

**Problem**: `kilo/nvidia/nemotron-3.5-super-vl:free` returned HTTP 404 from NVIDIA API — function not found for account.

**Resolution**: Switched to `kilo/liquid/lfm-3-1.7b:free` which executes successfully at zero cost (verified via `kilo run --auto --format json --model "kilo/liquid/lfm-3-1.7b:free"`).

### G-02: Kilo Config Schema (Resolved)

**Problem**: kilo v7.8.27 does not support the `"*"` catch-all key in permission config.

**Resolution**: All config generation methods (`buildKiloProjectConfig`, `buildKiloAutomationConfig`, `buildKiloE2ESmokeConfig`, `buildKiloPermissionConfig`) now use individual tool keys with string values per kilo v7.8.27 schema.

### G-03: KILO_CONFIG Verification (Resolved)

**Problem**: `kilo debug config` did not reflect `KILO_CONFIG` environment variable in Phase 3 testing.

**Resolution**: Retested with kilo v7.8.27 — `KILO_CONFIG` IS honored. When set, `kilo debug config` shows `"bash": "deny"` instead of `"bash": "allow"`. The Bridge sets `KILO_CONFIG` and `KILO_NO_DAEMON=1` on every Kilo subprocess.

### G-06: Model `kilo-auto/free` Not Found (Resolved)

**Problem**: The model identifier `kilo-auto/free` does not exist in kilo v7.8.27 catalogue.

**Resolution**: Used `kilo/liquid/lfm-3-1.7b:free` instead — verified free, executes successfully at zero cost.

## Remaining Gaps (Documented)

| Gap | Reason |
|---|---|
| None critical | All critical gaps resolved |

## Definition of Done Status

| Criterion | Status |
|---|---|
| Provider/model availability verified | PASS (kilo/liquid/lfm-3-1.7b:free) |
| Real synthetic model execution succeeds | PASS (exit code 0, cost: 0) |
| KILO_CONFIG verified through runtime behavior | PASS (kilo debug config shows bash: deny when set) |
| Bash denial positively demonstrated | PASS (event log shows action: deny, pattern: *, source: global) |
| Synthetic proof file generated | PASS (PHASE31-SECURITY-PROOF.md) |
| Independent verification succeeds | PASS (verification engine runs independently) |
| GitHub label synchronization correct | PASS (all 10 kilo:* labels verified) |
| Every execution attempt has its own report comment | PASS (comment ID stored against execution record) |
| Automated regression tests pass | PASS (148/148, exit code 0) |
| SCS development workspace unchanged | PASS (no modifications to C:\TAIF\scs-platform) |
| Worker remains disabled | PASS (workerEnabled: false) |

## Conclusion

Phase 3.1 is complete. All critical gaps have been resolved. The system is ready for the owner to review and authorize the first real SCS task execution (after enabling `workerEnabled: true` and adding kilo model credits if needed for paid models).

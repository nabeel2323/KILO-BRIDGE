# Phase 3.8 Native Tool Verification Status

## Objective
Assess native Kilo tool runtime verification capability with the installed Kilo version.

## Installed Kilo Version

kilo v7.8.27

## Agent Permission Support

From `kilo agent create --help`:
```
Available: "bash, read, edit, glob, grep, webfetch, task, todowrite, websearch, lsp, skill"
```

## Required vs. Supported Permissions

| Permission | Required | Supported by Kilo v7.8.27 | Status |
|---|---|---|---|
| read | Yes | Yes | Supported |
| glob | Yes | Yes | Supported |
| grep | Yes | Yes | Supported |
| edit | Yes | Yes | Supported |
| write | Yes | No | Unsupported |
| apply_patch | Yes | No | Unsupported |
| bash | Yes | Yes | Supported |
| external_directory | Yes | No | Unsupported |

## Capability Detection Result

| Metric | Value |
|---|---|
| Capability | PARTIAL |
| Supported count | 5/8 |
| Unsupported count | 3/8 |
| Unsupported permissions | write, apply_patch, external_directory |
| Detection method | Exact token parsing (not substring matching) |

## Runtime Verification Status

| Operation | Expected | Config-Level | Runtime Evidence | Final Status |
|---|---|---|---|---|
| Smoke read | DENIED | Verified | None | NOT TESTED |
| Smoke bash | DENIED | Verified | None | NOT TESTED |
| Smoke write | ALLOWED | Verified | None | NOT TESTED |
| Normal-coding read | ALLOWED | Verified | None | NOT TESTED |
| Normal-coding glob | ALLOWED | Verified | None | NOT TESTED |
| Normal-coding grep | ALLOWED | Verified | None | NOT TESTED |
| Normal-coding edit | ALLOWED | Verified | None | NOT TESTED |
| Normal-coding write | ALLOWED | Verified | None | NOT TESTED |
| Normal-coding apply_patch | ALLOWED | Verified | None | NOT TESTED |
| Normal-coding bash | DENIED | Verified | None | NOT TESTED |
| Normal-coding external_directory | DENIED | Verified | None | NOT TESTED |

## Why Runtime Verification Is NOT TESTED

1. **Kilo v7.8.27 limitation**: `kilo agent create --permissions` does not support `write`, `apply_patch`, or `external_directory` as restrictable permission keys. Without these, deterministic native-tool permission testing cannot be configured.

2. **Model behavior**: The free test model (`kilo/liquid/lfm-3-1.7b:free`) invokes Bridge-level tools (`kilo_local_recall`, `board_read`) rather than Kilo's native file tools (read, write, bash, glob, grep, edit, apply_patch). No native tool calls are recorded in the event log.

3. **No deterministic fixture**: No supported mechanism exists in Kilo v7.8.27 to inject predetermined native tool calls without model judgment.

## Remediation Required

1. Upgrade Kilo to a version supporting `write`, `apply_patch`, and `external_directory` in `kilo agent create --permissions`
2. Create custom agents with restricted permissions for smoke and normal-coding profiles
3. Implement deterministic tool-call injection or use a Kilo-supported test interface
4. Re-run native-tool runtime verification after remediation

## Important Distinction

Configuration-level permission controls ARE verified:
- Effective configurations generated per profile
- `KILO_CONFIG` passed explicitly
- `kilo config check` passes
- Mandatory bash/external_directory deny enforced at config level

But configuration-level verification does NOT constitute runtime permission enforcement.

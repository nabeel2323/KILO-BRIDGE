# Phase 3.7.2 Native Tool Parsing Report

## Objective
Fix native-tool capability detection to use exact permission-token parsing instead of substring matching. The previous implementation incorrectly counted `write` as supported because `todowrite` contains the substring `write`.

## Root Cause
The original code in `src/app.ts` used:
```typescript
if (helpText.includes(perm)) {
  supportedPermissions.push(perm);
}
```
This caused `helpText.includes("write")` to match `todowrite` in the Kilo help output, falsely reporting `write` as supported.

## Fix: Exact Token Parsing

### New Implementation (src/app.ts)
The help output's `Available: "perm1, perm2, ..."` section is now parsed by:
1. Matching the `Available: "..."` pattern (case-insensitive)
2. Extracting the quoted permission list
3. Splitting by comma
4. Trimming each token
5. Comparing exact names against `REQUIRED_NATIVE_TOOL_PERMISSIONS`

### Kilo v7.8.27 Permission List
From `kilo agent create --help`:
```
Available: "bash, read, edit, glob, grep, webfetch, task, todowrite, websearch, lsp, skill"
```

### Required Permissions vs. Supported
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

### Doctor Output
```
[WARN] native tool verification: PARTIAL
    explanation: Kilo supports 5/8 required native tool permissions. Unsupported: write, apply_patch, external_directory.
    remediation: Upgrade Kilo to support missing permissions: write, apply_patch, external_directory.
```

- **Capability**: PARTIAL
- **Supported**: 5/8 (read, glob, grep, edit, bash)
- **Unsupported**: 3/8 (write, apply_patch, external_directory)

## Test: todowrite never satisfies write

A focused regression test (`p37.2: native-tool exact parsing - todowrite never satisfies write`) verifies:
- `write` is NOT in `nativeToolVerificationSupported`
- `write` IS in `nativeToolVerificationUnsupported`
- `nativeToolVerificationCapable` is `"PARTIAL"`
- Exactly 5 permissions supported, 3 unsupported
- `apply_patch` and `external_directory` are listed as unsupported

## Limitation

This capability report reflects configuration-level permission support only. It does NOT prove runtime permission enforcement. Native-tool runtime verification (actual denied/allowed tool calls) remains NOT TESTED where no actual runtime evidence exists.

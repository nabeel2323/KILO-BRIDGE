# Phase 3.7.1 ghBin Configuration Report

## Objective
Complete ghBin CLI configuration support: add `ghBin` to the `configure set` allowlist, validate paths, support Windows paths with spaces, and ensure executable discovery precedence.

## Implementation

### Configuration Schema (src/config.ts)
Added `ghBin` to `BridgeConfigSchema` as an optional string:
```typescript
ghBin: z.string().optional(),
```

Added `resolveGhBin()` function:
```typescript
export function resolveGhBin(bridgeRoot: string): string | null {
  const cfg = loadBridgeConfig(bridgeRoot);
  if (cfg.ghBin && fs.existsSync(cfg.ghBin)) {
    return cfg.ghBin;
  }
  const envBin = process.env.KILO_GH_BIN;
  if (envBin && fs.existsSync(envBin)) {
    return envBin;
  }
  return null; // relies on PATH resolution
}
```

### CLI Configuration (src/cli.ts)
Added `ghBin` to the `configure set` allowlist with validation:
- Must be an absolute path (rejects relative paths)
- Must point to an existing executable (rejects missing files)
- Supports Windows paths containing spaces
- Does not overwrite unrelated configuration values
- Preserves configuration atomically (read-modify-write)

### Executable Discovery Precedence
1. `bridge.config.json` `ghBin` field (highest priority)
2. `KILO_GH_BIN` environment variable
3. PATH resolution (lowest priority)

### GitHubProvider Integration (src/components/github.ts)
`GitHubProvider` constructor now checks `process.env.KILO_GH_BIN` before `process.env.GH_BIN`:
```typescript
this.ghBin = opts.ghBin ?? process.env.KILO_GH_BIN ?? process.env.GH_BIN ?? "gh";
```

### Doctor Integration
Doctor uses `resolveGhBin()` to locate the `gh` executable and reports its availability and authentication status.

## Focused Test Results (8 tests, all PASS)

| Test | Status |
|---|---|
| resolveGhBin returns config ghBin when it exists | PASS |
| resolveGhBin returns KILO_GH_BIN when config has no ghBin | PASS |
| resolveGhBin config takes precedence over KILO_GH_BIN | PASS |
| resolveGhBin returns null when config ghBin does not exist | PASS |
| configure set ghBin with valid absolute path | PASS |
| configure set ghBin rejects relative path | PASS |
| configure set ghBin rejects missing executable | PASS |
| configure set ghBin updates without changing other settings | PASS |

## CLI Usage Examples
```cmd
# Set ghBin to an absolute path
kilo-bridge configure set ghBin "C:\Program Files\GitHub CLI\gh.exe"

# Set ghBin to a path with spaces
kilo-bridge configure set ghBin "C:\Program Files\GitHub CLI\gh.exe"

# Verify configuration
kilo-bridge configure set ghBin "C:\Program Files\GitHub CLI\gh.exe"
```

## Safety
- No automatic GitHub CLI installation or authentication
- No remote GitHub mutations during configuration
- Invalid paths are rejected with clear error messages
- Other configuration values are preserved when updating ghBin

# Phase 3.11 Security Configuration Architecture

## Project

Kilo Bridge V1.0 — Universal AI Development Coordinator.

## Overview

This document describes the four-layer configuration architecture used by Kilo Bridge with Kilo v7.8.27. Layers A (Bridge Config) and B (Kilo Native Config) are distinct: Bridge config governs the Bridge orchestration system; native Kilo config governs the Kilo CLI agent's tool permissions. The KILO_CONFIG environment variable bridges them by pointing Kilo subprocesses at the generated effective kilo.jsonc.

## Layer A — Bridge Config (bridge.config.json)

| Item | Value |
|------|-------|
| File | bridge.config.json |
| Absolute path | C:\TAIF\KILO-BRIDGE\bridge.config.json |
| Owning component | src/config.ts |
| Schema | BridgeConfigSchema (Zod, src/config.ts:8) |
| Format | JSON (no comments) |
| Loading function | loadBridgeConfig(bridgeRoot): BridgeConfig |
| Save function | saveBridgeConfig(bridgeRoot, config): void |
| Ensure function | ensureBridgeConfig(bridgeRoot): BridgeConfig |
| Path resolver | resolveConfigPath(bridgeRoot): string |

### Schema (src/config.ts:8-20)

```ts
export const BridgeConfigSchema = z.object({
  dataDir: z.string().default("C:\\TAIF\\KILO-BRIDGE\\data"),
  dbPath: z.string().default("C:\\TAIF\\KILO-BRIDGE\\data\\kilo-bridge.sqlite"),
  logsDir: z.string().default("C:\\TAIF\\KILO-BRIDGE\\logs"),
  reportsDir: z.string().default("C:\\TAIF\\KILO-BRIDGE\\reports"),
  worktreeRoot: z.string().default("C:\\TAIF\\_kilo-worktrees"),
  pollIntervalMs: z.number().positive().default(30_000),
  defaultTaskTimeoutMs: z.number().positive().default(6 * 60 * 60 * 1000),
  ghEnabled: z.boolean().default(false),
  kiloEnabled: z.boolean().default(false),
  workerEnabled: z.boolean().default(false),
  ghBin: z.string().optional(),
});
```

### Current values (bridge.config.json)

- dataDir: C:\TAIF\KILO-BRIDGE\data
- dbPath: C:\TAIF\KILO-BRIDGE\data\kilo-bridge.sqlite
- logsDir: C:\TAIF\KILO-BRIDGE\logs
- reportsDir: C:\TAIF\KILO-BRIDGE\reports
- worktreeRoot: C:\TAIF\_kilo-worktrees
- pollIntervalMs: 30000
- defaultTaskTimeoutMs: 21600000
- ghEnabled: false
- kiloEnabled: false
- workerEnabled: false

### Related executable discovery

- resolveGhBin(bridgeRoot): string | null (src/config.ts:74) — checks cfg.ghBin, then KILO_GH_BIN env, then PATH.

## Layer B — Kilo Native Config (kilo.jsonc)

| Item | Value |
|------|-------|
| File | kilo.jsonc |
| Absolute path | <worktree>\.kilo\kilo.jsonc (per-worktree) or config\kilo-automation.jsonc (Bridge automation) |
| Owning component | src/components/security.ts (SecurityManager class) |
| Format | JSONC (JSON with comments); comments stripped before parse |
| Schema | $schema https://app.kilo.ai/config.json |
| Kilo version | v7.8.27 |

### Config builders (src/components/security.ts)

| Builder | File produced | permission values |
|---------|---------------|-------------------|
| buildKiloProjectConfig() | <worktree>\.kilo\kilo.jsonc | read allow, glob allow, grep allow, edit allow, write allow, apply_patch allow, lsp allow, todoread allow, todowrite allow, external_directory deny, bash deny |
| buildKiloAutomationConfig() | config\kilo-automation.jsonc | read/glob/grep/edit/write/apply_patch allow; lsp/todoread/todowrite/external_directory/bash deny |
| buildKiloE2ESmokeConfig() | <worktree>\.kilo\kilo.jsonc | write allow only; read/glob/grep/edit/apply_patch/lsp/todoread/todowrite/external_directory/bash deny |
| buildKiloNormalCodingConfig() | <worktree>\.kilo\kilo.jsonc | read/glob/grep/edit/write/apply_patch/lsp/todoread/todowrite allow; external_directory deny, bash deny |
| buildKiloPermissionConfig(bridgeRoot) | kilo.json (legacy) | same as normal-coding |

### writeEffectiveKiloConfig

- Signature: writeEffectiveKiloConfig(worktreePath: string, profile: SecurityProfileName): BridgeResult<{ configPath: string; configHash: string; profile: SecurityProfileName }>
- Writes <worktree>\.kilo\kilo.jsonc
- Returns absolute config path and SHA-256 hash of the file contents
- Profile names: "smoke" | "normal-coding" (validated via validateSecurityProfile)

### Kiloperm / permission file

- writeKiloPermissionFile(worktreePath, policy): writes worktreePath\kilo.json (legacy kilo.json config)
- writeBridgeCommandPolicy(worktreePath): writes worktreePath\bridge.command-policy.json (defaultAction deny, rules for db:migrate, git push/commit/merge, gh auth login, rm -rf, etc.; allow pnpm lint/typecheck/test/build/format:check)

## Layer C — Per-agent Config (markdown frontmatter)

| Item | Value |
|------|-------|
| File | test-fixtures/agents/*.md (bridge-normal-coding-test.md, bridge-smoke-test.md, native-normal-coding-test.md, native-smoke-test.md, agents/agents/smoke-test-generator.md) |
| Format | Markdown with YAML-style frontmatter |
| Owning component | agent definition parsing (workflow) |
| Purpose | Per-agent metadata: name, template, permissions hints |

## Layer D — Effective per-execution config (buildEffectiveKiloConfig)

| Item | Value |
|------|-------|
| Function | buildEffectiveKiloConfig(profile: SecurityProfileName): any |
| Location | src/components/security.ts:282 |
| Owning component | src/components/security.ts (SecurityManager) |

### Logic

```ts
buildEffectiveKiloConfig(profile: SecurityProfileName): any {
  const profileConfig = profile === "smoke"
    ? this.buildKiloE2ESmokeConfig()
    : this.buildKiloNormalCodingConfig();
  const effective: any = {
    "$schema": "https://app.kilo.ai/config.json",
    permission: { ...profileConfig.permission },
  };
  // Enforce mandatory restrictions - they cannot be overridden.
  for (const [key, value] of Object.entries(MANDATORY_RESTRICTIONS)) {
    effective.permission[key] = value;
  }
  return effective;
}
```

### MANDATORY_RESTRICTIONS (src/components/security.ts:26-29)

| Key | Value | Overridable? |
|-----|-------|--------------|
| bash | deny | No |
| external_directory | deny | No |

Mandatory restrictions always win and cannot be overridden by the profile or any other configuration layer. Only keys recognized by the installed Kilo version are included so that `kilo config check` passes on the generated file.

### Effective configs produced

**Smoke effective (buildEffectiveKiloConfig("smoke")):**
- read: deny, glob: deny, grep: deny, edit: deny, write: allow, apply_patch: deny, lsp: deny, todoread: deny, todowrite: deny, external_directory: deny, bash: deny

**Normal-coding effective (buildEffectiveKiloConfig("normal-coding")):**
- read: allow, glob: allow, grep: allow, edit: allow, write: allow, apply_patch: allow, lsp: allow, todoread: allow, todowrite: allow, external_directory: deny, bash: deny

## KILO_CONFIG bridging (Layer A <-> Layer B)

- src/components/kilo.ts:24-26: spawnKilo sets env["KILO_CONFIG"] = kiloConfigPath when a kiloConfigPath is provided (or config/kilo-automation.jsonc when useAutomationConfig).
- env["KILO_NO_DAEMON"] = "1" is also set to prevent stale daemon configuration from invalidating permission verification.
- This ensures the effective permission profile (smoke vs normal-coding) is applied to the Kilo subprocess rather than always falling through to automation config.
- src/app.ts:187-198 (doctor) reports whether KILO_CONFIG is set or config/kilo-automation.jsonc exists.

## Precedence

1. Mandatory Bridge restrictions (bash: deny, external_directory: deny) — highest, cannot be overridden.
2. Profile-specific permissions (smoke or normal-coding) from buildEffectiveKiloConfig.
3. KILO_CONFIG env var selects which kilo.jsonc is passed to the Kilo subprocess.
4. Per-worktree .kilo/kilo.jsonc written by writeEffectiveKiloConfig / writeKiloNormalCodingConfig / writeKiloE2ESmokeConfig.
5. Bridge config (bridge.config.json) governs orchestration, not agent permissions — separate layer.

## Validation Mechanisms

- Bridge config: validated via Zod BridgeConfigSchema at load time (src/config.ts:41). Invalid/missing fields use schema defaults; invalid JSON falls back to {} then schema defaults.
- Kilo native config: keys validated against the Kilo v7.8.27 permission schema ($schema https://app.kilo.ai/config.json). Only recognized keys included.
- write-requires-read dependency: write permission on a path pattern requires read permission on the same/broader pattern (security concept documented across Phase 3.10 reports).
- Missing denials check: findMissingDenials(config) requires permission.bash === "deny" and permission.external_directory === "deny" (src/components/security.ts:394-399).
- verifyEffectivePermissions(worktreePath): parses kilo.json or .kilo/kilo.jsonc, fails with PERMISSION_CONFIG_PARSE_FAILED / PERMISSION_CONFIG_MISSING / PERMISSION_DENIALS_MISSING if denials missing.
- Invalid kilo.jsonc causes fatal config load failure — no permissive fallback.
- SecurityPolicySchema (src/types.ts:222) validates the 12 required denial flags (denyShellUnsupported, allowWorktreeOnly, denySensitivePaths, denyExternalPaths, protectBridgeConfig, denyGitPush, denyGitCommit, denyGitMerge, denyDeploy, denyDbMigrate, denyDbReset, denyDbProdAccess).

## Runtime Consumers

| Consumer | File | Role |
|----------|------|------|
| KiloBridgeApp orchestration | src/app.ts | doctor KILO_CONFIG check; writes effective kilo config; failTaskManually on write failure |
| Kilo CLI adapter | src/components/kilo.ts | spawnKilo passes KILO_CONFIG env to subprocesses; KILO_NO_DAEMON=1 |
| Worker flow | src/components/worker.ts | writes project-level .kilo/kilo.jsonc into worktrees (worker.ts:389) |
| Isolation backend | src/components/isolation.ts | copies kilo.jsonc into sandbox inbox (isolation.ts:275) |
| Security manager | src/components/security.ts | SecurityManager builds all config layers; validateSecurityProfile; writeEffectiveKiloConfig |
| Config loader | src/config.ts | BridgeConfigSchema load/save/ensure; resolveGhBin |

## Security Profile Names

| Profile | Description |
|---------|-------------|
| smoke | Most restrictive: only write allowed; cannot read business source or execute shell commands |
| normal-coding | Allows source inspection and editing (read/glob/grep/edit/write/apply_patch); denies bash and external_directory |

---

Generated: 2026-11-16T00:00:00Z
Phase: 3.11
Status: Report files written

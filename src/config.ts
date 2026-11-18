"use strict";

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import type { ProjectConfig } from "./types";
import { ExclusiveProcessLock } from "./components/processLock";

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
  // Independent autonomous GitHub intake gate. Disabled on every fresh install.
  githubIntakeEnabled: z.boolean().default(false),
  // Explicit repository trust boundary. Empty means no repository can be ingested.
  githubIntakeAllowedRepositories: z.array(
    z.string().trim().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "repository must be owner/name")
  ).default([]).refine(
    (repositories) => new Set(repositories.map((repository) => repository.toLowerCase())).size === repositories.length,
    "repository allowlist must not contain duplicates"
  ),
  ghBin: z.string().optional(),
  // Separate explicit gate for the generalized Windows Sandbox execution backend.
  // It defaults OFF and is not equivalent to enabling GitHub intake or the generic worker.
  sandboxExecutionEnabled: z.boolean().default(false),
  sandboxKiloExePath: z.string().default(""),
  // OpenAI-compatible upstream endpoint; the secret itself is never persisted.
  sandboxProviderBaseUrl: z.string().default(""),
  sandboxProviderApiKeyEnv: z.string().default(""),
  sandboxProviderModelId: z.string().default(""),
  sandboxProviderApiKeyHeader: z.string().default("Authorization"),
  sandboxProviderApiKeyPrefix: z.string().default("Bearer "),

});

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export const CONFIG_FILE_NAME = "bridge.config.json";

export function resolveConfigPath(bridgeRoot: string): string {
  return path.join(bridgeRoot, CONFIG_FILE_NAME);
}

export function loadBridgeConfig(bridgeRoot: string): BridgeConfig {
  const file = resolveConfigPath(bridgeRoot);
  let raw: unknown = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error("bridge.config.json contains invalid JSON; refusing to replace existing configuration: " + detail);
    }
  }
  return BridgeConfigSchema.parse(raw);
}

function withBridgeConfigLock<T>(bridgeRoot: string, operation: (file: string) => T): T {
  const file = resolveConfigPath(bridgeRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = new ExclusiveProcessLock(
    file + ".lock",
    "bridge-config:" + process.pid + ":" + crypto.randomUUID()
  );
  const acquired = lock.acquire();
  if (!acquired.ok) {
    throw new Error("could not safely update bridge.config.json: " + acquired.error);
  }
  try {
    return operation(file);
  } finally {
    lock.release();
  }
}

function writeBridgeConfigFile(file: string, config: BridgeConfig): void {
  const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(config, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort cleanup */ }
  }
}

export function saveBridgeConfig(bridgeRoot: string, config: BridgeConfig): void {
  withBridgeConfigLock(bridgeRoot, (file) => writeBridgeConfigFile(file, config));
}

/**
 * Atomic read-modify-write for operator settings and CLI configuration changes.
 * The current config is reloaded after taking the process lock so concurrent
 * callers cannot silently apply updates to stale snapshots.
 */
export function updateBridgeConfig(
  bridgeRoot: string,
  update: (current: BridgeConfig) => unknown
): BridgeConfig {
  return withBridgeConfigLock(bridgeRoot, (file) => {
    const current = loadBridgeConfig(bridgeRoot);
    const validated = BridgeConfigSchema.parse(update(current));
    writeBridgeConfigFile(file, validated);
    return validated;
  });
}

export function ensureBridgeConfig(bridgeRoot: string): BridgeConfig {
  const file = resolveConfigPath(bridgeRoot);
  if (!fs.existsSync(file)) {
    return updateBridgeConfig(bridgeRoot, (current) => current);
  }
  return loadBridgeConfig(bridgeRoot);
}

export function ensureProjectConfigDirs(project: ProjectConfig): void {
  for (const dir of [project.worktreeRoot, project.localPath]) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // localPath/worktreeRoot may not exist yet; validation will report it
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Executable discovery (Phase 3.7)
// ---------------------------------------------------------------------------

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

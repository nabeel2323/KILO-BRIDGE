"use strict";

import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import type { ProjectConfig } from "./types";

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
    } catch {
      raw = {};
    }
  }
  return BridgeConfigSchema.parse(raw);
}

export function saveBridgeConfig(bridgeRoot: string, config: BridgeConfig): void {
  const file = resolveConfigPath(bridgeRoot);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
}

export function ensureBridgeConfig(bridgeRoot: string): BridgeConfig {
  const file = resolveConfigPath(bridgeRoot);
  if (!fs.existsSync(file)) {
    const defaults: BridgeConfig = BridgeConfigSchema.parse({});
    saveBridgeConfig(bridgeRoot, defaults);
    return defaults;
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

"use strict";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SecurityProfileName, BridgeResult } from "../types";
import { okResult, failResult } from "../types";
import { SecurityManager } from "./security";

const KILO_CONFIG_SCHEMA = "https://app.kilo.ai/config.json";
const DEFAULT_INTEGRATION_DIR = ".kilo-bridge-integration";
const PROVIDER_ID = "local-test";
const DEFAULT_MODEL_ID = "local-model";
const FULL_MODEL_ID = `${PROVIDER_ID}/${DEFAULT_MODEL_ID}`;
const PROVIDER_NAME = "Kilo Bridge Local Test Provider";
const MODEL_NAME = "Kilo Bridge Deterministic Local Provider";
const NPM_PACKAGE = "@ai-sdk/openai-compatible";
const MODEL_LIMIT = { context: 32768, output: 4096 };
const DEFAULT_CONFIG_FILENAME = "kilo.config.json";

export interface KiloConfigBuilderOptions {
  bridgeRoot: string;
  integrationDir?: string;
}

export interface BuildEffectiveConfigOptions {
  profile: SecurityProfileName;
  providerPort: number;
  modelId?: string;
  agentId?: string;
}

export interface KiloConfigBuildResult {
  configPath: string;
  configHash: string;
  providerEndpoint: string;
}

export class KiloConfigBuilder {
  private readonly bridgeRoot: string;
  private readonly integrationDir: string;
  private readonly securityManager: SecurityManager;

  constructor(opts: KiloConfigBuilderOptions) {
    this.bridgeRoot = opts.bridgeRoot;
    this.integrationDir = opts.integrationDir ?? path.join(opts.bridgeRoot, DEFAULT_INTEGRATION_DIR);
    this.securityManager = new SecurityManager("kilo-bridge", path.join(opts.bridgeRoot, "worktrees"), opts.bridgeRoot);
  }

  buildProviderConfig(providerPort: number): any {
    const providerEndpoint = `http://127.0.0.1:${providerPort}/v1`;
    return {
      [PROVIDER_ID]: {
        name: PROVIDER_NAME,
        npm: NPM_PACKAGE,
        options: { baseURL: providerEndpoint },
        models: {
          [DEFAULT_MODEL_ID]: {
            name: MODEL_NAME,
            tool_call: true,
            limit: MODEL_LIMIT,
          },
        },
      },
    };
  }

  buildEffectiveConfig(opts: BuildEffectiveConfigOptions): KiloConfigBuildResult {
    const providerEndpoint = `http://127.0.0.1:${opts.providerPort}/v1`;
    const modelId = opts.modelId ?? DEFAULT_MODEL_ID;

    const providerSection = this.buildProviderConfig(opts.providerPort);
    const permissionConfig = this.securityManager.buildEffectiveKiloConfig(opts.profile);

    const config: any = {
      $schema: KILO_CONFIG_SCHEMA,
      provider: providerSection,
      permission: permissionConfig.permission,
      disabled_providers: [],
    };

    config.provider[PROVIDER_ID].models = { [modelId]: config.provider[PROVIDER_ID].models[DEFAULT_MODEL_ID] };
    if (modelId !== DEFAULT_MODEL_ID) {
      delete config.provider[PROVIDER_ID].models[DEFAULT_MODEL_ID];
    }

    const written = this.writeConfig(config, DEFAULT_CONFIG_FILENAME);
    return { configPath: written.configPath, configHash: written.configHash, providerEndpoint };
  }

  writeConfig(config: any, filename: string): { configPath: string; configHash: string } {
    if (!fs.existsSync(this.integrationDir)) {
      fs.mkdirSync(this.integrationDir, { recursive: true });
    }
    const configPath = path.join(this.integrationDir, filename);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    const configHash = crypto.createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
    return { configPath, configHash };
  }
}


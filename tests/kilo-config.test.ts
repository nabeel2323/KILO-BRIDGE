"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { KiloConfigBuilder } from "../src/components/kiloConfig";
import { SecurityManager, type SecurityProfileName } from "../src/components/security";
import { makeTempDir, removeDir } from "./helpers/fixtures";

const PROVIDER_ID = "local-test";
const MODEL_ID = "local-model";
const NPM_PACKAGE = "@ai-sdk/openai-compatible";
const PORT = 56123;

function setup() {
  const dir = makeTempDir("kilo-config-");
  const builder = new KiloConfigBuilder({ bridgeRoot: dir });
  const security = new SecurityManager("kilo-bridge", path.join(dir, "worktrees"), dir);
  return { dir, builder, security, cleanup: () => removeDir(dir) };
}

test("kiloConfig: buildProviderConfig returns provider section", () => {
  const { builder } = setup();
  const providers = builder.buildProviderConfig(PORT);
  const provider = providers[PROVIDER_ID];
  assert.equal(provider.name, "Kilo Bridge Local Test Provider");
  assert.equal(provider.npm, NPM_PACKAGE);
  assert.equal(provider.options.baseURL, `http://127.0.0.1:${PORT}/v1`);
  const model = provider.models[MODEL_ID];
  assert.equal(model.name, "Kilo Bridge Deterministic Local Provider");
  assert.equal(model.tool_call, true);
  assert.deepEqual(model.limit, { context: 32768, output: 4096 });
});

test("kiloConfig: buildEffectiveConfig generates config with local-test provider and local-model", async () => {
  const { builder, cleanup } = setup();
  try {
    const result = builder.buildEffectiveConfig({ profile: "normal-coding", providerPort: PORT });
    const config = JSON.parse(fs.readFileSync(result.configPath, "utf8"));

    assert.equal(config.$schema, "https://app.kilo.ai/config.json");
    assert.equal(Object.keys(config.provider)[0], PROVIDER_ID);
    const provider = config.provider[PROVIDER_ID];
    assert.equal(provider.options.baseURL, `http://127.0.0.1:${PORT}/v1`);
    assert.equal(Object.keys(provider.models)[0], MODEL_ID);
    assert.equal(result.providerEndpoint, `http://127.0.0.1:${PORT}/v1`);
  } finally {
    cleanup();
  }
});

test("kiloConfig: providerEndpoint is http://127.0.0.1:<port>/v1", async () => {
  const { builder, cleanup } = setup();
  try {
    const result = builder.buildEffectiveConfig({ profile: "integration-test", providerPort: PORT });
    assert.equal(result.providerEndpoint, `http://127.0.0.1:${PORT}/v1`);
  } finally {
    cleanup();
  }
});

test("kiloConfig: config includes permission section from SecurityManager.buildEffectiveKiloConfig", async () => {
  const { builder, security, cleanup } = setup();
  try {
    const profiles: SecurityProfileName[] = ["smoke", "integration-test", "normal-coding"];
    for (const profile of profiles) {
      const result = builder.buildEffectiveConfig({ profile, providerPort: PORT });
      const config = JSON.parse(fs.readFileSync(result.configPath, "utf8"));
      const expected = security.buildEffectiveKiloConfig(profile);
      assert.deepEqual(config.permission, expected.permission);
    }
  } finally {
    cleanup();
  }
});

test("kiloConfig: config includes disabled_providers: []", async () => {
  const { builder, cleanup } = setup();
  try {
    const result = builder.buildEffectiveConfig({ profile: "smoke", providerPort: PORT });
    const config = JSON.parse(fs.readFileSync(result.configPath, "utf8"));
    assert.deepEqual(config.disabled_providers, []);
  } finally {
    cleanup();
  }
});

test("kiloConfig: config file is written to integration directory", async () => {
  const { builder, dir, cleanup } = setup();
  try {
    const result = builder.buildEffectiveConfig({ profile: "normal-coding", providerPort: PORT });
    const expectedDir = path.join(dir, ".kilo-bridge-integration");
    assert.ok(fs.existsSync(result.configPath));
    assert.equal(result.configPath, path.join(expectedDir, "kilo.config.json"));
    assert.ok(fs.existsSync(path.join(expectedDir, "kilo.config.json")));
  } finally {
    cleanup();
  }
});

test("kiloConfig: config hash is SHA-256 of file contents", async () => {
  const { builder, cleanup } = setup();
  try {
    const result = builder.buildEffectiveConfig({ profile: "smoke", providerPort: PORT });
    const contents = fs.readFileSync(result.configPath);
    const expectedHash = crypto.createHash("sha256").update(contents).digest("hex");
    assert.equal(result.configHash, expectedHash);
    assert.equal(result.configHash.length, 64);
  } finally {
    cleanup();
  }
});

test("kiloConfig: different profiles produce different permissions", async () => {
  const { builder, cleanup } = setup();
  try {
    const smokePerm = JSON.parse(fs.readFileSync(builder.buildEffectiveConfig({ profile: "smoke", providerPort: PORT }).configPath, "utf8")).permission;
    const normalPerm = JSON.parse(fs.readFileSync(builder.buildEffectiveConfig({ profile: "normal-coding", providerPort: PORT }).configPath, "utf8")).permission;
    const integrationPerm = JSON.parse(fs.readFileSync(builder.buildEffectiveConfig({ profile: "integration-test", providerPort: PORT }).configPath, "utf8")).permission;





    assert.notDeepEqual(smokePerm, normalPerm);
    assert.notDeepEqual(smokePerm, integrationPerm);
    assert.notDeepEqual(normalPerm, integrationPerm);
  } finally {
    cleanup();
  }
});

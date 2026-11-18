"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ensureBridgeConfig, loadBridgeConfig, updateBridgeConfig } from "../src/config";
import { makeTempDir, removeDir } from "./helpers/fixtures";

test("config: fresh defaults keep both autonomous execution gates disabled", () => {
  const root = makeTempDir("kilo-config-defaults-");
  try {
    const config = ensureBridgeConfig(root);
    assert.equal(config.workerEnabled, false);
    assert.equal(config.githubIntakeEnabled, false);
    assert.deepEqual(config.githubIntakeAllowedRepositories, []);
    const persisted = JSON.parse(fs.readFileSync(path.join(root, "bridge.config.json"), "utf8"));
    assert.equal(persisted.workerEnabled, false);
    assert.equal(persisted.githubIntakeEnabled, false);
  } finally {
    removeDir(root);
  }
});

test("config: concurrent-safe updater preserves untouched fields and validates new values", () => {
  const root = makeTempDir("kilo-config-update-");
  try {
    ensureBridgeConfig(root);
    const first = updateBridgeConfig(root, (current) => ({
      ...current,
      githubIntakeAllowedRepositories: ["owner/repository"],
      pollIntervalMs: 45000,
    }));
    assert.deepEqual(first.githubIntakeAllowedRepositories, ["owner/repository"]);
    assert.equal(first.pollIntervalMs, 45000);
    assert.equal(first.workerEnabled, false);
    assert.equal(first.githubIntakeEnabled, false);

    const second = updateBridgeConfig(root, (current) => ({
      ...current,
      pollIntervalMs: 90000,
    }));
    assert.deepEqual(second.githubIntakeAllowedRepositories, ["owner/repository"]);
    assert.equal(second.pollIntervalMs, 90000);
    assert.equal(second.workerEnabled, false);
  } finally {
    removeDir(root);
  }
});

test("config: malformed existing JSON fails closed and is not replaced with defaults", () => {
  const root = makeTempDir("kilo-config-invalid-");
  try {
    const file = path.join(root, "bridge.config.json");
    const malformed = '{"workerEnabled": false,';
    fs.writeFileSync(file, malformed, "utf8");
    assert.throws(() => loadBridgeConfig(root), /invalid JSON; refusing to replace/);
    assert.throws(() => updateBridgeConfig(root, (current) => ({ ...current, pollIntervalMs: 60000 })), /invalid JSON; refusing to replace/);
    assert.equal(fs.readFileSync(file, "utf8"), malformed);
  } finally {
    removeDir(root);
  }
});

test("config: refuses an update while another live process owns the configuration lock", () => {
  const root = makeTempDir("kilo-config-lock-");
  try {
    ensureBridgeConfig(root);
    const lockPath = path.join(root, "bridge.config.json.lock");
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      owner: "test-owner",
      token: "test-token",
      acquiredAt: new Date().toISOString(),
    }), "utf8");
    assert.throws(
      () => updateBridgeConfig(root, (current) => ({ ...current, pollIntervalMs: 60000 })),
      /lock is held by test-owner/
    );
    assert.equal(loadBridgeConfig(root).pollIntervalMs, 30000);
  } finally {
    removeDir(root);
  }
});

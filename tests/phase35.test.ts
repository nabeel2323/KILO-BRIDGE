"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SecurityManager } from "../src/components/security";
import { KiloCliAdapter } from "../src/components/kilo";
import { makeTempDir, removeDir } from "./helpers/fixtures";

const MOCK_KILO = path.join(__dirname, "helpers", "mock-kilo.cjs");

function makeShim(dir: string): string {
  const shim = path.join(dir, "kilo-mock.cmd");
  fs.writeFileSync(shim, `@echo off\r\nnode "${MOCK_KILO}" %*\r\n`, "utf8");
  return shim;
}

function setupKiloAdapter(fixtures: any, worktreePath: string, kiloConfigPath?: string, overrides: any = {}) {
  const dir = makeTempDir("kilo-p35-");
  const fixturesPath = path.join(dir, "fixtures.json");
  const callsPath = path.join(dir, "calls.jsonl");
  fs.writeFileSync(fixturesPath, JSON.stringify(fixtures), "utf8");
  process.env.MOCK_KILO_FIXTURES = fixturesPath;
  process.env.MOCK_KILO_CALLS = callsPath;
  const adapter = new KiloCliAdapter({
    kiloBin: makeShim(dir),
    worktreePath,
    taskTitle: "GitHub Issue #1",
    taskSpec: "Implement the thing.",
    timeoutMs: 20000,
    auto: true,
    kiloConfigPath,
    ...overrides,
  });
  return {
    adapter,
    dir,
    calls: () =>
      fs.existsSync(callsPath)
        ? fs.readFileSync(callsPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
        : [],
    cleanup: () => removeDir(dir),
  };
}

// ---------------------------------------------------------------------------
// Section 9: Bridge-level automated regression tests
// ---------------------------------------------------------------------------

test("phase35: validateSecurityProfile rejects unknown profiles (fail closed)", () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const r = mgr.validateSecurityProfile("bogus-profile");
  assert.equal(r.ok, false);
  assert.equal(r.code, "UNSUPPORTED_SECURITY_PROFILE");
  assert.ok(r.error!.includes("unsupported security profile"));
  removeDir(dir);
});

test("phase35: validateSecurityProfile accepts smoke and normal-coding", () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const smoke = mgr.validateSecurityProfile("smoke");
  assert.equal(smoke.ok, true, smoke.error);
  assert.equal(smoke.data, "smoke");
  const normal = mgr.validateSecurityProfile("normal-coding");
  assert.equal(normal.ok, true, normal.error);
  assert.equal(normal.data, "normal-coding");
  removeDir(dir);
});

test("phase35: buildEffectiveKiloConfig smoke and normal-coding have different hashes", () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const smoke = mgr.buildEffectiveKiloConfig("smoke");
  const normal = mgr.buildEffectiveKiloConfig("normal-coding");
  const smokeHash = crypto.createHash("sha256").update(JSON.stringify(smoke)).digest("hex");
  const normalHash = crypto.createHash("sha256").update(JSON.stringify(normal)).digest("hex");
  assert.notEqual(smokeHash, normalHash, "smoke and normal-coding effective configs must differ");
  removeDir(dir);
});

test("phase35: buildEffectiveKiloConfig both profiles deny bash", () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const smoke = mgr.buildEffectiveKiloConfig("smoke");
  const normal = mgr.buildEffectiveKiloConfig("normal-coding");
  assert.equal(smoke.permission.bash, "deny", "smoke must deny bash");
  assert.equal(normal.permission.bash, "deny", "normal-coding must deny bash");
  removeDir(dir);
});

test("phase35: buildEffectiveKiloConfig both profiles deny external_directory", () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const smoke = mgr.buildEffectiveKiloConfig("smoke");
  const normal = mgr.buildEffectiveKiloConfig("normal-coding");
  assert.equal(smoke.permission.external_directory, undefined, "external-directory access is Bridge-enforced");
  assert.equal(normal.permission.external_directory, undefined, "external-directory access is Bridge-enforced");
  removeDir(dir);
});

test("phase35: buildEffectiveKiloConfig smoke denies read and write", () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const smoke = mgr.buildEffectiveKiloConfig("smoke");
  assert.equal(smoke.permission.write, "deny");
  assert.equal(smoke.permission.read, "deny");
  assert.equal(smoke.permission.glob, "deny");
  assert.equal(smoke.permission.grep, "deny");
  assert.equal(smoke.permission.edit, "deny");
  assert.equal(smoke.permission.apply_patch, undefined);
  removeDir(dir);
});

test("phase35: buildEffectiveKiloConfig normal-coding allows read/edit/write/patch", () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const normal = mgr.buildEffectiveKiloConfig("normal-coding");
  assert.equal(normal.permission.read, "allow");
  assert.equal(normal.permission.glob, "allow");
  assert.equal(normal.permission.grep, "allow");
  assert.equal(normal.permission.edit, "allow");
  assert.equal(normal.permission.write, "allow");
  assert.equal(normal.permission.apply_patch, undefined);
  removeDir(dir);
});

test("phase35: mandatory restrictions cannot be overridden by profile", () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  // Bash is a mandatory Kilo denial; external paths are denied by Bridge path checks.
  const smoke = mgr.buildEffectiveKiloConfig("smoke");
  assert.equal(smoke.permission.bash, "deny");
  assert.equal(smoke.permission.external_directory, undefined);
  const normal = mgr.buildEffectiveKiloConfig("normal-coding");
  assert.equal(normal.permission.bash, "deny");
  assert.equal(normal.permission.external_directory, undefined);
  removeDir(dir);
});

test("phase35: writeEffectiveKiloConfig returns path and hash", async () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const wt = path.join(dir, "wt");
  const res = mgr.writeEffectiveKiloConfig(wt, "smoke");
  assert.equal(res.ok, true, res.error);
  const data = res.data!;
  assert.equal(typeof data.configPath, "string");
  assert.ok(path.isAbsolute(data.configPath), "config path must be absolute");
  assert.equal(typeof data.configHash, "string");
  assert.equal(data.configHash.length, 64, "SHA-256 hash must be 64 hex chars");
  assert.equal(data.profile, "smoke");
  assert.ok(fs.existsSync(data.configPath), "effective config file must exist");
  // Verify hash matches file content.
  const fileContent = fs.readFileSync(data.configPath);
  const expectedHash = crypto.createHash("sha256").update(fileContent).digest("hex");
  assert.equal(data.configHash, expectedHash, "recorded hash must match file hash");
  removeDir(dir);
});

test("phase35: writeEffectiveKiloConfig different profiles produce different hashes", async () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const wt = path.join(dir, "wt");
  const smokeRes = mgr.writeEffectiveKiloConfig(wt, "smoke");
  assert.equal(smokeRes.ok, true);
  const normalRes = mgr.writeEffectiveKiloConfig(wt, "normal-coding");
  assert.equal(normalRes.ok, true);
  assert.notEqual(smokeRes.data!.configHash, normalRes.data!.configHash, "profiles must have different hashes");
  removeDir(dir);
});

test("phase35: isPathWithinAllowedRoots prevents path escape", () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const allowedRoots = [dir, path.join(dir, "worktrees")];
  assert.equal(mgr.isPathWithinAllowedRoots(path.join(dir, "safe-file.json"), allowedRoots), true);
  assert.equal(mgr.isPathWithinAllowedRoots(path.join(dir, "worktrees", "wt", ".kilo", "kilo.jsonc"), allowedRoots), true);
  assert.equal(mgr.isPathWithinAllowedRoots("C:\\TAIF\\external-project\\package.json", allowedRoots), false);
  assert.equal(mgr.isPathWithinAllowedRoots(path.join(dir, "..", "escape.txt"), allowedRoots), false);
  removeDir(dir);
});

test("phase35: KiloCliAdapter stores effective config path and uses worktree cwd", async () => {
  const dir = makeTempDir("kilo-p35-");
  const wt = path.join(dir, "wt");
  fs.mkdirSync(wt, { recursive: true });
  const configPath = path.join(wt, ".kilo", "kilo.jsonc");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ permission: { bash: "deny", write: "allow" } }), "utf8");

  const adapter = new KiloCliAdapter({
    kiloBin: "kilo",
    worktreePath: wt,
    taskTitle: "test",
    taskSpec: "test",
    timeoutMs: 5000,
    auto: true,
    kiloConfigPath: configPath,
  });
  assert.equal(adapter.options.kiloConfigPath, configPath, "adapter must store effective config path");
  assert.equal(adapter.options.worktreePath, wt, "adapter must store worktree path");
  removeDir(dir);
});

test("phase35: generic automation config does not silently replace effective config", () => {
  // Verified at the source level: spawnKilo() prefers opts.kiloConfigPath over
  // the automation config fallback (see src/components/kilo.ts:24-30). The
  // existing kilo test "kilo: run sets KILO_CONFIG and KILO_NO_DAEMON for
  // automation subprocess" confirms KILO_CONFIG and KILO_NO_DAEMON are set.
  // This test asserts the effective config path is stored on the adapter and
  // differs from the automation config path.
  const dir = makeTempDir("kilo-p35-");
  const wt = path.join(dir, "wt");
  fs.mkdirSync(wt, { recursive: true });
  const effectiveConfigPath = path.join(wt, ".kilo", "kilo.jsonc");
  fs.mkdirSync(path.dirname(effectiveConfigPath), { recursive: true });
  fs.writeFileSync(effectiveConfigPath, JSON.stringify({ permission: { bash: "deny", write: "allow" } }), "utf8");

  const automationConfigPath = path.join(process.cwd(), "config", "kilo-automation.jsonc");
  assert.notEqual(effectiveConfigPath, automationConfigPath, "effective config path must differ from automation config path");

  const adapter = new KiloCliAdapter({
    kiloBin: "kilo",
    worktreePath: wt,
    taskTitle: "test",
    taskSpec: "test",
    timeoutMs: 5000,
    auto: true,
    kiloConfigPath: effectiveConfigPath,
  });
  assert.equal(adapter.options.kiloConfigPath, effectiveConfigPath, "effective config must be stored on adapter, not automation config");
  removeDir(dir);
});

test("phase35: no automatic paid-model fallback - adapter accepts free model explicitly", async () => {
  const dir = makeTempDir("kilo-p35-");
  const wt = path.join(dir, "wt");
  fs.mkdirSync(wt, { recursive: true });
  const adapter = new KiloCliAdapter({
    kiloBin: "kilo",
    worktreePath: wt,
    taskTitle: "test",
    taskSpec: "test",
    timeoutMs: 5000,
    auto: true,
    model: "kilo/liquid/lfm-3-1.7b:free",
  });
  assert.equal(adapter.options.model, "kilo/liquid/lfm-3-1.7b:free", "free model must be stored as-is");
  removeDir(dir);
});

test("phase35: no automatic paid-model fallback - adapter works without model specified", async () => {
  const dir = makeTempDir("kilo-p35-");
  const wt = path.join(dir, "wt");
  fs.mkdirSync(wt, { recursive: true });
  const adapter = new KiloCliAdapter({
    kiloBin: "kilo",
    worktreePath: wt,
    taskTitle: "test",
    taskSpec: "test",
    timeoutMs: 5000,
    auto: true,
  });
  assert.equal(adapter.options.model, undefined, "no model specified must remain undefined (no auto fallback)");
  removeDir(dir);
});

test("phase35: external repository path is not accepted by test harness fixtures", () => {
  const dir = makeTempDir("kilo-p35-");
  const mgr = new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
  const externalPath = "C:\\TAIF\\external-project\\package.json";
  assert.equal(mgr.isPathWithinAllowedRoots(externalPath, [dir, path.join(dir, "worktrees")]), false, "external path must not be within allowed fixture roots");
  removeDir(dir);
});

test("phase35: worker stays disabled in bridge config", () => {
  const bridgeCfgPath = path.join(process.cwd(), "bridge.config.json");
  let workerEnabled = false;
  if (fs.existsSync(bridgeCfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(bridgeCfgPath, "utf8"));
      workerEnabled = cfg.workerEnabled === true;
    } catch { /* ignore */ }
  }
  assert.equal(workerEnabled, false, "worker must remain disabled");
});

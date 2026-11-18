"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SecurityManager, buildKiloPermissionConfig, findMissingDenials } from "../src/components/security";
import { makeTempDir, removeDir, makeProjectConfig } from "./helpers/fixtures";

function makeManager(dir: string) {
  return new SecurityManager("test-project", path.join(dir, "worktrees"), dir);
}

test("security: generated kilo.json passes denial assertions", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const policy = mgr.generatePolicy(makeProjectConfig());
  const wt = path.join(dir, "wt");
  const r = mgr.writeKiloPermissionFile(wt, policy);
  assert.equal(r.ok, true, r.error);
  const config = JSON.parse(fs.readFileSync(path.join(wt, "kilo.json"), "utf8"));
  assert.deepEqual(findMissingDenials(config), []);
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.external_directory, "deny");
  assert.equal(config.permission.read, "allow");
  assert.equal(config.permission.write, "allow");
  removeDir(dir);
});

test("security: verifyEffectivePermissions accepts valid config (kilo check skipped)", async () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const wt = path.join(dir, "wt");
  mgr.writeKiloPermissionFile(wt, mgr.generatePolicy(makeProjectConfig()));
  const r = await mgr.verifyEffectivePermissions(wt, { skipKiloCheck: true });
  assert.equal(r.ok, true, r.error);
  removeDir(dir);
});

test("security: missing config refused", async () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const r = await mgr.verifyEffectivePermissions(path.join(dir, "nope"), { skipKiloCheck: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "PERMISSION_CONFIG_MISSING");
  removeDir(dir);
});

test("security: tampered config (bash allow) refused", async () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const wt = path.join(dir, "wt");
  mgr.writeKiloPermissionFile(wt, mgr.generatePolicy(makeProjectConfig()));
  const file = path.join(wt, "kilo.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.permission.bash = "allow"; // simulate global-config bleed / tampering
  fs.writeFileSync(file, JSON.stringify(config), "utf8");
  const r = await mgr.verifyEffectivePermissions(wt, { skipKiloCheck: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "PERMISSION_DENIALS_MISSING");
  removeDir(dir);
});

test("security: removing a single required denial is detected", () => {
  const config = buildKiloPermissionConfig("C:\\TAIF\\KILO-BRIDGE") as any;
  delete config.permission.bash;
  const missing = findMissingDenials(config);
  assert.ok(missing.some((m) => m.includes('permission.bash = "deny"')), "missing bash denial");
});

test("security: policy validation requires all denials", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const policy = mgr.generatePolicy(makeProjectConfig());
  assert.equal(mgr.validatePolicy(policy).ok, true);
  const broken = { ...policy, denyGitPush: false };
  const r = mgr.validatePolicy(broken);
  assert.equal(r.ok, false);
  assert.equal(r.code, "POLICY_INCOMPLETE");
  removeDir(dir);
});

test("security: path traversal and external paths rejected", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const wt = path.join(dir, "wt");
  assert.equal(mgr.isPathWithinWorktree(wt, "src/index.ts"), true);
  assert.equal(mgr.isPathWithinWorktree(wt, "."), true);
  assert.equal(mgr.isPathWithinWorktree(wt, "..\\..\\windows\\system32"), false);
  assert.equal(mgr.isPathWithinWorktree(wt, "../../etc/passwd"), false);
  assert.equal(mgr.isPathWithinWorktree(wt, "C:\\Windows\\system32"), false);
  assert.equal(mgr.isPathWithinWorktree(wt, "C:\\TAIF\\scs-platform\\package.json"), false);
  // Case-insensitive containment on Windows.
  assert.equal(mgr.isPathWithinWorktree(wt, wt.toUpperCase() + "\\src\\x.ts"), true);
  removeDir(dir);
});

test("security: redaction removes tokens but preserves git SHAs", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const sha = "a".repeat(40);
  const sha256 = "b".repeat(64);
  const text = `commit ${sha} sha256 ${sha256} token ghp_${"x".repeat(36)} key sk-${"y".repeat(30)} pat github_pat_${"z".repeat(30)}`;
  const out = mgr.redactSecrets(text);
  assert.ok(out.includes(sha), "40-char SHA preserved");
  assert.ok(out.includes(sha256), "64-char SHA preserved");
  assert.ok(!out.includes("ghp_"), "ghp token redacted");
  assert.ok(!out.includes("sk-"), "sk token redacted");
  assert.ok(!out.includes("github_pat_"), "github pat redacted");
  removeDir(dir);
});

test("security: bridge command policy denies prohibited operations", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  for (const cmd of [
    "pnpm db:migrate", "pnpm db:seed", "pnpm db:reset", "pnpm infra:up", "pnpm infra:down",
    "git push origin main", "git commit -m x", "git merge develop", "rm -rf /", "kubectl apply",
  ]) {
    assert.equal(mgr.isCommandDenied(cmd), true, `should deny: ${cmd}`);
  }
  for (const cmd of ["pnpm lint", "pnpm test:unit", "git status", "git diff"]) {
    assert.equal(mgr.isCommandDenied(cmd), false, `should allow: ${cmd}`);
  }
  removeDir(dir);
});

test("security: bridge command policy file written", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const wt = path.join(dir, "wt");
  const r = mgr.writeBridgeCommandPolicy(wt);
  assert.equal(r.ok, true);
  const policy = JSON.parse(fs.readFileSync(r.data!, "utf8"));
  assert.equal(policy.defaultAction, "deny");
  assert.ok(policy.rules.some((x: any) => x.command === "git push" && x.action === "deny"));
  removeDir(dir);
});

test("security: project kilo config is deny-by-default", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const config = mgr.buildKiloProjectConfig();
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.external_directory, "deny");
  assert.equal(config.permission.read, "allow");
  assert.equal(config.permission.edit, "allow");
  assert.equal(config.permission.write, "allow");
  removeDir(dir);
});

test("security: project kilo config written to .kilo/kilo.jsonc", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const wt = path.join(dir, "wt");
  const r = mgr.writeKiloProjectConfig(wt);
  assert.equal(r.ok, true, r.error);
  const file = path.join(wt, ".kilo", "kilo.jsonc");
  assert.equal(fs.existsSync(file), true, "kilo.jsonc should exist in .kilo/");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.read, "allow");
  assert.equal(config.permission.write, "allow");
  removeDir(dir);
});

test("security: automation kilo config is deny-by-default", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const config = mgr.buildKiloAutomationConfig();
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.external_directory, "deny");
  assert.equal(config.permission.read, "allow");
  assert.equal(config.permission.glob, "allow");
  assert.equal(config.permission.edit, "allow");
  removeDir(dir);
});

test("security: findMissingDenials detects missing bash denial", () => {
  const config: any = {
    permission: {
      bash: "allow", // tampered: bash allowed
      external_directory: "deny",
    },
  };
  const missing = findMissingDenials(config);
  assert.ok(missing.some((m) => m.includes('permission.bash = "deny"')), "missing bash denial");
});

test("security: findMissingDenials detects missing external_directory denial", () => {
  const config: any = {
    permission: {
      bash: "deny",
    },
  };
  const missing = findMissingDenials(config);
  assert.ok(missing.some((m) => m.includes('permission.external_directory = "deny"')), "missing external_directory denial");
});

test("security: isCommandDenied blocks injection attempts", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  // Command injection via chaining with prohibited sub-commands.
  for (const cmd of [
    "pnpm lint; db:migrate",
    "pnpm typecheck && git push origin main",
    "pnpm test:unit || db:reset",
    "pnpm build | kubectl apply",
    "pnpm format:check `gh auth login`",
  ]) {
    assert.equal(mgr.isCommandDenied(cmd), true, `should deny injection: ${cmd}`);
  }
  // Safe commands with shell metacharacters are NOT denied (no prohibited sub-command).
  for (const cmd of ["pnpm lint; git status", "pnpm typecheck && git diff"]) {
    assert.equal(mgr.isCommandDenied(cmd), false, `should allow safe chained: ${cmd}`);
  }
  removeDir(dir);
});

test("security: e2e-smoke config allows only write", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const config = mgr.buildKiloE2ESmokeConfig();
  // Only write is allowed
  assert.equal(config.permission.write, "allow");
  // Everything else denied
  assert.equal(config.permission.read, "deny");
  assert.equal(config.permission.glob, "deny");
  assert.equal(config.permission.grep, "deny");
  assert.equal(config.permission.edit, "deny");
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.lsp, "deny");
  assert.equal(config.permission.external_directory, "deny");
  removeDir(dir);
});

test("security: e2e-smoke config written to .kilo/kilo.jsonc passes kilo config check", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const wt = path.join(dir, "wt");
  const r = mgr.writeKiloE2ESmokeConfig(wt);
  assert.equal(r.ok, true, r.error);
  const file = path.join(wt, ".kilo", "kilo.jsonc");
  assert.equal(fs.existsSync(file), true, "kilo.jsonc should exist in .kilo/");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.write, "allow");
  assert.equal(config.permission.read, "deny");
  removeDir(dir);
});

test("security: normal coding config allows read/edit/write, denies bash", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const config = mgr.buildKiloNormalCodingConfig();
  // Allowed for coding
  assert.equal(config.permission.read, "allow");
  assert.equal(config.permission.glob, "allow");
  assert.equal(config.permission.grep, "allow");
  assert.equal(config.permission.edit, "allow");
  assert.equal(config.permission.write, "allow");
  assert.equal(config.permission.apply_patch, "allow");
  // Denied
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.external_directory, "deny");
  removeDir(dir);
});

test("security: normal coding config written to .kilo/kilo.jsonc", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const wt = path.join(dir, "wt");
  const r = mgr.writeKiloNormalCodingConfig(wt);
  assert.equal(r.ok, true, r.error);
  const file = path.join(wt, ".kilo", "kilo.jsonc");
  assert.equal(fs.existsSync(file), true, "kilo.jsonc should exist in .kilo/");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.permission.read, "allow");
  assert.equal(config.permission.edit, "allow");
  assert.equal(config.permission.write, "allow");
  assert.equal(config.permission.bash, "deny");
  removeDir(dir);
});

test("security: smoke and normal-coding profiles are different", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const smoke = mgr.buildKiloE2ESmokeConfig();
  const normal = mgr.buildKiloNormalCodingConfig();
  // Smoke denies read, normal allows it
  assert.equal(smoke.permission.read, "deny");
  assert.equal(normal.permission.read, "allow");
  // Smoke denies write? No, smoke allows write
  assert.equal(smoke.permission.write, "allow");
  assert.equal(normal.permission.write, "allow");
  // Both deny bash
  assert.equal(smoke.permission.bash, "deny");
  assert.equal(normal.permission.bash, "deny");
  // Smoke denies edit, normal allows it
  assert.equal(smoke.permission.edit, "deny");
  assert.equal(normal.permission.edit, "allow");
  removeDir(dir);
});

test("security: normal coding profile passes kilo config check", () => {
  const dir = makeTempDir("kilo-sec-");
  const mgr = makeManager(dir);
  const wt = path.join(dir, "wt");
  const r = mgr.writeKiloNormalCodingConfig(wt);
  assert.equal(r.ok, true, r.error);
  const file = path.join(wt, ".kilo", "kilo.jsonc");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.read, "allow");
  assert.equal(config.permission.external_directory, "deny");
  removeDir(dir);
});
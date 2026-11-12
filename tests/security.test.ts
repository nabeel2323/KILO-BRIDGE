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
  assert.equal(config.permission.bash["*"], "deny");
  assert.equal(config.permission.external_directory, "deny");
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
  delete config.permission.bash["git push*"];
  const missing = findMissingDenials(config);
  assert.ok(missing.some((m) => m.includes("git push*")));
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
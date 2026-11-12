"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ProjectRegistry, type RegistryDeps } from "../src/components/registry";
import type { ProjectConfig, SecurityPolicy } from "../src/types";

function makeRegistry(): { registry: ProjectRegistry; state: Map<string, { config: ProjectConfig; state: string }> } {
  const state = new Map<string, { config: ProjectConfig; state: string }>();
  const policies = new Map<string, SecurityPolicy>();
  const deps: RegistryDeps = {
    upsertProject: (config, s) => state.set(config.id, { config, state: s }),
    getProject: (id) => state.get(id) ?? null,
    listProjects: () => [...state.values()],
    setProjectState: (id, s) => {
      const e = state.get(id);
      if (e) e.state = s;
    },
    getSecurityPolicy: (pid) => policies.get(pid) ?? null,
    upsertSecurityPolicy: (p) => policies.set(p.projectId, p),
  };
  return { registry: new ProjectRegistry(deps), state };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "demo-project",
    name: "Demo",
    repository: "owner/repo",
    localPath: "C:\\projects\\demo",
    baseBranch: "develop",
    worktreeRoot: "C:\\worktrees\\demo",
    branchPrefix: "ai/kilo",
    allowedAuthors: ["owner"],
    verificationCommands: ["pnpm test"],
    ...overrides,
  };
}

test("registry: add/list/get/inspect/enable/disable", () => {
  const { registry } = makeRegistry();
  const added = registry.add(validInput() as any);
  assert.equal(added.ok, true, added.error);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("demo-project")!.state, "active");
  assert.equal(registry.disable("demo-project").ok, true);
  assert.equal(registry.get("demo-project")!.state, "disabled");
  assert.equal(registry.enable("demo-project").ok, true);
  assert.equal(registry.get("demo-project")!.state, "active");
  const inspected = registry.inspect("demo-project");
  assert.equal(inspected.ok, true);
  assert.equal(inspected.data!.config.id, "demo-project");
});

test("registry: duplicate registration rejected", () => {
  const { registry } = makeRegistry();
  registry.add(validInput() as any);
  const dup = registry.add(validInput() as any);
  assert.equal(dup.ok, false);
  assert.equal(dup.code, "PROJECT_EXISTS");
});

test("registry: invalid configs rejected", () => {
  const { registry } = makeRegistry();
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["bad id", { id: "Bad ID!" }, "INVALID_PROJECT"],
    ["bad repo", { repository: "not-a-repo" }, "INVALID_PROJECT"],
    ["relative localPath", { localPath: "projects\\demo" }, "INVALID_PATH"],
    ["relative worktreeRoot", { worktreeRoot: "worktrees\\demo" }, "INVALID_PATH"],
    ["worktree inside repo", { worktreeRoot: "C:\\projects\\demo\\wt" }, "WORKTREE_NOT_ISOLATED"],
    ["repo inside worktree", { localPath: "C:\\worktrees\\demo\\repo" }, "WORKTREE_NOT_ISOLATED"],
    ["empty authors", { allowedAuthors: [] }, "INVALID_PROJECT"],
    ["empty baseBranch", { baseBranch: "" }, "INVALID_PROJECT"],
    ["missing name", { name: "" }, "INVALID_PROJECT"],
  ];
  for (const [label, overrides, code] of cases) {
    const r = registry.validate(validInput(overrides) as any);
    assert.equal(r.ok, false, `case should fail: ${label}`);
    assert.equal(r.code, code, `case ${label}: got ${r.code} (${r.error})`);
  }
});

test("registry: multiple independent projects", () => {
  const { registry } = makeRegistry();
  assert.equal(registry.add(validInput({ id: "p1", repository: "o/p1" }) as any).ok, true);
  assert.equal(registry.add(validInput({ id: "p2", repository: "o/p2", localPath: "C:\\projects\\p2", worktreeRoot: "C:\\worktrees\\p2" }) as any).ok, true);
  assert.equal(registry.list().length, 2);
  registry.disable("p1");
  assert.equal(registry.get("p1")!.state, "disabled");
  assert.equal(registry.get("p2")!.state, "active");
});

test("registry: all templates produce valid configs", () => {
  const { registry } = makeRegistry();
  for (const type of ["node", "laravel", "django", "odoo", "flutter", "other"]) {
    const tpl = ProjectRegistry.template(type);
    const input = {
      ...tpl,
      id: `tpl-${type}`,
      name: `Template ${type}`,
      repository: `owner/${type}-repo`,
      localPath: `C:\\projects\\${type}`,
      baseBranch: "develop",
      worktreeRoot: `C:\\worktrees\\${type}`,
      allowedAuthors: ["owner"],
    };
    const r = registry.validate(input as any);
    assert.equal(r.ok, true, `template ${type}: ${r.error}`);
  }
});

test("registry: laravel template does not auto-install packages", () => {
  const tpl = ProjectRegistry.template("laravel");
  assert.ok(!tpl.verificationCommands!.some((c) => /install/i.test(c)));
});

test("registry: scsPlatform preset matches spec", () => {
  const scs = ProjectRegistry.scsPlatform();
  assert.equal(scs.id, "scs-platform");
  assert.equal(scs.repository, "nabeel2323/scs-platform");
  assert.equal(scs.baseBranch, "develop");
  assert.equal(scs.releaseBranch, "main");
  assert.deepEqual(scs.allowedAuthors, ["nabeel2323"]);
  assert.deepEqual(scs.verificationCommands, ["pnpm lint", "pnpm typecheck", "pnpm test:unit", "pnpm build"]);
  assert.deepEqual(scs.advisoryCommands, ["pnpm format:check"]);
  assert.deepEqual(scs.conditionalVerification, ["pnpm --filter @scs/api test:coverage"]);
  assert.equal(scs.publishingEnabled, false);
});

test("registry: example project files are valid", () => {
  const { registry } = makeRegistry();
  const dir = path.join(__dirname, "..", "..", "examples", "projects");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const input = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const r = registry.validate(input);
    assert.equal(r.ok, true, `${f}: ${r.error}`);
  }
});
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runProcess } from "../src/components/process";
import { makeTempDir, removeDir } from "./helpers/fixtures";

const CLI = path.join(__dirname, "..", "..", "dist", "cli.js");

function runCli(root: string, args: string[]) {
  const ghBin = process.env.TEMP + "\\gh\\bin";
  return runProcess(process.execPath, [CLI, ...args], {
    cwd: root,
    timeoutMs: 60000,
    env: { KILO_BRIDGE_ROOT: root, PATH: process.env.PATH + ";" + ghBin },
  });
}

const projectInput = {
  id: "cli-project",
  name: "CLI Project",
  repository: "owner/cli-repo",
  localPath: "C:\\projects\\cli-project",
  baseBranch: "develop",
  worktreeRoot: "C:\\worktrees\\cli-project",
  branchPrefix: "ai/kilo",
  allowedAuthors: ["owner"],
  verificationCommands: ["node --version"],
};

test("cli: init creates db, dirs and config", async () => {
  const root = makeTempDir("kilo-cli-");
  const r = await runCli(root, ["init"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(root, "data", "kilo-bridge.sqlite")));
  assert.ok(fs.existsSync(path.join(root, "bridge.config.json")));
  assert.ok(fs.existsSync(path.join(root, "logs")));
  assert.ok(fs.existsSync(path.join(root, "reports")));
  removeDir(root);
});

test("cli: projects add/validate/list/enable/disable/inspect round-trip", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const file = path.join(root, "project.json");
  fs.writeFileSync(file, JSON.stringify(projectInput), "utf8");

  const validate = await runCli(root, ["projects", "validate", file, "--json"]);
  assert.equal(validate.code, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).id, "cli-project");

  const add = await runCli(root, ["projects", "add", file]);
  assert.equal(add.code, 0, add.stderr);

  const list = await runCli(root, ["projects", "list", "--json"]);
  assert.equal(list.code, 0);
  const projects = JSON.parse(list.stdout);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, "cli-project");
  assert.equal(projects[0].state, "active");

  const disable = await runCli(root, ["projects", "disable", "cli-project"]);
  assert.equal(disable.code, 0);
  const inspect = await runCli(root, ["projects", "inspect", "cli-project"]);
  assert.equal(inspect.code, 0);
  assert.equal(JSON.parse(inspect.stdout).state, "disabled");

  const enable = await runCli(root, ["projects", "enable", "cli-project"]);
  assert.equal(enable.code, 0);
  const inspect2 = await runCli(root, ["projects", "inspect", "cli-project"]);
  assert.equal(JSON.parse(inspect2.stdout).state, "active");
  removeDir(root);
});

test("cli: invalid project config rejected with clear error", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const bad = { ...projectInput, repository: "not-a-repo" };
  const r = await runCli(root, ["projects", "validate", JSON.stringify(bad)]);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("validate failed"));
  removeDir(root);
});

test("cli: duplicate project add rejected", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  await runCli(root, ["projects", "add", JSON.stringify(projectInput)]);
  const dup = await runCli(root, ["projects", "add", JSON.stringify(projectInput)]);
  assert.equal(dup.code, 1);
  assert.ok(dup.stderr.includes("already registered"));
  removeDir(root);
});

test("cli: worker start refused until explicitly enabled", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const r = await runCli(root, ["worker", "start", "--project", "cli-project"]);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("worker is disabled"));
  removeDir(root);
});

test("cli: configure set workerEnabled persists and gates the worker", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const set = await runCli(root, ["configure", "set", "workerEnabled", "true"]);
  assert.equal(set.code, 0, set.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "bridge.config.json"), "utf8"));
  assert.equal(cfg.workerEnabled, true);
  // Invalid key rejected.
  const bad = await runCli(root, ["configure", "set", "notAKey", "1"]);
  assert.equal(bad.code, 1);
  removeDir(root);
});

test("cli: status and tasks --json are parseable", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const status = await runCli(root, ["status", "--json"]);
  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.worker.running, false);
  assert.ok(Array.isArray(parsed.projects));
  const tasks = await runCli(root, ["tasks", "--json"]);
  assert.equal(tasks.code, 0);
  assert.deepEqual(JSON.parse(tasks.stdout), []);
  removeDir(root);
});

test("cli: unknown command exits 1 with help", async () => {
  const root = makeTempDir("kilo-cli-");
  const r = await runCli(root, ["frobnicate"]);
  assert.equal(r.code, 1);
  removeDir(root);
});

test("cli: projects template prints valid JSON for each type", async () => {
  const root = makeTempDir("kilo-cli-");
  for (const type of ["node", "laravel", "django", "odoo", "flutter"]) {
    const r = await runCli(root, ["projects", "template", type]);
    assert.equal(r.code, 0);
    const tpl = JSON.parse(r.stdout);
    assert.equal(tpl.projectType, type);
  }
  removeDir(root);
});

test("cli: dry-run worker discovers tasks without executing (mock gh)", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  await runCli(root, ["projects", "add", JSON.stringify(projectInput)]);
  const r = await runCli(root, ["worker", "start", "--dry-run", "--project", "cli-project", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.mode, "dry-run");
  assert.equal(data.results[0].project, "cli-project");
  removeDir(root);
});

test("cli: doctor prints each check with status", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const r = await runCli(root, ["doctor"]);
  assert.equal(r.code, 0, r.stderr);
  const output = r.stdout;
  assert.ok(output.includes("node:"), "should list node check");
  assert.ok(output.includes("git:"), "should list git check");
  assert.ok(output.includes("gh:"), "should list gh check");
  assert.ok(output.includes("kilo:"), "should list kilo check");
  assert.ok(output.includes("sqlite:"), "should list sqlite check");
  assert.ok(output.includes("bridge.config.json:"), "should list config check");
  assert.ok(output.includes("workerEnabled:"), "should list workerEnabled check");
  assert.ok(output.includes("projects:"), "should list projects check");
  assert.ok(output.includes("scs-platform project:"), "should list scs-project check");
  removeDir(root);
});

test("cli: doctor JSON output is parseable", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const r = await runCli(root, ["doctor", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.ok(Array.isArray(data.checks));
  assert.ok(data.checks.some((c: any) => c.name === "node"));
  assert.ok(data.checks.some((c: any) => c.name === "gh"));
  assert.ok(data.checks.some((c: any) => c.name === "kilo"));
  assert.ok(data.checks.some((c: any) => c.name === "sqlite"));
  assert.ok(data.checks.some((c: any) => c.name === "workerEnabled"));
  assert.ok(data.checks.some((c: any) => c.name === "scs-platform project"));
  for (const c of data.checks) {
    assert.ok(["PASS", "FAIL", "WARNING"].includes(c.status));
    assert.ok(c.condition);
    assert.ok(c.explanation);
    assert.ok(c.remediation);
  }
  removeDir(root);
});

test("cli: root --help prints usage", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const r = await runCli(root, ["--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("Kilo Bridge V1.0"));
  assert.ok(r.stdout.includes("Usage: kilo-bridge <command>"));
  assert.ok(r.stdout.includes("init"));
  assert.ok(r.stdout.includes("doctor"));
  assert.ok(r.stdout.includes("projects"));
  assert.ok(r.stdout.includes("task execute"));
  removeDir(root);
});

test("cli: root --h is alias for --help", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const r = await runCli(root, ["-h"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("Kilo Bridge V1.0"));
  removeDir(root);
});

test("cli: unknown command exits 1 with message", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const r = await runCli(root, ["frobnicate"]);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("unknown command: frobnicate"));
  removeDir(root);
});

test("cli: projects validate --help prints usage", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const r = await runCli(root, ["projects", "validate", "--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("Validate a project configuration JSON"));
  removeDir(root);
});

test("cli: projects validate missing arg exits 1", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const r = await runCli(root, ["projects", "validate"]);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("usage: kilo-bridge projects validate"));
  removeDir(root);
});

test("cli: projects validate invalid JSON exits 1", async () => {
  const root = makeTempDir("kilo-cli-");
  await runCli(root, ["init"]);
  const r = await runCli(root, ["projects", "validate", "not-json"]);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("invalid JSON input"));
  removeDir(root);
});
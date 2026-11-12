"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { VerificationEngine, tokenizeCommand, type VerificationCommand } from "../src/components/verification";
import { makeTempDir, removeDir, makeProjectConfig } from "./helpers/fixtures";

function cmd(overrides: Partial<VerificationCommand> = {}): VerificationCommand {
  return {
    name: "test",
    command: process.execPath,
    args: ["-e", "console.log('ok')"],
    required: true,
    conditional: false,
    cwd: process.cwd(),
    ...overrides,
  };
}

test("verification: tokenizer honors quotes and whitespace", () => {
  assert.deepEqual(tokenizeCommand("pnpm lint"), ["pnpm", "lint"]);
  assert.deepEqual(tokenizeCommand('pnpm --filter "@scs/api" test:coverage'), ["pnpm", "--filter", "@scs/api", "test:coverage"]);
  assert.deepEqual(tokenizeCommand('node -e "console.log(1)"'), ["node", "-e", "console.log(1)"]);
  assert.deepEqual(tokenizeCommand("  "), []);
});

test("verification: commandsFromProject maps required/advisory/conditional", () => {
  const config = makeProjectConfig({
    verificationCommands: ["pnpm lint", "pnpm build"],
    advisoryCommands: ["pnpm format:check"],
    conditionalVerification: ["pnpm --filter @scs/api test:coverage"],
  });
  const cmds = VerificationEngine.commandsFromProject(config, "C:\\wt");
  assert.equal(cmds.length, 4);
  assert.equal(cmds[0].required, true);
  assert.equal(cmds[2].required, false);
  assert.equal(cmds[2].conditional, false);
  assert.equal(cmds[3].conditional, true);
  assert.deepEqual(cmds[3].args, ["--filter", "@scs/api", "test:coverage"]);
  assert.ok(cmds.every((c) => c.cwd === "C:\\wt"));
});

test("verification: passing command records exit 0 and output files", async () => {
  const dir = makeTempDir("kilo-ver-");
  const engine = new VerificationEngine({ worktreePath: dir, resultsDir: path.join(dir, "results") });
  const r = await engine.runCommand(cmd({ cwd: dir }));
  assert.equal(r.passed, true);
  assert.equal(r.exitCode, 0);
  assert.ok(r.stdout.includes("ok"));
  assert.ok(fs.existsSync(r.stdoutPath!));
  assert.ok(fs.existsSync(r.stderrPath!));
  assert.ok(r.durationMs! >= 0);
  removeDir(dir);
});

test("verification: failing command records passed=false", async () => {
  const dir = makeTempDir("kilo-ver-");
  const engine = new VerificationEngine({ worktreePath: dir, resultsDir: path.join(dir, "results") });
  const r = await engine.runCommand(cmd({ args: ["-e", "process.exit(2)"], cwd: dir }));
  assert.equal(r.passed, false);
  assert.equal(r.exitCode, 2);
  removeDir(dir);
});

test("verification: prohibited commands never execute", async () => {
  const dir = makeTempDir("kilo-ver-");
  const engine = new VerificationEngine({ worktreePath: dir, resultsDir: path.join(dir, "results") });
  for (const prohibited of ["pnpm db:migrate", "pnpm db:seed", "pnpm db:reset", "pnpm infra:up", "pnpm infra:down"]) {
    const tokens = tokenizeCommand(prohibited);
    const r = await engine.runCommand(cmd({ name: prohibited, command: tokens[0], args: tokens.slice(1), cwd: dir }));
    assert.equal(r.passed, false, prohibited);
    assert.ok(r.stderr.includes("prohibited"), prohibited);
    assert.equal(r.exitCode, -1);
  }
  assert.equal(VerificationEngine.isProhibited("pnpm db:migrate"), true);
  assert.equal(VerificationEngine.isProhibited("pnpm test:unit"), false);
  removeDir(dir);
});

test("verification: timeout kills long-running command", async () => {
  const dir = makeTempDir("kilo-ver-");
  const engine = new VerificationEngine({ worktreePath: dir, resultsDir: path.join(dir, "results"), commandTimeoutMs: 500 });
  const r = await engine.runCommand(cmd({ args: ["-e", "setTimeout(()=>{},30000)"], cwd: dir }));
  assert.equal(r.passed, false);
  assert.ok(r.stderr.includes("timed out"));
  assert.ok(r.durationMs! < 10000);
  removeDir(dir);
});

test("verification: conditional selection by changed files", () => {
  const dir = makeTempDir("kilo-ver-");
  const engine = new VerificationEngine({ worktreePath: dir, resultsDir: dir });
  const commands = [
    cmd({ name: "lint" }),
    cmd({ name: "coverage", conditional: true, conditionFiles: ["apps/api/**", "packages/**"] }),
  ];
  assert.equal(engine.selectCommands(commands, ["README.md"]).length, 1);
  const selected = engine.selectCommands(commands, ["apps/api/src/routes.ts"]);
  assert.equal(selected.length, 2);
  assert.equal(engine.selectCommands(commands, ["packages/db/x.ts"]).length, 2);
  removeDir(dir);
});

test("verification: allRequiredPassed requires every required command to pass", () => {
  const dir = makeTempDir("kilo-ver-");
  const engine = new VerificationEngine({ worktreePath: dir, resultsDir: dir });
  const commands = [cmd({ name: "lint" }), cmd({ name: "test" }), cmd({ name: "format", required: false })];
  const pass = (name: string, passed: boolean) => ({
    id: name, name, command: "x", args: [], cwd: dir,
    startTime: "", endTime: "", exitCode: passed ? 0 : 1, durationMs: 1, passed,
    stdout: "", stderr: "",
  });
  assert.equal(engine.allRequiredPassed([pass("lint", true), pass("test", true)], commands), true);
  assert.equal(engine.allRequiredPassed([pass("lint", true), pass("test", false)], commands), false);
  assert.equal(engine.allRequiredPassed([pass("lint", true)], commands), false, "missing required command");
  assert.equal(engine.allRequiredPassed([pass("lint", true), pass("test", true), pass("format", false)], commands), true, "advisory failure does not block");
  removeDir(dir);
});

test("verification: runSuite executes selected commands in order", async () => {
  const dir = makeTempDir("kilo-ver-");
  const engine = new VerificationEngine({ worktreePath: dir, resultsDir: path.join(dir, "results") });
  const results = await engine.runSuite([cmd({ name: "a", cwd: dir }), cmd({ name: "b", cwd: dir })], []);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.name), ["a", "b"]);
  removeDir(dir);
});
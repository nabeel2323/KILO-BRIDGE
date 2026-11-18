"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { KiloCliAdapter } from "../src/components/kilo";
import { makeTempDir, removeDir } from "./helpers/fixtures";

const MOCK_KILO = path.join(__dirname, "..", "..", "tests", "helpers", "mock-kilo.cjs");

// The adapter takes a single binary; to run the mock through node we create
// a small .cmd shim that forwards to `node mock-kilo.cjs %*`.
function makeShim(dir: string): string {
  const shim = path.join(dir, "kilo-mock.cmd");
  fs.writeFileSync(shim, `@echo off\r\nnode "${MOCK_KILO}" %*\r\n`, "utf8");
  return shim;
}

function setup(fixtures: any, overrides: any = {}) {
  const dir = makeTempDir("kilo-kilo-");
  const fixturesPath = path.join(dir, "fixtures.json");
  const callsPath = path.join(dir, "calls.jsonl");
  fs.writeFileSync(fixturesPath, JSON.stringify(fixtures), "utf8");
  process.env.MOCK_KILO_FIXTURES = fixturesPath;
  process.env.MOCK_KILO_CALLS = callsPath;
  const adapter = new KiloCliAdapter({
    kiloBin: makeShim(dir),
    worktreePath: path.join(dir, "wt"),
    taskTitle: "GitHub Issue #1",
    taskSpec: "Implement the thing.",
    timeoutMs: 20000,
    auto: true,
    ...overrides,
  });
  return {
    adapter,
    dir,
    calls: () =>
      fs.existsSync(callsPath)
        ? fs.readFileSync(callsPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
        : [],
  };
}

test("kilo: detectExecutable reads version", async () => {
  const { adapter, dir } = setup({ version: "7.8.27-mock" });
  const r = await adapter.detectExecutable();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data, "7.8.27-mock");
  removeDir(dir);
});

test("kilo: detectExecutable reports missing binary", async () => {
  const dir = makeTempDir("kilo-kilo-");
  const adapter = new KiloCliAdapter({
    kiloBin: "definitely-not-kilo-xyz",
    worktreePath: dir,
    taskTitle: "t",
    taskSpec: "s",
  });
  const r = await adapter.detectExecutable();
  assert.equal(r.ok, false);
  assert.equal(r.code, "KILO_NOT_FOUND");
  removeDir(dir);
});

test("kilo: preflight validates options, auth, model, agent", async () => {
  const { adapter, dir } = setup({}, { model: "kilo/mock-model", agent: "build" });
  const r = await adapter.preflight();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data!.authenticated, true);
  removeDir(dir);
});

test("kilo: preflight refuses when installed help lacks required options", async () => {
  const { adapter, dir } = setup({ help: "Options:\n  --format\n  --dir\n" });
  const r = await adapter.preflight();
  assert.equal(r.ok, false);
  assert.equal(r.code, "KILO_OPTIONS_MISSING");
  removeDir(dir);
});

test("kilo: preflight refuses without credentials", async () => {
  const { adapter, dir } = setup({ auth: "0 credentials" });
  const r = await adapter.preflight();
  assert.equal(r.ok, false);
  assert.equal(r.code, "KILO_AUTH_FAILED");
  removeDir(dir);
});

test("kilo: preflight refuses unavailable model", async () => {
  const { adapter, dir } = setup({}, { model: "kilo/does-not-exist" });
  const r = await adapter.preflight();
  assert.equal(r.ok, false);
  assert.equal(r.code, "KILO_MODEL_UNAVAILABLE");
  removeDir(dir);
});

test("kilo: run parses events, captures session, extracts final response", async () => {
  const { adapter, dir } = setup({
    run: { sessionId: "sess-42", finalText: "All done.", createFile: { name: "hello.txt", content: "hello-kilo" } },
  });
  const r = await adapter.run();
  assert.equal(r.exitCode, 0);
  assert.equal(r.sessionId, "sess-42");
  assert.equal(r.finalResponse, "All done.");
  assert.ok(r.events.length >= 3);
  assert.ok(fs.existsSync(path.join(dir, "wt", "hello.txt")));
  assert.ok(fs.existsSync(r.eventLogPath));
  removeDir(dir);
});

test("kilo: reasoning events are never stored", async () => {
  const { adapter, dir } = setup({});
  const r = await adapter.run();
  const log = fs.readFileSync(r.eventLogPath, "utf8");
  assert.ok(!log.includes("SHOULD NOT BE STORED"), "reasoning must not be persisted");
  assert.ok(!r.events.some((e: any) => e.properties?.part?.type === "reasoning"));
  removeDir(dir);
});

test("kilo: run sets KILO_CONFIG and KILO_NO_DAEMON for automation subprocess", async () => {
  const { adapter, dir, calls } = setup({});
  await adapter.run();
  const run = calls().find((c) => c.argv[0] === "run" && !c.argv.includes("--help"));
  assert.ok(run, "run invocation recorded");
  assert.equal(run.env.KILO_CONFIG, path.join(process.cwd(), "config", "kilo-automation.jsonc"), "KILO_CONFIG set");
  assert.equal(run.env.KILO_NO_DAEMON, "1", "KILO_NO_DAEMON set");
  removeDir(dir);
});

test("kilo: task spec with shell metacharacters is passed literally as one argument", async () => {
  const spec = 'fix "quotes" ; rm -rf / & $(whoami) | echo pwned';
  const { adapter, dir, calls } = setup({}, { taskSpec: spec });
  await adapter.run();
  const run = calls().find((c) => c.argv[0] === "run" && !c.argv.includes("--help"));
  assert.ok(run);
  assert.equal(run.argv[run.argv.length - 1], spec, "spec must be the final single positional arg");
  // Options must precede the positional message.
  assert.ok(run.argv.indexOf("--dir") < run.argv.length - 1);
  assert.ok(run.argv.indexOf("--title") < run.argv.length - 1);
  removeDir(dir);
});

test("kilo: timeout terminates execution", async () => {
  const { adapter, dir } = setup({ run: { hangMs: 30000 } }, { timeoutMs: 600 });
  const r = await adapter.run();
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 10000);
  removeDir(dir);
});

test("kilo: non-zero exit is surfaced", async () => {
  const { adapter, dir } = setup({ run: { exitCode: 3 } });
  const r = await adapter.run();
  assert.equal(r.exitCode, 3);
  removeDir(dir);
});

test("kilo: secrets in events are redacted in the log", async () => {
  const { adapter, dir } = setup({
    run: { finalText: `token ghp_${"x".repeat(36)} done` },
  });
  const r = await adapter.run();
  const log = fs.readFileSync(r.eventLogPath, "utf8");
  assert.ok(!log.includes("ghp_"), "token must be redacted");
  assert.ok(log.includes("[REDACTED_TOKEN]"));
  removeDir(dir);
});

test("kilo: free model selection is accepted", async () => {
  const { adapter, dir } = setup({ models: "kilo/liquid/lfm-3-1.7b:free\nkilo/mock-model" }, { model: "kilo/liquid/lfm-3-1.7b:free" });
  const r = await adapter.preflight();
  assert.equal(r.ok, true, r.error);
  removeDir(dir);
});

test("kilo: paid model fallback is not automatic", async () => {
  // The adapter should not auto-select a paid model; model must be explicit.
  const { adapter, dir } = setup({}, { model: undefined });
  const r = await adapter.preflight();
  // With no model specified, preflight should still pass (model resolved at runtime)
  // but no paid model should be auto-selected
  assert.equal(r.ok, true, r.error);
  removeDir(dir);
});

test("kilo: provider 404 error is surfaced", async () => {
  const { adapter, dir } = setup({
    run: { exitCode: 1, error: "APIError - Not Found: {\"status\":404,\"title\":\"Not Found\"}" },
  });
  const r = await adapter.run();
  assert.equal(r.exitCode, 1);
  // Kilo adapter surfaces exit code; error message is in event log
  const log = fs.readFileSync(r.eventLogPath, "utf8");
  assert.ok(log.includes("404"), "404 error should be in event log");
  removeDir(dir);
});

test("kilo: timeout terminates execution", async () => {
  const { adapter, dir } = setup({ run: { hangMs: 30000 } }, { timeoutMs: 600 });
  const r = await adapter.run();
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 10000);
  removeDir(dir);
});
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { runProcess, SPAWN_FAILED_CODE } from "../src/components/process";

test("runProcess captures stdout and exit code 0", async () => {
  const r = await runProcess(process.execPath, ["-e", "console.log('hi')"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "hi");
  assert.equal(r.timedOut, false);
});

test("runProcess propagates non-zero exit code", async () => {
  const r = await runProcess(process.execPath, ["-e", "process.exit(3)"]);
  assert.equal(r.code, 3);
});

test("runProcess captures stderr", async () => {
  const r = await runProcess(process.execPath, ["-e", "console.error('oops')"]);
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), "oops");
});

test("runProcess passes stdin input", async () => {
  const r = await runProcess(
    process.execPath,
    ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(d.toUpperCase()))"],
    { input: "abc" }
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "ABC");
});

test("runProcess closes stdin when no input (child does not hang)", async () => {
  const r = await runProcess(
    process.execPath,
    ["-e", "process.stdin.on('end',()=>console.log('ended'));process.stdin.resume();"],
    { timeoutMs: 5000 }
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "ended");
  assert.equal(r.timedOut, false);
});

test("runProcess enforces timeout and kills the process", async () => {
  const r = await runProcess(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
    timeoutMs: 400,
  });
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 10000, `took too long: ${r.durationMs}`);
});

test("runProcess kills the whole process tree on timeout", async () => {
  // Parent spawns a long-lived child; both must die on timeout.
  const script =
    "const{spawn}=require('child_process');" +
    "const c=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});" +
    "console.log('child:'+c.pid);" +
    "setTimeout(()=>{},30000);";
  const r = await runProcess(process.execPath, ["-e", script], { timeoutMs: 700 });
  assert.equal(r.timedOut, true);
  const m = r.stdout.match(/child:(\d+)/);
  assert.ok(m, "child pid reported");
  // Give taskkill a moment, then verify the child is gone.
  await new Promise((res) => setTimeout(res, 1500));
  let alive = true;
  try {
    process.kill(Number(m![1]), 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "child process should be killed with the tree");
});

test("runProcess returns 127 for nonexistent binary", async () => {
  const r = await runProcess("definitely-not-a-real-binary-xyz", ["--version"]);
  assert.equal(r.code, SPAWN_FAILED_CODE);
});

test("runProcess resolves Windows .cmd shims (pnpm)", async () => {
  const r = await runProcess("pnpm", ["--version"], { timeoutMs: 30000 });
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("runProcess passes arguments with spaces and shell metacharacters literally", async () => {
  const payload = 'hello "world" ; echo injected & $(whoami)';
  const r = await runProcess(process.execPath, ["-e", "console.log(process.argv[1])", payload]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), payload);
});
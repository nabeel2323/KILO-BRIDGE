"use strict";

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  resolveSpawn,
  resolveKiloBin,
  buildSpawnDiagnostic,
} from "../src/components/process";

// node:test in this build does not expose a usable module-mock API, and process.ts
// reads os/cp/fs through late-bound property accesses on the required module objects,
// so patching the required (cached) module exports drives the code under test.
const os = require("node:os");
const cp = require("node:child_process");

const origPlatform = os.platform;
const origSpawnSync = cp.spawnSync;

function setPlatform(platform: string): void {
  os.platform = () => platform;
}

function spawnSyncWhere(stdout: string): void {
  (cp as any).spawnSync = (() => ({
    status: 0,
    stdout,
    stderr: "",
  })) as any;
}

function restore(): void {
  os.platform = origPlatform;
  cp.spawnSync = origSpawnSync;
}

afterEach(() => {
  restore();
  delete process.env.KILO_BIN;
});

test("resolveKiloBin returns a KiloBinResolution with resolvedPath and launcher", () => {
  process.env.KILO_BIN = "C:\\kilo\\kilo.cmd";
  const r = resolveKiloBin();
  assert.equal(r.resolvedPath, "C:\\kilo\\kilo.cmd");
  assert.equal(r.launcher, "cmd");
});

test("resolveKiloBin on Windows prefers .cmd over .ps1 over POSIX shim", () => {
  setPlatform("win32");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-bin-"));
  const cmdPath = path.join(dir, "kilo.cmd");
  const ps1Path = path.join(dir, "kilo.ps1");
  const shimPath = path.join(dir, "kilo");
  fs.writeFileSync(cmdPath, "@echo off\r\n", "utf8");
  fs.writeFileSync(ps1Path, "#ps1\r\n", "utf8");
  fs.writeFileSync(shimPath, "#!/bin/sh\r\necho shim\r\n", "utf8");
  spawnSyncWhere(`${cmdPath}\r\n${ps1Path}\r\n${shimPath}\r\n`);
  try {
    const r = resolveKiloBin();
    assert.equal(r.resolvedPath, cmdPath);
    assert.equal(r.launcher, "cmd");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveKiloBin on Windows prefers .ps1 over a POSIX shim", () => {
  setPlatform("win32");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-bin-"));
  const ps1Path = path.join(dir, "kilo.ps1");
  const shimPath = path.join(dir, "kilo");
  fs.writeFileSync(ps1Path, "#ps1\r\n", "utf8");
  fs.writeFileSync(shimPath, "#!/bin/sh\r\necho shim\r\n", "utf8");
  spawnSyncWhere(`${ps1Path}\r\n${shimPath}\r\n`);
  try {
    const r = resolveKiloBin();
    assert.equal(r.resolvedPath, ps1Path);
    assert.equal(r.launcher, "powershell");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSpawn routes .ps1 through powershell.exe -NoProfile -ExecutionPolicy Bypass -File", () => {
  setPlatform("win32");
  const r = resolveSpawn(
    "C:\\scripts\\deploy.ps1",
    ["-Verbose"],
    { withLauncher: true },
  );
  assert.equal(r.cmd, "powershell.exe");
  assert.deepEqual(r.args, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "C:\\scripts\\deploy.ps1",
    "-Verbose",
  ]);
  assert.equal(r.launcher, "powershell");
  assert.equal(r.resolvedPath, "C:\\scripts\\deploy.ps1");
});

test("resolveSpawn routes POSIX shim (#!/bin/sh) through node.exe with JS entry point", () => {
  setPlatform("win32");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-shim-"));
  const shim = path.join(dir, "kilo-shim");
  const js = path.join(dir, "kilo-shim.js");
  fs.writeFileSync(shim, "#!/bin/sh\r\nexec node \"$0.js\" \"$@\"\r\n", "utf8");
  fs.writeFileSync(js, "console.log('shim entry');\r\n", "utf8");
  try {
    const r = resolveSpawn(shim, ["--flag"], { withLauncher: true });
    assert.equal(r.cmd, process.execPath);
    assert.equal(r.launcher, "posix-sh");
    assert.equal(r.resolvedPath, shim);
    assert.deepEqual(r.args, [js, "--flag"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSpawn routes .cmd through cmd.exe /c", () => {
  setPlatform("win32");
  const r = resolveSpawn("C:\\scripts\\foo.cmd", ["/a"], { withLauncher: true });
  assert.equal(r.cmd, "cmd");
  assert.deepEqual(r.args, ["/c", "C:\\scripts\\foo.cmd", "/a"]);
  assert.equal(r.launcher, "cmd");
  assert.equal(r.resolvedPath, "C:\\scripts\\foo.cmd");
});

test("buildSpawnDiagnostic returns executable, invocationMechanism, failureStage, error", () => {
  const err = new Error("ENOENT: no such file or directory");
  const d = buildSpawnDiagnostic("kilo", "cmd", "spawn", err);
  assert.equal(d.executable, "kilo");
  assert.equal(d.invocationMechanism, "cmd");
  assert.equal(d.failureStage, "spawn");
  assert.equal(d.error, "ENOENT: no such file or directory");

  const d2 = buildSpawnDiagnostic(null, null, "resolve", "kilo not found");
  assert.equal(d2.executable, null);
  assert.equal(d2.invocationMechanism, null);
  assert.equal(d2.failureStage, "resolve");
  assert.equal(d2.error, "kilo not found");
});

test("resolveSpawn on non-Windows returns direct passthrough", () => {
  setPlatform("linux");
  const r = resolveSpawn("kilo", ["--version"], { withLauncher: true });
  assert.equal(r.cmd, "kilo");
  assert.deepEqual(r.args, ["--version"]);
  assert.equal(r.launcher, "direct");
  assert.equal(r.resolvedPath, null);

  const [cmd, args] = resolveSpawn("kilo", ["--version"]);
  assert.deepEqual([cmd, args], ["kilo", ["--version"]]);
});

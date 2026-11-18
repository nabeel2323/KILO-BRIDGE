"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, removeDir } from "./helpers/fixtures";
import { ExclusiveProcessLock } from "../src/components/processLock";

test("process lock: atomic acquisition rejects a second live owner and releases by token", () => {
  const dir = makeTempDir("kilo-lock-");
  const lockPath = path.join(dir, "service.lock");
  const first = new ExclusiveProcessLock(lockPath, "intake-test");
  const second = new ExclusiveProcessLock(lockPath, "intake-test-2");

  assert.equal(first.acquire().ok, true);
  assert.equal(first.isHeldByThisInstance(), true);
  const blocked = second.acquire();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "LOCK_HELD");

  first.release();
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(second.acquire().ok, true);
  second.release();
  removeDir(dir);
});

test("process lock: dead owner is reconciled but malformed locks fail closed", () => {
  const dir = makeTempDir("kilo-lock-stale-");
  const lockPath = path.join(dir, "service.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 99999999,
    owner: "dead-test",
    token: "stale-token",
    acquiredAt: new Date(0).toISOString(),
  }));
  const next = new ExclusiveProcessLock(lockPath, "next-owner", () => false);
  assert.equal(next.acquire().ok, true);
  next.release();

  fs.writeFileSync(lockPath, "{not-json");
  const blocked = new ExclusiveProcessLock(lockPath, "must-fail-closed").acquire();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "LOCK_UNCERTAIN");
  assert.equal(fs.readFileSync(lockPath, "utf8"), "{not-json");
  removeDir(dir);
});

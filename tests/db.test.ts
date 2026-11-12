"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { SqliteStore } from "../src/db";
import { makeTempDir, removeDir, makeProjectConfig, makeTaskRecord } from "./helpers/fixtures";

async function openStore(): Promise<{ store: SqliteStore; dir: string; dbPath: string }> {
  const dir = makeTempDir("kilo-db-");
  const dbPath = path.join(dir, "test.sqlite");
  const store = new SqliteStore(dbPath);
  await store.open();
  return { store, dir, dbPath };
}

test("db: open creates file and migrations are idempotent on reopen", async () => {
  const { store, dir, dbPath } = await openStore();
  assert.ok(fs.existsSync(dbPath));
  store.close();
  const store2 = new SqliteStore(dbPath);
  await store2.open();
  store2.close();
  removeDir(dir);
});

test("db: project upsert/get/list/state round-trip", async () => {
  const { store, dir } = await openStore();
  const cfg = makeProjectConfig();
  store.upsertProject(cfg, "active");
  const got = store.getProject(cfg.id);
  assert.ok(got);
  assert.equal(got!.config.repository, cfg.repository);
  assert.equal(got!.state, "active");
  store.setProjectState(cfg.id, "disabled");
  assert.equal(store.getProject(cfg.id)!.state, "disabled");
  const cfg2 = makeProjectConfig({ id: "second-project", repository: "o/second" });
  store.upsertProject(cfg2, "active");
  assert.equal(store.listProjects().length, 2);
  store.close();
  removeDir(dir);
});

test("db: task round-trip, idempotency and project+issue lookup", async () => {
  const { store, dir } = await openStore();
  const task = makeTaskRecord();
  store.upsertTask(task);
  const got = store.getTask(task.id);
  assert.ok(got);
  assert.equal(got!.issueNumber, task.issueNumber);
  assert.equal(got!.status, "READY");
  assert.ok(store.getTaskByIdempotencyKey(task.idempotencyKey));
  const byIssue = store.getTaskByProjectIssue(task.projectId, task.issueNumber);
  assert.ok(byIssue);
  assert.equal(byIssue!.id, task.id);
  assert.equal(store.getTaskByProjectIssue(task.projectId, 999), null);
  store.close();
  removeDir(dir);
});

test("db: mutations survive crash (persist-on-write, no close)", async () => {
  const { store, dir, dbPath } = await openStore();
  const task = makeTaskRecord({ leaseHolder: "worker-1", leaseExpiresAt: new Date(Date.now() + 60000).toISOString() });
  store.upsertTask(task);
  // Simulate crash: do NOT close. A fresh store must see the persisted lease.
  const store2 = new SqliteStore(dbPath);
  await store2.open();
  const recovered = store2.getTask(task.id);
  assert.ok(recovered, "task must survive without close()");
  assert.equal(recovered!.leaseHolder, "worker-1");
  store2.close();
  store.close();
  removeDir(dir);
});

test("db: transitions, executions, verifications, reports", async () => {
  const { store, dir } = await openStore();
  const task = makeTaskRecord();
  store.upsertTask(task);
  store.insertTransition({ id: "tr1", taskId: task.id, fromStatus: "READY", toStatus: "CLAIMED", actor: "w", createdAt: new Date().toISOString() });
  assert.equal(store.listTransitions(task.id).length, 1);

  store.upsertExecution({ id: "ex1", taskId: task.id, attempt: 1, status: "RUNNING", startTime: new Date().toISOString() });
  store.upsertExecution({ id: "ex1", taskId: task.id, attempt: 1, status: "COMPLETED", startTime: new Date().toISOString(), endTime: new Date().toISOString(), exitCode: 0, durationMs: 1234, kiloVersion: "7.8.27", kiloSessionId: "sess-1" });
  const execs = store.listExecutions(task.id);
  assert.equal(execs.length, 1);
  assert.equal(execs[0].status, "COMPLETED");
  assert.equal(execs[0].kiloSessionId, "sess-1");

  store.insertVerification({ executionId: "ex1", command: "pnpm", args: ["lint"], cwd: "C:\\x", startTime: new Date().toISOString(), endTime: new Date().toISOString(), exitCode: 0, durationMs: 10, passed: true });
  const vs = store.listVerifications("ex1");
  assert.equal(vs.length, 1);
  assert.equal(vs[0].passed, true);
  assert.deepEqual(vs[0].args, ["lint"]);

  store.upsertReport({ id: "rep1", taskId: task.id, executionId: "ex1", status: "COMPLETE", reportPath: "C:\\r.md", createdAt: new Date().toISOString() });
  const reps = store.getReports(task.id);
  assert.equal(reps.length, 1);
  assert.equal(reps[0].status, "COMPLETE");
  store.close();
  removeDir(dir);
});

test("db: security policy and meta round-trip", async () => {
  const { store, dir } = await openStore();
  store.upsertSecurityPolicy({
    projectId: "p1", denyShellUnapproved: true, allowWorktreeOnly: true, denySensitivePaths: true,
    denyExternalPaths: true, protectBridgeConfig: true, denyGitPush: true, denyGitCommit: true,
    denyGitMerge: true, denyDeploy: true, denyDbMigrate: true, denyDbReset: true, denyDbProdAccess: true,
    createdAt: new Date().toISOString(),
  });
  assert.ok(store.getSecurityPolicy("p1"));
  assert.equal(store.getSecurityPolicy("missing"), null);
  store.setMeta("worker.pid", "1234");
  assert.equal(store.getMeta("worker.pid"), "1234");
  store.setMeta("worker.pid", "5678");
  assert.equal(store.getMeta("worker.pid"), "5678");
  store.close();
  removeDir(dir);
});

test("db: audit insert/list and status-list queries", async () => {
  const { store, dir } = await openStore();
  store.insertAudit({ projectId: "p1", actor: "tester", action: "test.action", detail: "d1" });
  store.insertAudit({ action: "global.action" });
  assert.equal(store.listAudit("p1").length, 1);
  assert.equal(store.listAudit().length, 2);

  store.upsertTask(makeTaskRecord({ id: "t1", status: "CLAIMED" }));
  store.upsertTask(makeTaskRecord({ id: "t2", status: "RUNNING" }));
  store.upsertTask(makeTaskRecord({ id: "t3", status: "READY" }));
  const leased = store.listTasksByStatuses(["CLAIMED", "RUNNING"]);
  assert.equal(leased.length, 2);
  assert.deepEqual(store.listTasksByStatuses([]), []);
  store.close();
  removeDir(dir);
});
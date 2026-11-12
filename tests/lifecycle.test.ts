"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { LifecycleManager, validateTaskAuthor, isPullRequest, MAX_TASK_ATTEMPTS } from "../src/components/lifecycle";
import type { TaskRecord, TaskTransition, TaskStatus } from "../src/types";
import { makeTaskRecord } from "./helpers/fixtures";

function makeManager() {
  const tasks = new Map<string, TaskRecord>();
  const transitions: TaskTransition[] = [];
  const mgr = new LifecycleManager({
    getTask: (id) => tasks.get(id) ?? null,
    upsertTask: (t) => tasks.set(t.id, t),
    insertTransition: (t) => transitions.push(t),
    listTasksByStatuses: (statuses) => [...tasks.values()].filter((t) => statuses.includes(t.status)),
  });
  return { mgr, tasks, transitions };
}

test("lifecycle: all spec transitions are legal", () => {
  const { mgr } = makeManager();
  const legal: Array<[TaskStatus | null, TaskStatus]> = [
    [null, "READY"],
    ["READY", "CLAIMED"],
    ["CLAIMED", "RUNNING"],
    ["RUNNING", "REPORT_READY"],
    ["RUNNING", "BLOCKED"],
    ["RUNNING", "FAILED"],
    ["REPORT_READY", "CHANGES_REQUESTED"],
    ["CHANGES_REQUESTED", "RUNNING"],
    ["REPORT_READY", "PUBLISH_APPROVED"],
    ["PUBLISH_APPROVED", "PUBLISHED"],
    ["REPORT_READY", "DONE"],
  ];
  for (const [from, to] of legal) {
    assert.equal(mgr.isValidTransition(from, to), true, `${from} -> ${to} should be legal`);
  }
});

test("lifecycle: illegal transitions rejected", () => {
  const { mgr, tasks } = makeManager();
  assert.equal(mgr.isValidTransition("READY", "RUNNING"), false);
  assert.equal(mgr.isValidTransition("DONE", "RUNNING"), false);
  assert.equal(mgr.isValidTransition("PUBLISHED", "RUNNING"), false);
  const t = makeTaskRecord({ status: "READY" });
  tasks.set(t.id, t);
  const r = mgr.transition(t.id, "PUBLISHED", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "ILLEGAL_TRANSITION");
});

test("lifecycle: transition records history and updates status", () => {
  const { mgr, tasks, transitions } = makeManager();
  const t = makeTaskRecord({ status: "READY" });
  tasks.set(t.id, t);
  const r = mgr.transition(t.id, "CLAIMED", { reason: "test", actor: "w1" });
  assert.equal(r.ok, true);
  assert.equal(r.data!.status, "CLAIMED");
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].fromStatus, "READY");
  assert.equal(transitions[0].toStatus, "CLAIMED");
});

test("lifecycle: expectedStatus guard prevents races", () => {
  const { mgr, tasks } = makeManager();
  const t = makeTaskRecord({ status: "RUNNING" });
  tasks.set(t.id, t);
  const r = mgr.transition(t.id, "REPORT_READY", { expectedStatus: "CLAIMED" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "STATUS_MISMATCH");
});

test("lifecycle: claim keeps attempt at 1 and sets lease", () => {
  const { mgr, tasks } = makeManager();
  const t = makeTaskRecord({ status: "READY", attempt: 1 });
  tasks.set(t.id, t);
  const r = mgr.claimTask(t.id, "worker-1", 60000);
  assert.equal(r.ok, true);
  assert.equal(r.data!.status, "CLAIMED");
  assert.equal(r.data!.attempt, 1);
  assert.equal(r.data!.leaseHolder, "worker-1");
  assert.ok(r.data!.leaseExpiresAt);
});

test("lifecycle: duplicate claim by same holder is idempotent", () => {
  const { mgr, tasks, transitions } = makeManager();
  const t = makeTaskRecord({ status: "READY" });
  tasks.set(t.id, t);
  mgr.claimTask(t.id, "worker-1", 60000);
  const again = mgr.claimTask(t.id, "worker-1", 60000);
  assert.equal(again.ok, true);
  assert.equal(transitions.length, 1, "no duplicate transition");
});

test("lifecycle: valid lease held by another worker is never stolen", () => {
  const { mgr, tasks } = makeManager();
  const t = makeTaskRecord({ status: "READY" });
  tasks.set(t.id, t);
  mgr.claimTask(t.id, "worker-1", 60000);
  const other = mgr.claimTask(t.id, "worker-2", 60000);
  assert.equal(other.ok, false);
  assert.equal(other.code, "LEASE_HELD");
});

test("lifecycle: non-READY task cannot be claimed", () => {
  const { mgr, tasks } = makeManager();
  const t = makeTaskRecord({ status: "DONE" });
  tasks.set(t.id, t);
  const r = mgr.claimTask(t.id, "worker-1", 60000);
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_READY");
});

test("lifecycle: expired lease recovery returns task to READY", () => {
  const { mgr, tasks } = makeManager();
  const t = makeTaskRecord({
    status: "RUNNING",
    attempt: 1,
    leaseHolder: "dead-worker",
    leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  tasks.set(t.id, t);
  const recovered = mgr.recoverExpiredLeases("recovery");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "READY");
  assert.equal(recovered[0].leaseHolder, undefined);
  // Re-claim works after recovery.
  const r = mgr.claimTask(t.id, "worker-2", 60000);
  assert.equal(r.ok, true);
});

test("lifecycle: expired lease at max attempts fails the task", () => {
  const { mgr, tasks } = makeManager();
  const t = makeTaskRecord({
    status: "RUNNING",
    attempt: MAX_TASK_ATTEMPTS,
    leaseHolder: "dead-worker",
    leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  tasks.set(t.id, t);
  const recovered = mgr.recoverExpiredLeases("recovery");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "FAILED");
});

test("lifecycle: valid leases are not recovered", () => {
  const { mgr, tasks } = makeManager();
  const t = makeTaskRecord({
    status: "RUNNING",
    leaseHolder: "live-worker",
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  tasks.set(t.id, t);
  assert.equal(mgr.recoverExpiredLeases("recovery").length, 0);
  assert.equal(tasks.get(t.id)!.status, "RUNNING");
});

test("lifecycle: beginCorrection bumps attempt and preserves history", () => {
  const { mgr, tasks, transitions } = makeManager();
  const t = makeTaskRecord({ status: "REPORT_READY", attempt: 1 });
  tasks.set(t.id, t);
  const r = mgr.beginCorrection(t.id, "owner", "fix the bug");
  assert.equal(r.ok, true);
  assert.equal(r.data!.status, "RUNNING");
  assert.equal(r.data!.attempt, 2);
  const tos = transitions.map((x) => x.toStatus);
  assert.deepEqual(tos, ["CHANGES_REQUESTED", "RUNNING"]);
});

test("lifecycle: beginCorrection rejected for non-report states", () => {
  const { mgr, tasks } = makeManager();
  const t = makeTaskRecord({ status: "READY" });
  tasks.set(t.id, t);
  const r = mgr.beginCorrection(t.id, "owner", "x");
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_REPORT_READY");
});

test("lifecycle: author validation and PR exclusion", () => {
  assert.equal(validateTaskAuthor("alice", ["alice", "bob"]).ok, true);
  const r = validateTaskAuthor("mallory", ["alice"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "UNAUTHORIZED_AUTHOR");
  assert.equal(isPullRequest({ pullRequest: true }), true);
  assert.equal(isPullRequest({ pullRequest: false }), false);
  assert.equal(isPullRequest({}), false);
});

test("lifecycle: idempotency key is stable per project+issue", () => {
  const { mgr } = makeManager();
  const a = mgr.generateIdempotencyKey("p1", 42);
  const b = mgr.generateIdempotencyKey("p1", 42);
  const c = mgr.generateIdempotencyKey("p2", 42);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
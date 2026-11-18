"use strict";

import crypto from "node:crypto";
import type {
  BridgeResult,
  TaskRecord,
  TaskStatus,
  TaskTransition,
  ProjectConfig,
} from "../types";
import { TASK_STATUSES, okResult, failResult, MAX_TASK_ATTEMPTS } from "../types";

export interface LifecycleDeps {
  getTask: (id: string) => TaskRecord | null;
  upsertTask: (t: TaskRecord) => void;
  insertTransition: (t: TaskTransition) => void;
  listTasksByStatuses: (statuses: string[]) => TaskRecord[];
}

export { MAX_TASK_ATTEMPTS } from "../types";

const ALLOWED_TRANSITIONS: Array<{ from: TaskStatus | null; to: TaskStatus }> = [
  { from: null, to: "READY" },
  { from: "READY", to: "CLAIMED" },
  { from: "CLAIMED", to: "RUNNING" },
  { from: "RUNNING", to: "REPORT_READY" },
  { from: "RUNNING", to: "BLOCKED" },
  { from: "RUNNING", to: "FAILED" },
  { from: "REPORT_READY", to: "CHANGES_REQUESTED" },
  { from: "CHANGES_REQUESTED", to: "RUNNING" },
  { from: "REPORT_READY", to: "PUBLISH_APPROVED" },
  { from: "REPORT_READY", to: "PUBLISHED" },
  { from: "PUBLISH_APPROVED", to: "PUBLISHED" },
  { from: "REPORT_READY", to: "DONE" },
  { from: "BLOCKED", to: "RUNNING" },
  { from: "FAILED", to: "RUNNING" },
  { from: "PUBLISHED", to: "DONE" },
];

function isAllowed(from: TaskStatus | null, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export class LifecycleManager {
  private readonly deps: LifecycleDeps;

  constructor(deps: LifecycleDeps) {
    this.deps = deps;
  }

  isValidTransition(from: TaskStatus | null, to: TaskStatus): boolean {
    return isAllowed(from, to);
  }

  allowedNext(status: TaskStatus | null): TaskStatus[] {
    return ALLOWED_TRANSITIONS.filter((t) => t.from === status).map((t) => t.to);
  }

  transition(
    taskId: string,
    to: TaskStatus,
    opts: { reason?: string; actor?: string; expectedStatus?: TaskStatus }
  ): BridgeResult<TaskRecord> {
    const task = this.deps.getTask(taskId);
    if (!task) {
      return failResult(`task ${taskId} not found`, "TASK_NOT_FOUND");
    }

    const from = task.status;
    if (opts.expectedStatus && from !== opts.expectedStatus) {
      return failResult(
        `task ${taskId} is in status ${from}, expected ${opts.expectedStatus}`,
        "STATUS_MISMATCH"
      );
    }

    if (!isAllowed(from, to)) {
      return failResult(`illegal transition ${from} -> ${to}`, "ILLEGAL_TRANSITION");
    }

    const now = new Date().toISOString();
    const transitionId = crypto.randomUUID();
    this.deps.insertTransition({
      id: transitionId,
      taskId,
      fromStatus: from,
      toStatus: to,
      reason: opts.reason ?? undefined,
      actor: opts.actor ?? undefined,
      createdAt: now,
    });

    const terminal = ["REPORT_READY", "FAILED", "PUBLISHED", "DONE", "BLOCKED"];
    const updated: TaskRecord = { ...task, status: to, updatedAt: now,
      ...(terminal.includes(to) ? { leaseHolder: undefined, leaseExpiresAt: undefined } : {}) };
    this.deps.upsertTask(updated);
    return okResult(updated);
  }

  resumeClaim(
    taskId: string,
    leaseHolder: string,
    leaseTtlMs: number = 10 * 60 * 1000
  ): BridgeResult<TaskRecord> {
    const task = this.deps.getTask(taskId);
    if (!task) {
      return failResult(`task ${taskId} not found`, "TASK_NOT_FOUND");
    }
    if (task.status !== "CLAIMED" && task.status !== "RUNNING") {
      return failResult(
        `task ${taskId} is not CLAIMED/RUNNING (status ${task.status})`,
        "NOT_CLAIMED"
      );
    }
    const leaseValid = task.leaseExpiresAt && new Date(task.leaseExpiresAt) > new Date();
    if (leaseValid && task.leaseHolder !== leaseHolder) {
      return failResult(`task ${taskId} lease held by ${task.leaseHolder}`, "LEASE_HELD");
    }
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs).toISOString();
    const updated: TaskRecord = {
      ...task,
      status: "CLAIMED",
      leaseHolder,
      leaseExpiresAt,
      updatedAt: now.toISOString(),
    };
    this.deps.upsertTask(updated);
    return okResult(updated);
  }

  claimTask(
    taskId: string,
    leaseHolder: string,
    leaseTtlMs: number
  ): BridgeResult<TaskRecord> {
    const task = this.deps.getTask(taskId);
    if (!task) {
      return failResult(`task ${taskId} not found`, "TASK_NOT_FOUND");
    }

    if (task.status !== "READY") {
      // Idempotent: same holder re-claims a task it still holds a valid lease on.
      if (
        task.leaseHolder === leaseHolder &&
        task.leaseExpiresAt &&
        new Date(task.leaseExpiresAt) > new Date()
      ) {
        return okResult(task);
      }
      // A valid lease held by another worker must not be stolen.
      if (
        task.leaseHolder &&
        task.leaseHolder !== leaseHolder &&
        task.leaseExpiresAt &&
        new Date(task.leaseExpiresAt) > new Date()
      ) {
        return failResult(`task ${taskId} lease held by ${task.leaseHolder}`, "LEASE_HELD");
      }
      return failResult(
        `task ${taskId} is not READY (status ${task.status})`,
        "NOT_READY"
      );
    }

    // A valid lease held by another worker must not be stolen (READY case).
    if (
      task.leaseHolder &&
      task.leaseHolder !== leaseHolder &&
      task.leaseExpiresAt &&
      new Date(task.leaseExpiresAt) > new Date()
    ) {
      return failResult(`task ${taskId} lease held by ${task.leaseHolder}`, "LEASE_HELD");
    }

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs).toISOString();
    const transitionId = crypto.randomUUID();

    this.deps.insertTransition({
      id: transitionId,
      taskId,
      fromStatus: task.status,
      toStatus: "CLAIMED",
      reason: "claimed by worker",
      actor: leaseHolder,
      createdAt: now.toISOString(),
    });

    const updated: TaskRecord = {
      ...task,
      status: "CLAIMED",
      leaseHolder,
      leaseExpiresAt,
      attempt: task.attempt ?? 1,
      updatedAt: now.toISOString(),
    };
    this.deps.upsertTask(updated);
    return okResult(updated);
  }

  releaseLease(taskId: string): BridgeResult<void> {
    const task = this.deps.getTask(taskId);
    if (!task) return failResult(`task ${taskId} not found`, "TASK_NOT_FOUND");
    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...task,
      leaseHolder: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    };
    this.deps.upsertTask(updated);
    return okResult();
  }

  isLeaseExpired(task: TaskRecord): boolean {
    if (!task.leaseExpiresAt) return false;
    return new Date(task.leaseExpiresAt) <= new Date();
  }

  // Recover expired leases. CLAIMED/RUNNING tasks with expired leases return to READY
  // unless they have exhausted MAX_TASK_ATTEMPTS, in which case they fail.
  recoverExpiredLeases(actor: string, now: Date = new Date()): TaskRecord[] {
    const candidates = this.deps.listTasksByStatuses(["CLAIMED", "RUNNING"]);
    const recovered: TaskRecord[] = [];
    for (const task of candidates) {
      if (!task.leaseExpiresAt || new Date(task.leaseExpiresAt) > now) continue;
      const transitionId = crypto.randomUUID();
      const toStatus = task.attempt >= MAX_TASK_ATTEMPTS ? "FAILED" : "READY";
      this.deps.insertTransition({
        id: transitionId,
        taskId: task.id,
        fromStatus: task.status,
        toStatus,
        reason: toStatus === "FAILED" ? "max attempts exceeded" : "expired lease recovered",
        actor,
        createdAt: now.toISOString(),
      });
      const updated: TaskRecord = {
        ...task,
        status: toStatus,
        leaseHolder: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now.toISOString(),
      };
      this.deps.upsertTask(updated);
      recovered.push(updated);
    }
    return recovered;
  }

  generateIdempotencyKey(projectId: string, issueNumber: number): string {
    return crypto.createHash("sha256").update(`${projectId}:${issueNumber}`).digest("hex");
  }

  beginCorrection(
    taskId: string,
    actor: string,
    instruction: string
  ): BridgeResult<TaskRecord> {
    const task = this.deps.getTask(taskId);
    if (!task) {
      return failResult(`task ${taskId} not found`, "TASK_NOT_FOUND");
    }
    if (task.status !== "REPORT_READY") {
      return failResult(`task ${taskId} is not REPORT_READY (status ${task.status})`, "NOT_REPORT_READY");
    }

    const now = new Date().toISOString();
    const nextAttempt = (task.attempt ?? 0) + 1;

    // REPORT_READY -> CHANGES_REQUESTED
    const t1 = crypto.randomUUID();
    this.deps.insertTransition({
      id: t1,
      taskId,
      fromStatus: task.status,
      toStatus: "CHANGES_REQUESTED",
      reason: "changes requested",
      actor,
      createdAt: now,
    });

    // CHANGES_REQUESTED -> RUNNING
    const t2 = crypto.randomUUID();
    this.deps.insertTransition({
      id: t2,
      taskId,
      fromStatus: "CHANGES_REQUESTED",
      toStatus: "RUNNING",
      reason: instruction,
      actor,
      createdAt: now,
    });

    const updated: TaskRecord = {
      ...task,
      status: "RUNNING",
      attempt: nextAttempt,
      updatedAt: now,
    };
    this.deps.upsertTask(updated);
    return okResult(updated);
  }
}

export function validateTaskAuthor(author: string, allowedAuthors: string[]): BridgeResult<void> {
  if (!allowedAuthors.includes(author)) {
    return failResult(
      `task author "${author}" is not authorized for this project`,
      "UNAUTHORIZED_AUTHOR"
    );
  }
  return okResult();
}

export function isPullRequest(issue: { pullRequest?: boolean }): boolean {
  return Boolean(issue.pullRequest);
}

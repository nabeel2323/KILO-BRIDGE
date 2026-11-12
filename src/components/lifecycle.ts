"use strict";

import crypto from "node:crypto";
import type {
  BridgeResult,
  TaskRecord,
  TaskStatus,
  TaskTransition,
  ProjectConfig,
} from "../types";
import { TASK_STATUSES, okResult, failResult } from "../types";

export interface TransitionRule {
  from: TaskStatus | null;
  to: TaskStatus;
}

const ALLOWED_TRANSITIONS: TransitionRule[] = [
  { from: null, to: "READY" },
  { from: "READY", to: "CLAIMED" },
  { from: "CLAIMED", to: "RUNNING" },
  { from: "RUNNING", to: "REPORT_READY" },
  { from: "RUNNING", to: "BLOCKED" },
  { from: "RUNNING", to: "FAILED" },
  { from: "REPORT_READY", to: "CHANGES_REQUESTED" },
  { from: "CHANGES_REQUESTED", to: "RUNNING" },
  { from: "REPORT_READY", to: "PUBLISH_APPROVED" },
  { from: "PUBLISH_APPROVED", to: "PUBLISHED" },
  { from: "REPORT_READY", to: "DONE" },
  { from: "BLOCKED", to: "RUNNING" },
  { from: "FAILED", to: "RUNNING" },
  { from: "PUBLISHED", to: "DONE" },
  // Lease-expiry recovery paths (worker resets stale leases before re-claim).
  { from: "CLAIMED", to: "READY" },
  { from: "RUNNING", to: "READY" },
  { from: "CLAIMED", to: "FAILED" },
  { from: "RUNNING", to: "FAILED" },
];

export const MAX_TASK_ATTEMPTS = 3;

function isAllowed(from: TaskStatus | null, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export interface LifecycleDeps {
  getTask: (id: string) => TaskRecord | null;
  upsertTask: (t: TaskRecord) => void;
  insertTransition: (t: TaskTransition) => void;
  listTasksByStatuses?: (statuses: TaskStatus[]) => TaskRecord[];
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

  // Atomically transition a task. Returns the updated task or an error result.
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

    const updated: TaskRecord = {
      ...task,
      status: to,
      updatedAt: now,
    };
    this.deps.upsertTask(updated);
    return okResult(updated);
  }

  // Claim a task with idempotency + lease. Prevents duplicate execution.
  // The attempt counter is NOT bumped here; it is bumped by beginCorrection
  // for follow-up executions (attempt 1 is the initial execution).
  claimTask(
    taskId: string,
    leaseHolder: string,
    leaseTtlMs: number
  ): BridgeResult<TaskRecord> {
    const task = this.deps.getTask(taskId);
    if (!task) {
      return failResult(`task ${taskId} not found`, "TASK_NOT_FOUND");
    }

    const leaseValid = Boolean(
      task.leaseExpiresAt && new Date(task.leaseExpiresAt) > new Date()
    );

    // Idempotency: already claimed/running by this holder with a valid lease.
    if (leaseValid && task.leaseHolder === leaseHolder) {
      return okResult(task);
    }
    // Another worker holds a valid lease: never steal it.
    if (leaseValid && task.leaseHolder && task.leaseHolder !== leaseHolder) {
      return failResult(
        `task ${taskId} is leased by ${task.leaseHolder}`,
        "LEASE_HELD"
      );
    }

    if (task.status !== "READY") {
      return failResult(
        `task ${taskId} is not READY (status ${task.status})`,
        "NOT_READY"
      );
    }

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs).toISOString();

    this.deps.insertTransition({
      id: crypto.randomUUID(),
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
      updatedAt: now.toISOString(),
    };
    this.deps.upsertTask(updated);
    return okResult(updated);
  }

  // Start a correction execution after authorized follow-up feedback.
  // REPORT_READY -> CHANGES_REQUESTED -> RUNNING, attempt bumped once.
  beginCorrection(taskId: string, actor: string, reason: string): BridgeResult<TaskRecord> {
    const task = this.deps.getTask(taskId);
    if (!task) return failResult(`task ${taskId} not found`, "TASK_NOT_FOUND");
    if (task.status !== "REPORT_READY" && task.status !== "CHANGES_REQUESTED") {
      return failResult(`task ${taskId} is not awaiting corrections (status ${task.status})`, "NOT_REPORT_READY");
    }
    if (task.status === "REPORT_READY") {
      const r = this.transition(taskId, "CHANGES_REQUESTED", { actor, reason });
      if (!r.ok) return r;
    }
    const current = this.deps.getTask(taskId)!;
    const bumped: TaskRecord = { ...current, attempt: current.attempt + 1, updatedAt: new Date().toISOString() };
    this.deps.upsertTask(bumped);
    return this.transition(taskId, "RUNNING", { actor, reason: `correction attempt ${bumped.attempt}: ${reason}` });
  }

  // Recover tasks whose lease expired while CLAIMED/RUNNING. Tasks under the
  // attempt cap return to READY for re-execution; tasks at the cap FAIL.
  recoverExpiredLeases(actor: string, now: Date = new Date()): TaskRecord[] {
    if (!this.deps.listTasksByStatuses) return [];
    const candidates = this.deps.listTasksByStatuses(["CLAIMED", "RUNNING"]);
    const recovered: TaskRecord[] = [];
    for (const task of candidates) {
      if (!task.leaseExpiresAt || new Date(task.leaseExpiresAt) > now) continue;
      const cleared: TaskRecord = { ...task, leaseHolder: undefined, leaseExpiresAt: undefined, updatedAt: now.toISOString() };
      this.deps.upsertTask(cleared);
      if (task.attempt >= MAX_TASK_ATTEMPTS) {
        const r = this.transition(task.id, "FAILED", { actor, reason: `lease expired; max attempts (${MAX_TASK_ATTEMPTS}) reached` });
        if (r.ok) recovered.push(r.data!);
      } else {
        const r = this.transition(task.id, "READY", { actor, reason: "lease expired; recovered for re-execution" });
        if (r.ok) recovered.push(r.data!);
      }
    }
    return recovered;
  }

  // Release a lease (set lease holder null). Task keeps its status.
  releaseLease(taskId: string): BridgeResult<void> {
    const task = this.deps.getTask(taskId);
    if (!task) return failResult(`task ${taskId} not found`, "TASK_NOT_FOUND");
    const now = new Date().toISOString();
    const updated: TaskRecord = { ...task, leaseHolder: undefined, leaseExpiresAt: undefined, updatedAt: now };
    this.deps.upsertTask(updated);
    return okResult();
  }

  isLeaseExpired(task: TaskRecord): boolean {
    if (!task.leaseExpiresAt) return false;
    return new Date(task.leaseExpiresAt) <= new Date();
  }

  generateIdempotencyKey(projectId: string, issueNumber: number): string {
    return crypto.createHash("sha256").update(`${projectId}:${issueNumber}`).digest("hex");
  }
}

export interface TaskValidationContext {
  project: ProjectConfig;
  task: TaskRecord;
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

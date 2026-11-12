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
];

function isAllowed(from: TaskStatus | null, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export interface LifecycleDeps {
  getTask: (id: string) => TaskRecord | null;
  upsertTask: (t: TaskRecord) => void;
  insertTransition: (t: TaskTransition) => void;
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
      return failResult(
        `task ${taskId} is not READY (status ${task.status})`,
        "NOT_READY"
      );
    }

    // Idempotency: if already claimed/running by this holder, return current
    if (task.leaseHolder === leaseHolder && task.leaseExpiresAt && new Date(task.leaseExpiresAt) > new Date()) {
      return okResult(task);
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
      attempt: (task.attempt ?? 0) + 1,
      updatedAt: now.toISOString(),
    };
    this.deps.upsertTask(updated);
    return okResult(updated);
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

  // Recover expired leases: return tasks whose lease expired but are CLAIMED/RUNNING.
  expiredLeases(now: Date = new Date()): TaskRecord[] {
    // This is a helper; the actual scan is done by the worker calling listTasksByStatus.
    return [];
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

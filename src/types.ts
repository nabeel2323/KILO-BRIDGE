"use strict";

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const BRIDGE_NAME = "kilo-bridge";
export const BRIDGE_VERSION = "1.0.0";

// Default data directory (under the Bridge install directory).
export const DEFAULT_DATA_DIR = "C:\\TAIF\\KILO-BRIDGE\\data";
export const DEFAULT_DB_PATH = "C:\\TAIF\\KILO-BRIDGE\\data\\kilo-bridge.sqlite";
export const DEFAULT_LOGS_DIR = "C:\\TAIF\\KILO-BRIDGE\\logs";
export const DEFAULT_REPORTS_DIR = "C:\\TAIF\\KILO-BRIDGE\\reports";

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours

export const KILO_READY_MARKER = "[kilo-bridge-report]";

export const LABELS = [
  "kilo:ready",
  "kilo:claimed",
  "kilo:running",
  "kilo:report-ready",
  "kilo:blocked",
  "kilo:failed",
  "kilo:changes-requested",
  "kilo:publish-approved",
  "kilo:published",
  "kilo:done",
] as const;

export type LabelName = (typeof LABELS)[number];

export const TASK_STATUSES = [
  "READY",
  "CLAIMED",
  "RUNNING",
  "REPORT_READY",
  "BLOCKED",
  "FAILED",
  "CHANGES_REQUESTED",
  "PUBLISH_APPROVED",
  "PUBLISHED",
  "DONE",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REPORT_STATUSES = ["COMPLETE", "PARTIAL", "BLOCKED", "FAILED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const PROJECT_RUNTIMES = ["node", "php", "python", "odoo", "flutter", "other"] as const;
export type ProjectRuntime = (typeof PROJECT_RUNTIMES)[number];

export const PROJECT_STATE_ACTIVE = "active";
export const PROJECT_STATE_DISABLED = "disabled";
export type ProjectState = typeof PROJECT_STATE_ACTIVE | typeof PROJECT_STATE_DISABLED;

// ---------------------------------------------------------------------------
// Zod schemas (validation)
// ---------------------------------------------------------------------------

export const RuntimeSchema = z.object({
  nodeVersion: z.string().optional(),
  packageManager: z.string().optional(),
  packageManagerVersion: z.string().optional(),
  phpVersion: z.string().optional(),
  pythonVersion: z.string().optional(),
});

export const ProjectConfigSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "project id must be lowercase alphanumeric with hyphens"),
  name: z.string().min(1),
  repository: z.string().min(1).refine((v) => v.includes("/"), "repository must be owner/name"),
  localPath: z.string().min(1),
  baseBranch: z.string().min(1),
  releaseBranch: z.string().optional(),
  worktreeRoot: z.string().min(1),
  branchPrefix: z.string().min(1),
  allowedAuthors: z.array(z.string().min(1)).min(1),
  runtime: RuntimeSchema.optional(),
  projectType: z.string().optional(),
  verificationCommands: z.array(z.string()).default([]),
  conditionalVerification: z.array(z.string()).default([]),
  kiloModel: z.string().optional(),
  kiloAgent: z.string().optional(),
  taskTimeoutMs: z.number().positive().optional(),
  pollIntervalMs: z.number().positive().optional(),
  publishingEnabled: z.boolean().default(false),
  state: z.enum([PROJECT_STATE_ACTIVE, PROJECT_STATE_DISABLED]).default(PROJECT_STATE_ACTIVE),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const ProjectRegistrationInputSchema = z.object({
  id: ProjectConfigSchema.shape.id,
  name: ProjectConfigSchema.shape.name,
  repository: ProjectConfigSchema.shape.repository,
  localPath: ProjectConfigSchema.shape.localPath,
  baseBranch: ProjectConfigSchema.shape.baseBranch,
  releaseBranch: ProjectConfigSchema.shape.releaseBranch.optional(),
  worktreeRoot: ProjectConfigSchema.shape.worktreeRoot,
  branchPrefix: ProjectConfigSchema.shape.branchPrefix,
  allowedAuthors: ProjectConfigSchema.shape.allowedAuthors,
  runtime: ProjectConfigSchema.shape.runtime,
  projectType: ProjectConfigSchema.shape.projectType,
  verificationCommands: ProjectConfigSchema.shape.verificationCommands,
  conditionalVerification: ProjectConfigSchema.shape.conditionalVerification,
  kiloModel: ProjectConfigSchema.shape.kiloModel,
  kiloAgent: ProjectConfigSchema.shape.kiloAgent,
  taskTimeoutMs: ProjectConfigSchema.shape.taskTimeoutMs,
  pollIntervalMs: ProjectConfigSchema.shape.pollIntervalMs,
  publishingEnabled: ProjectConfigSchema.shape.publishingEnabled,
});

export type ProjectRegistrationInput = z.infer<typeof ProjectRegistrationInputSchema>;

// ---------------------------------------------------------------------------
// Task / execution
// ---------------------------------------------------------------------------

export const TaskRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  issueNumber: z.number(),
  issueUrl: z.string().url(),
  title: z.string(),
  author: z.string(),
  body: z.string(),
  status: z.enum(TASK_STATUSES),
  baseSha: z.string().optional(),
  featureBranch: z.string().optional(),
  worktreePath: z.string().optional(),
  executionId: z.string().optional(),
  attempt: z.number().default(1),
  idempotencyKey: z.string(),
  leaseHolder: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  lastCommentId: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const TaskTransitionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  fromStatus: z.enum(TASK_STATUSES).optional(),
  toStatus: z.enum(TASK_STATUSES),
  reason: z.string().optional(),
  actor: z.string().optional(),
  createdAt: z.string(),
});

export type TaskTransition = z.infer<typeof TaskTransitionSchema>;

export const ExecutionRecordSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  attempt: z.number(),
  status: z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"]),
  startTime: z.string(),
  endTime: z.string().optional(),
  exitCode: z.number().optional(),
  durationMs: z.number().optional(),
  kiloVersion: z.string().optional(),
  kiloSessionId: z.string().optional(),
  kiloModel: z.string().optional(),
  kiloAgent: z.string().optional(),
  eventLogPath: z.string().optional(),
  errorMessage: z.string().optional(),
});

export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

export const VerificationRecordSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  startTime: z.string(),
  endTime: z.string().optional(),
  exitCode: z.number().optional(),
  durationMs: z.number().optional(),
  stdoutPath: z.string().optional(),
  stderrPath: z.string().optional(),
  passed: z.boolean().optional(),
});

export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

export const ReportRecordSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  executionId: z.string(),
  status: z.enum(REPORT_STATUSES),
  reportPath: z.string(),
  issueCommentId: z.number().optional(),
  postedAt: z.string().optional(),
  createdAt: z.string(),
});

export type ReportRecord = z.infer<typeof ReportRecordSchema>;

// ---------------------------------------------------------------------------
// Security / policy
// ---------------------------------------------------------------------------

export const SecurityPolicySchema = z.object({
  projectId: z.string(),
  denyShellUnapproved: z.boolean().default(true),
  allowWorktreeOnly: z.boolean().default(true),
  denySensitivePaths: z.boolean().default(true),
  denyExternalPaths: z.boolean().default(true),
  protectBridgeConfig: z.boolean().default(true),
  denyGitPush: z.boolean().default(true),
  denyGitCommit: z.boolean().default(true),
  denyGitMerge: z.boolean().default(true),
  denyDeploy: z.boolean().default(true),
  denyDbMigrate: z.boolean().default(true),
  denyDbReset: z.boolean().default(true),
  denyDbProdAccess: z.boolean().default(true),
  createdAt: z.string(),
});

export type SecurityPolicy = z.infer<typeof SecurityPolicySchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface BridgeResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export function okResult<T>(data?: T): BridgeResult<T> {
  return { ok: true, data };
}

export function failResult(error: string, code?: string): BridgeResult<never> {
  return { ok: false, error, code };
}

// ---------------------------------------------------------------------------
// Kilo event
// ---------------------------------------------------------------------------

export interface KiloEvent {
  type: string;
  timestamp?: string;
  data?: unknown;
  [key: string]: unknown;
}

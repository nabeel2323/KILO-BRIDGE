"use strict";

import { z } from "zod";

export const BRIDGE_NAME = "kilo-bridge";
export const BRIDGE_VERSION = "1.0.0";

export const DEFAULT_DATA_DIR = "C:\TAIF\KILO-BRIDGE\data";
export const DEFAULT_DB_PATH = "C:\TAIF\KILO-BRIDGE\data\kilo-bridge.sqlite";
export const DEFAULT_LOGS_DIR = "C:\TAIF\KILO-BRIDGE\logs";
export const DEFAULT_REPORTS_DIR = "C:\TAIF\KILO-BRIDGE\reports";

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000;

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

export const MAX_TASK_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Zod schemas
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
  releaseBranch: z.string().min(1),
  worktreeRoot: z.string().min(1),
  branchPrefix: z.string().min(1),
  allowedAuthors: z.array(z.string().min(1)).min(1),
  runtime: RuntimeSchema.optional(),
  projectType: z.string().optional(),
  verificationCommands: z.array(z.string()).default([]),
  advisoryCommands: z.array(z.string()).default([]),
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
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "project id must be lowercase alphanumeric with hyphens"),
  name: z.string().min(1),
  repository: z.string().min(1).refine((v) => v.includes("/"), "repository must be owner/name"),
  localPath: z.string().min(1),
  baseBranch: z.string().min(1),
  releaseBranch: z.string().min(1).optional(),
  worktreeRoot: z.string().min(1),
  branchPrefix: z.string().min(1),
  allowedAuthors: z.array(z.string().min(1)).min(1),
  runtime: RuntimeSchema.optional(),
  projectType: z.string().optional(),
  verificationCommands: z.array(z.string()).default([]),
  advisoryCommands: z.array(z.string()).default([]),
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
  kiloConfigPath: z.string().optional(),
  kiloConfigHash: z.string().optional(),
});

export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

export const VerificationRecordSchema = z.object({
    id: z.string(),
    executionId: z.string(),
    name: z.string().optional(),
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

// ---------------------------------------------------------------------------
// Report data
// ---------------------------------------------------------------------------

export interface ReportData {
  taskId: string;
  issueNumber: number;
  issueUrl: string;
  projectId: string;
  executionId: string;
  attempt: number;
  startTime: string;
  endTime: string;
  kiloVersion?: string;
  model?: string;
  agent?: string;
  sessionId?: string;
  baseSha?: string;
  featureBranch?: string;
  implementationSummary: string;
  changedFiles: string[];
  diffStats: string;
  verifications: Omit<VerificationRecord, "id">[];
  testFailures: string[];
  documentationChanges: string[];
  securityObservations: string[];
  unmetAcceptanceCriteria: string[];
  outstandingIssues: string[];
  status: ReportStatus;
}

export interface VerificationCommand {
  name: string;
  command: string;
  args: string[];
  required: boolean;
  advisory?: boolean;
  conditional: boolean;
  conditionFiles?: string[];
  cwd: string;
}

export interface WorkerModeConfig {
  dataDir: string;
  dbPath: string;
  logsDir: string;
  reportsDir: string;
  worktreeRoot: string;
  pollIntervalMs: number;
  defaultTaskTimeoutMs: number;
  ghEnabled: boolean;
  kiloEnabled: boolean;
  workerEnabled: boolean;
}

export interface WorkerState {
  running: boolean;
  pid: number | null;
  workerId: string | null;
  heartbeat: string | null;
  activeProject: string | null;
  activeTask: string | null;
  lastPoll: string | null;
}

export interface DoctorCheck {
  name: string;
  status: "PASS" | "FAIL" | "WARNING";
  condition: string;
  explanation: string;
  remediation: string;
}

export type WorkerMode = "mock" | "real" | "dry-run";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ERR_WORKER_DISABLED_BY_POLICY = "WORKER_DISABLED_BY_POLICY";
export const ERR_UNSUPPORTED_SECURITY_PROFILE = "UNSUPPORTED_SECURITY_PROFILE";
export const ERR_SECURITY_PROFILE_REQUIRED = "SECURITY_PROFILE_REQUIRED";
export const ERR_KILO_CONFIG_CHECK_FAILED = "KILO_CONFIG_CHECK_FAILED";
export const ERR_PERMISSION_WRITE_FAILED = "PERMISSION_WRITE_FAILED";
export const ERR_PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND";
export const ERR_TASK_NOT_FOUND = "TASK_NOT_FOUND";
export const ERR_NOT_INITIALIZED = "NOT_INITIALIZED";
export const ERR_NOT_IMPLEMENTED = "NOT_IMPLEMENTED";
export const ERR_VALIDATION_FAILED = "VALIDATION_FAILED";
export const ERR_DUPLICATE_PROJECT = "DUPLICATE_PROJECT";
export const ERR_UNKNOWN_TEMPLATE = "UNKNOWN_TEMPLATE";
export const ERR_ILLEGAL_TRANSITION = "ILLEGAL_TRANSITION";
export const ERR_STATUS_MISMATCH = "STATUS_MISMATCH";
export const ERR_LEASE_HELD = "LEASE_HELD";
export const ERR_NOT_READY = "NOT_READY";
export const ERR_NOT_CLAIMED = "NOT_CLAIMED";
export const ERR_UNAUTHORIZED_AUTHOR = "UNAUTHORIZED_AUTHOR";
export const ERR_WORKER_ALREADY_RUNNING = "WORKER_ALREADY_RUNNING";
export const ERR_LOCK_FAILED = "LOCK_FAILED";
export const ERR_REPORT_EXISTS = "REPORT_EXISTS";
export const ERR_REPORT_WRITE_FAILED = "REPORT_WRITE_FAILED";
export const ERR_CONFIG_PARSE_FAILED = "PERMISSION_CONFIG_PARSE_FAILED";
export const ERR_CONFIG_MISSING = "PERMISSION_CONFIG_MISSING";
export const ERR_PERMISSION_DENIALS_MISSING = "PERMISSION_DENIALS_MISSING";

// ---------------------------------------------------------------------------
// Execution isolation
// ---------------------------------------------------------------------------

export type ExecutionIsolationLevel = "WORKTREE_ONLY" | "WINDOWS_SANDBOX" | "OS_SANDBOX" | "NONE";

export const DEFAULT_EXECUTION_ISOLATION_LEVEL: ExecutionIsolationLevel = "WORKTREE_ONLY";

// ---------------------------------------------------------------------------
// Native tool verification capability states
// ---------------------------------------------------------------------------

export type NativeToolConfigVerificationState = "PASS" | "PARTIAL" | "NOT TESTED" | "BLOCKED" | "NOT IMPLEMENTED";
export type NativeToolPermissionSupportState = "PASS" | "PARTIAL" | "NOT TESTED" | "BLOCKED" | "NOT IMPLEMENTED";
export type NativeToolRuntimeVerificationState = "PASS" | "PARTIAL" | "NOT TESTED" | "BLOCKED" | "NOT IMPLEMENTED";

// Required native Kilo tool permissions for verification.
export const REQUIRED_NATIVE_TOOL_PERMISSIONS: string[] = [
  "read", "glob", "grep", "edit", "write", "apply_patch", "bash", "external_directory",
];

// Permissions supported by Kilo v7.8.27 kilo agent create --permissions.
// Source: kilo agent create --help Available list.
export const SUPPORTED_NATIVE_TOOL_PERMISSIONS: string[] = [
  "bash", "read", "edit", "glob", "grep", "webfetch", "task", "todowrite", "websearch", "lsp", "skill",
];

// Permissions required but NOT supported by Kilo v7.8.27 agent permissions.
export const UNSUPPORTED_NATIVE_TOOL_PERMISSIONS: string[] = [
  "write", "apply_patch", "external_directory",
];

// ---------------------------------------------------------------------------
// Permission capability registry
// ---------------------------------------------------------------------------

export type PermissionCapabilityLevel =
  | "CLI_SHORTHAND"
  | "CONFIG_SCHEMA"
  | "TOOL_REGISTRATION"
  | "TOOL_ADVERTISEMENT"
  | "PERMISSION_EVALUATION"
  | "ACTUAL_EXECUTION"
  | "BRIDGE_RESTRICTION"
  | "OS_ISOLATION";

export interface PermissionCapability {
  tool: string;
  cliShorthand: PermissionCapabilityLevel;
  configSchema: PermissionCapabilityLevel;
  toolRegistration: PermissionCapabilityLevel;
  toolAdvertisement: PermissionCapabilityLevel;
  permissionEvaluation: PermissionCapabilityLevel;
  actualExecution: PermissionCapabilityLevel;
  bridgeRestriction: PermissionCapabilityLevel;
  osIsolation: PermissionCapabilityLevel;
}

export const PERMISSION_CAPABILITY_REGISTRY: PermissionCapability[] = [
  {
    tool: "read",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
  {
    tool: "glob",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
  {
    tool: "grep",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
  {
    tool: "edit",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
  {
    tool: "write",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
  {
    tool: "apply_patch",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
  {
    tool: "bash",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
  {
    tool: "external_directory",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
  {
    tool: "lsp",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
  {
    tool: "todoread",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
  {
    tool: "todowrite",
    cliShorthand: "CLI_SHORTHAND",
    configSchema: "CONFIG_SCHEMA",
    toolRegistration: "TOOL_REGISTRATION",
    toolAdvertisement: "TOOL_ADVERTISEMENT",
    permissionEvaluation: "PERMISSION_EVALUATION",
    actualExecution: "ACTUAL_EXECUTION",
    bridgeRestriction: "BRIDGE_RESTRICTION",
    osIsolation: "OS_ISOLATION",
  },
];

export function getPermissionCapability(tool: string): PermissionCapability | undefined {
  return PERMISSION_CAPABILITY_REGISTRY.find((c) => c.tool === tool);
}

export function isToolRegistered(tool: string): boolean {
  const cap = getPermissionCapability(tool);
  return cap !== undefined && cap.toolRegistration === "TOOL_REGISTRATION";
}

export function isToolExecutable(tool: string): boolean {
  const cap = getPermissionCapability(tool);
  return cap !== undefined && cap.actualExecution === "ACTUAL_EXECUTION";
}

export function isBridgeRestricted(tool: string): boolean {
  const cap = getPermissionCapability(tool);
  return cap !== undefined && cap.bridgeRestriction === "BRIDGE_RESTRICTION";
}

// ---------------------------------------------------------------------------
// Security profiles
// ---------------------------------------------------------------------------

export type SecurityProfileName = "smoke" | "normal-coding" | "integration-test";

export const SUPPORTED_PROFILES: SecurityProfileName[] = ["smoke", "normal-coding", "integration-test"];

export const INTEGRATION_TEST_PROFILE_RESTRICTION = "integration-test";

// ---------------------------------------------------------------------------
// Isolation granularity states
// ---------------------------------------------------------------------------

export type IsolationGranularityState = "PASS" | "PARTIAL" | "NOT TESTED" | "BLOCKED" | "NOT IMPLEMENTED";

export interface IsolationState {
  filesystem: IsolationGranularityState;
  process: IsolationGranularityState;
  network: IsolationGranularityState;
}

// ---------------------------------------------------------------------------
// Production execution readiness
// ---------------------------------------------------------------------------

export type ProductionExecutionReadiness = "READY" | "BLOCKED" | "NOT TESTED";

// ---------------------------------------------------------------------------
// Injectable service dependency interfaces
// ---------------------------------------------------------------------------

export interface GitHubClient {
  authStatus(): Promise<{ authenticated: boolean; user?: string; error?: string }>;
  ensureLabels(labels: string[]): Promise<BridgeResult<void>>;
  listOpenIssues(opts?: { labels?: string[]; limit?: number }): Promise<BridgeResult<Array<{ number: number; title: string; author: string; body: string; htmlUrl: string; pullRequest?: boolean; labels?: string[] }>>>;
  getIssue(issueNumber: number): Promise<BridgeResult<{ number: number; title: string; author: string; body: string; htmlUrl: string; state: string; labels?: string[]; pullRequest?: boolean }>>;
  listComments(issueNumber: number): Promise<BridgeResult<Array<{ id: number; author: string; body: string; isBridge: boolean }>>>;
  addLabels(issueNumber: number, labels: string[]): Promise<BridgeResult<void>>;
  removeLabel(issueNumber: number, label: string): Promise<BridgeResult<void>>;
  addComment(issueNumber: number, body: string): Promise<BridgeResult<number>>;
}

export interface TaskSource {
  listOpenIssues(projectId: string): Promise<BridgeResult<Array<{ issueNumber: number; title: string; author: string; body: string; issueUrl: string; pullRequest?: boolean }>>>;
  getIssue(projectId: string, issueNumber: number): Promise<BridgeResult<{ issueNumber: number; title: string; author: string; body: string; issueUrl: string; pullRequest?: boolean } | null>>;
}

export interface ReportSink {
  publish(reportPath: string, taskId: string, issueNumber: number, body: string): Promise<BridgeResult<{ commentId?: number; postedAt?: string }>>;
}

export interface KiloExecutor {
  run(taskSpec: string, opts: { worktreePath: string; kiloConfigPath: string; model?: string; agent?: string; timeoutMs?: number }): Promise<{ exitCode: number; durationMs: number; sessionId?: string; kiloVersion?: string; model?: string; agent?: string; eventLogPath?: string; error?: string; finalResponse?: string }>;
}

export interface WorktreeManager {
  prepareTaskWorktree(issueNumber: number, attempt: number): Promise<BridgeResult<{ branch: string; dir: string; baseSha: string }>>;
  worktreePathFor(branch: string): string;
  generateBranchName(issueNumber: number, attempt: number): string;
  cleanupWorktreeAndBranch(branch: string, dir: string): Promise<void>;
  collectChangedFiles(worktreePath: string): Promise<string[]>;
}

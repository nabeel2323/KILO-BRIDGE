"use strict";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SqliteStore } from "../db";
import type { Logger } from "./logging";
import type { ProjectRegistry } from "./registry";
import type { BridgeConfig } from "../config";
import { GitHubProvider } from "./github";
import { LifecycleManager, validateTaskAuthor } from "./lifecycle";
import { WorktreeManager } from "./worktree";
import { SecurityManager } from "./security";
import { KiloCliAdapter } from "./kilo";
import { VerificationEngine } from "./verification";
import { ReportGenerator, type ReportData } from "./report";
import { PublishingManager } from "./publishing";
import type {
  ProjectConfig,
  TaskRecord,
  ExecutionRecord,
  ReportStatus,
  TaskStatus,
  LabelName,
  BridgeResult,
} from "../types";
import { okResult, failResult, LABELS } from "../types";

export type WorkerMode = "real" | "mock" | "dry-run";

export interface WorkerOptions {
  store: SqliteStore;
  registry: ProjectRegistry;
  logger: Logger;
  bridgeRoot: string;
  config: BridgeConfig;
  mode: WorkerMode;
  githubFactory?: (project: ProjectConfig) => GitHubProvider;
  kiloBin?: string;
  workerId?: string;
}

export interface ProjectPollResult {
  project: string;
  discovered: number;
  executed: number;
  corrections: number;
  published: number;
  rejected: Array<{ issue: number; reason: string }>;
  errors: string[];
  skipped?: string;
}

const LEASE_TTL_MS = 10 * 60 * 1000;
const STATUS_LABEL: Partial<Record<TaskStatus, LabelName>> = {
  CLAIMED: "kilo:claimed",
  RUNNING: "kilo:running",
  REPORT_READY: "kilo:report-ready",
  BLOCKED: "kilo:blocked",
  FAILED: "kilo:failed",
  CHANGES_REQUESTED: "kilo:changes-requested",
  PUBLISH_APPROVED: "kilo:publish-approved",
  PUBLISHED: "kilo:published",
  DONE: "kilo:done",
};

export class Worker {
  private readonly store: SqliteStore;
  private readonly registry: ProjectRegistry;
  private readonly logger: Logger;
  private readonly bridgeRoot: string;
  private readonly config: BridgeConfig;
  private readonly mode: WorkerMode;
  private readonly githubFactory: (project: ProjectConfig) => GitHubProvider;
  private readonly kiloBin?: string;
  readonly workerId: string;
  private stopping = false;

  constructor(opts: WorkerOptions) {
    this.store = opts.store;
    this.registry = opts.registry;
    this.logger = opts.logger;
    this.bridgeRoot = opts.bridgeRoot;
    this.config = opts.config;
    this.mode = opts.mode;
    this.githubFactory = opts.githubFactory ?? ((p) => {
      const [owner, repo] = p.repository.split("/");
      return new GitHubProvider({ owner, repo });
    });
    this.kiloBin = opts.kiloBin;
    this.workerId = opts.workerId ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
  }

  private lifecycle(): LifecycleManager {
    return new LifecycleManager({
      getTask: (id) => this.store.getTask(id),
      upsertTask: (t) => this.store.upsertTask(t),
      insertTransition: (t) => this.store.insertTransition(t),
      listTasksByStatuses: (s) => this.store.listTasksByStatuses(s),
    });
  }

  requestStop(): void {
    this.stopping = true;
  }

  // ------------------------------------------------------------------
  // Polling
  // ------------------------------------------------------------------

  async pollOnce(projectId?: string): Promise<BridgeResult<ProjectPollResult[]>> {
    const projects = projectId
      ? [this.registry.get(projectId)].filter(Boolean)
      : this.registry.list().filter((p) => p.state === "active");
    if (projectId && projects.length === 0) {
      return failResult(`project ${projectId} not found`, "PROJECT_NOT_FOUND");
    }
    const results: ProjectPollResult[] = [];
    for (const entry of projects as Array<{ config: ProjectConfig; state: string }>) {
      if (this.stopping) break;
      results.push(await this.processProject(entry.config));
    }
    return okResult(results);
  }

  async processProject(config: ProjectConfig): Promise<ProjectPollResult> {
    const result: ProjectPollResult = {
      project: config.id, discovered: 0, executed: 0, corrections: 0, published: 0, rejected: [], errors: [],
    };
    const gh = this.githubFactory(config);

    const auth = await gh.authStatus();
    if (!auth.authenticated) {
      result.skipped = `GitHub not authenticated: ${auth.error}`;
      return result;
    }

    const labels = await gh.ensureLabels(LABELS);
    if (!labels.ok) {
      result.errors.push(`label bootstrap failed: ${labels.error}`);
      return result;
    }

    // Recover stale leases from crashed workers before claiming new work.
    const recovered = this.lifecycle().recoverExpiredLeases(this.workerId);
    for (const t of recovered) {
      this.logger.warn("recovered expired lease", { taskId: t.id, status: t.status });
      this.store.insertAudit({ projectId: config.id, actor: this.workerId, action: "lease.recovered", detail: t.id });
    }

    // 1. Discover new ready tasks.
    const ready = await gh.listOpenIssues({ labels: ["kilo:ready"], limit: 50 });
    if (!ready.ok) {
      result.errors.push(`issue polling failed: ${ready.error}`);
      if (ready.code === "RATE_LIMITED") result.skipped = "rate limited; will retry next poll";
      return result;
    }
    for (const issue of ready.data!) {
      if (this.stopping) break;
      if (issue.pullRequest) continue; // PRs are never tasks
      const authorCheck = validateTaskAuthor(issue.author, config.allowedAuthors);
      if (!authorCheck.ok) {
        result.rejected.push({ issue: issue.number, reason: authorCheck.error! });
        this.store.insertAudit({ projectId: config.id, actor: this.workerId, action: "task.rejected", detail: `issue #${issue.number}: ${authorCheck.error}` });
        continue;
      }
      if (!issue.body.trim()) {
        result.rejected.push({ issue: issue.number, reason: "empty task body" });
        continue;
      }
      const idempotencyKey = this.lifecycle().generateIdempotencyKey(config.id, issue.number);
      const existing = this.store.getTaskByIdempotencyKey(idempotencyKey);
      if (existing) continue; // duplicate prevention

      const now = new Date().toISOString();
      const task: TaskRecord = {
        id: crypto.randomUUID(),
        projectId: config.id,
        issueNumber: issue.number,
        issueUrl: issue.htmlUrl,
        title: issue.title,
        author: issue.author,
        body: issue.body,
        status: "READY",
        idempotencyKey,
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.store.upsertTask(task);
      this.store.insertTransition({ id: crypto.randomUUID(), taskId: task.id, toStatus: "READY", reason: "discovered via GitHub", actor: this.workerId, createdAt: now });
      result.discovered++;
      this.store.insertAudit({ projectId: config.id, actor: this.workerId, action: "task.discovered", detail: `issue #${issue.number}` });

      if (this.mode === "dry-run") continue;

      const claimed = this.lifecycle().claimTask(task.id, this.workerId, LEASE_TTL_MS);
      if (!claimed.ok) {
        result.errors.push(`claim failed for #${issue.number}: ${claimed.error}`);
        continue;
      }
      await this.syncLabel(gh, task, "CLAIMED", ["kilo:ready"]);
      await this.executeTask(claimed.data!, config, gh);
      result.executed++;
    }

    if (this.mode === "dry-run") return result;

    // 1b. Claim and execute any READY tasks already in the store (lease
    // recoveries, tasks discovered by an earlier dry-run poll).
    const pending = this.store.listTasksByProject(config.id, "READY");
    for (const task of pending) {
      if (this.stopping) break;
      const claimed = this.lifecycle().claimTask(task.id, this.workerId, LEASE_TTL_MS);
      if (!claimed.ok) continue;
      await this.syncLabel(gh, task, "CLAIMED", ["kilo:ready"]);
      await this.executeTask(claimed.data!, config, gh);
      result.executed++;
    }

    // 2. Follow-up / correction workflow (spec §11).
    result.corrections = await this.processCorrections(config, gh);

    // 3. Controlled publishing (spec §12).
    result.published = await this.processPublishing(config, gh);

    return result;
  }

  // ------------------------------------------------------------------
  // Task execution pipeline
  // ------------------------------------------------------------------

  async executeTask(task: TaskRecord, config: ProjectConfig, gh: GitHubProvider, correctionInstruction?: string): Promise<void> {
    const lifecycle = this.lifecycle();
    const security = new SecurityManager(config.id, config.worktreeRoot, this.bridgeRoot);
    const worktree = new WorktreeManager({
      projectId: config.id,
      localRepoPath: config.localPath,
      worktreeRoot: config.worktreeRoot,
      baseBranch: config.baseBranch,
      branchPrefix: config.branchPrefix,
      releaseBranch: config.releaseBranch,
    });

    const executionId = crypto.randomUUID();
    const startTime = new Date().toISOString();
    const execution: ExecutionRecord = {
      id: executionId, taskId: task.id, attempt: task.attempt, status: "RUNNING", startTime,
    };
    this.store.upsertExecution(execution);

    const finish = (status: ExecutionRecord["status"], extra: Partial<ExecutionRecord> = {}) => {
      this.store.upsertExecution({
        ...execution, status, endTime: new Date().toISOString(), ...extra,
      });
    };

    try {
      // RUNNING transition (from CLAIMED on first attempt, CHANGES_REQUESTED on corrections).
      const current = this.store.getTask(task.id)!;
      if (current.status === "CLAIMED") {
        const r = lifecycle.transition(task.id, "RUNNING", { actor: this.workerId, reason: "execution started" });
        if (!r.ok) throw new Error(r.error);
      }
      await this.syncLabel(gh, task, "RUNNING", ["kilo:claimed", "kilo:changes-requested"]);

      // Origin must match the registered repository before any execution.
      const origin = await worktree.verifyOriginMatches(config.repository);
      if (!origin.ok) throw Object.assign(new Error(origin.error!), { bridgeCode: "ORIGIN_MISMATCH", blocked: true });

      // Isolated worktree at the recorded base SHA.
      const prepared = await worktree.prepareTaskWorktree(task.issueNumber, task.attempt);
      if (!prepared.ok) throw Object.assign(new Error(prepared.error!), { bridgeCode: prepared.code, blocked: true });
      const { branch, dir, baseSha } = prepared.data!;
      this.store.upsertTask({ ...this.store.getTask(task.id)!, featureBranch: branch, worktreePath: dir, baseSha, executionId });

      // Security: project-level Kilo permissions + Bridge command policy.
      const policy = security.generatePolicy(config);
      const policyCheck = security.validatePolicy(policy);
      if (!policyCheck.ok) throw Object.assign(new Error(policyCheck.error!), { blocked: true });
      this.store.upsertSecurityPolicy(policy);
      const permFile = security.writeKiloPermissionFile(dir, policy);
      if (!permFile.ok) throw Object.assign(new Error(permFile.error!), { blocked: true });
      security.writeBridgeCommandPolicy(dir);
      const permVerify = await security.verifyEffectivePermissions(dir, {
        kiloBin: this.kiloBin,
        skipKiloCheck: this.mode === "mock",
      });
      if (!permVerify.ok) throw Object.assign(new Error(permVerify.error!), { blocked: true });

      // Kilo execution. --auto is only used after explicit denials verified.
      const spec = correctionInstruction
        ? `${task.body}\n\n---\nAuthorized follow-up instruction (attempt ${task.attempt}):\n${correctionInstruction}`
        : task.body;
      const adapter = new KiloCliAdapter({
        kiloBin: this.kiloBin,
        worktreePath: dir,
        taskTitle: `GitHub Issue #${task.issueNumber}`,
        taskSpec: spec,
        model: config.kiloModel,
        agent: config.kiloAgent,
        timeoutMs: config.taskTimeoutMs ?? this.config.defaultTaskTimeoutMs,
        auto: true,
      });
      if (this.mode === "real") {
        const preflight = await adapter.preflight();
        if (!preflight.ok) throw Object.assign(new Error(preflight.error!), { blocked: true });
      }
      const run = await adapter.run();
      finish(run.timedOut ? "TIMEOUT" : run.exitCode === 0 ? "COMPLETED" : "FAILED", {
        exitCode: run.exitCode ?? undefined,
        durationMs: run.durationMs,
        kiloVersion: run.kiloVersion,
        kiloSessionId: run.sessionId,
        kiloModel: run.model,
        kiloAgent: run.agent,
        eventLogPath: run.eventLogPath,
        errorMessage: run.error,
      });

      // Collect the resulting diff (worktree preserved, never the main tree).
      const diff = await worktree.collectDiff(dir);
      const changedFiles = diff.ok ? diff.data!.changedFiles : await worktree.collectChangedFiles(dir);

      // Independent verification — never trust agent-reported results.
      const engine = new VerificationEngine({
        worktreePath: dir,
        resultsDir: path.join(this.bridgeRoot, "reports", "verification", task.id),
      });
      const commands = VerificationEngine.commandsFromProject(config, dir);
      const verifyResults = await engine.runSuite(commands, changedFiles);
      const verificationRecords = verifyResults.map((r) => {
        const rec = engine.toRecord(executionId, r);
        this.store.insertVerification(rec);
        return { ...rec, id: r.id };
      });
      const requiredNames = commands.filter((c) => c.required).map((c) => c.name);
      const reportGen = new ReportGenerator(path.join(this.bridgeRoot, "reports"));
      const allRequiredPassed = engine.allRequiredPassed(verifyResults, commands);

      // Determine the final report status (spec §10).
      let status: ReportStatus;
      if (run.timedOut || run.exitCode !== 0) {
        status = "FAILED";
      } else if (!allRequiredPassed) {
        status = "PARTIAL";
      } else if (changedFiles.length === 0) {
        status = "PARTIAL"; // no changes produced — cannot claim completion
      } else {
        status = "COMPLETE";
      }

      const reportData: ReportData = {
        taskId: task.id,
        issueNumber: task.issueNumber,
        issueUrl: task.issueUrl,
        projectId: config.id,
        executionId,
        attempt: task.attempt,
        startTime,
        endTime: new Date().toISOString(),
        kiloVersion: run.kiloVersion,
        model: run.model,
        agent: run.agent,
        sessionId: run.sessionId,
        baseSha,
        featureBranch: branch,
        implementationSummary: run.finalResponse ?? "(no final response captured)",
        changedFiles,
        diffStats: diff.ok ? diff.data!.stats : "",
        verifications: verificationRecords,
        testFailures: verifyResults.filter((r) => r.passed === false).map((r) => `${r.name} (exit ${r.exitCode})`),
        documentationChanges: changedFiles.filter((f) => /\.md$/i.test(f) || f.startsWith("docs/")),
        securityObservations: [
          `Worktree permission config verified (${permVerify.ok ? "bridge assertions passed" : "FAILED"}).`,
          `Kilo executed with explicit deny-by-default permissions; git push/commit/merge denied to the agent.`,
        ],
        unmetAcceptanceCriteria: allRequiredPassed ? [] : ["Required verification commands did not all pass — see verification results."],
        outstandingIssues: run.error ? [run.error] : [],
        status,
      };
      const reportFile = reportGen.generate(reportData);
      if (!reportFile.ok) throw new Error(reportFile.error);
      const comment = reportGen.buildComment(reportData, reportFile.data!);
      const posted = await gh.addComment(task.issueNumber, comment);
      this.store.upsertReport({
        id: crypto.randomUUID(),
        taskId: task.id,
        executionId,
        status,
        reportPath: reportFile.data!,
        issueCommentId: posted.ok ? posted.data : undefined,
        postedAt: posted.ok ? new Date().toISOString() : undefined,
        createdAt: new Date().toISOString(),
      });
      if (posted.ok && posted.data! > 0) {
        this.store.setLastCommentId(task.id, posted.data!);
      }

      const finalStatus: TaskStatus = status === "FAILED" ? "FAILED" : "REPORT_READY";
      lifecycle.transition(task.id, finalStatus, { actor: this.workerId, reason: `report ${status}` });
      await this.syncLabel(gh, task, finalStatus, ["kilo:running"]);
      this.store.insertAudit({ projectId: config.id, actor: this.workerId, action: "task.executed", detail: `issue #${task.issueNumber} attempt ${task.attempt}: ${status}` });
      this.logger.info("task execution finished", { taskId: task.id, issue: task.issueNumber, status });
      this.logger.notify("Kilo Bridge", `Issue #${task.issueNumber}: ${status}`);
    } catch (err: any) {
      const blocked = Boolean(err?.blocked);
      const message = err?.message ?? String(err);
      finish("FAILED", { errorMessage: message });
      const target: TaskStatus = blocked ? "BLOCKED" : "FAILED";
      const current = this.store.getTask(task.id);
      if (current && (current.status === "RUNNING" || current.status === "CLAIMED")) {
        lifecycle.transition(task.id, target, { actor: this.workerId, reason: message });
        await this.syncLabel(gh, task, target, ["kilo:running", "kilo:claimed"]);
      }
      // A failure report is still published so the issue has evidence.
      try {
        await this.postFailureReport(task, config, gh, executionId, message, blocked ? "BLOCKED" : "FAILED");
      } catch (reportErr) {
        this.logger.error("failed to post failure report", { error: String(reportErr) });
      }
      this.store.insertAudit({ projectId: config.id, actor: this.workerId, action: "task.failed", detail: `issue #${task.issueNumber}: ${message}` });
      this.logger.error("task execution failed", { taskId: task.id, error: message });
    } finally {
      this.lifecycle().releaseLease(task.id);
    }
  }

  private async postFailureReport(task: TaskRecord, config: ProjectConfig, gh: GitHubProvider, executionId: string, message: string, status: ReportStatus): Promise<void> {
    const reportGen = new ReportGenerator(path.join(this.bridgeRoot, "reports"));
    const data: ReportData = {
      taskId: task.id, issueNumber: task.issueNumber, issueUrl: task.issueUrl, projectId: config.id,
      executionId, attempt: task.attempt,
      startTime: new Date().toISOString(), endTime: new Date().toISOString(),
      baseSha: task.baseSha, featureBranch: task.featureBranch,
      implementationSummary: `Execution did not complete: ${message}`,
      changedFiles: [], diffStats: "", verifications: [], testFailures: [],
      documentationChanges: [], securityObservations: [], unmetAcceptanceCriteria: [],
      outstandingIssues: [message], status,
    };
    const file = reportGen.generate(data);
    if (!file.ok) return;
    const comment = reportGen.buildComment(data, file.data!);
    const posted = await gh.addComment(task.issueNumber, comment);
    this.store.upsertReport({
      id: crypto.randomUUID(), taskId: task.id, executionId, status,
      reportPath: file.data!, issueCommentId: posted.ok ? posted.data : undefined,
      postedAt: posted.ok ? new Date().toISOString() : undefined, createdAt: new Date().toISOString(),
    });
  }

  // ------------------------------------------------------------------
  // Follow-up / corrections (spec §11)
  // ------------------------------------------------------------------

  private async processCorrections(config: ProjectConfig, gh: GitHubProvider): Promise<number> {
    let count = 0;
    const candidates = this.store.listTasksByProject(config.id, "REPORT_READY");
    for (const task of candidates) {
      if (this.stopping) break;
      const issue = await gh.getIssue(task.issueNumber);
      if (!issue.ok) continue;
      if (!issue.data!.labels.includes("kilo:changes-requested")) continue;

      const comments = await gh.listComments(task.issueNumber);
      if (!comments.ok) continue;
      const fresh = comments.data!.filter(
        (c) => c.id > (task.lastCommentId ?? 0) && !c.isBridge
      );
      // Record the high-water mark even when nothing is actionable.
      const maxId = comments.data!.reduce((m, c) => Math.max(m, c.id), task.lastCommentId ?? 0);
      if (maxId > (task.lastCommentId ?? 0)) this.store.setLastCommentId(task.id, maxId);

      const authorized = fresh.filter((c) => validateTaskAuthor(c.author, config.allowedAuthors).ok);
      for (const c of fresh) {
        if (!validateTaskAuthor(c.author, config.allowedAuthors).ok) {
          this.store.insertAudit({ projectId: config.id, actor: this.workerId, action: "comment.rejected", detail: `issue #${task.issueNumber} comment ${c.id} by ${c.author}` });
        }
      }
      if (authorized.length === 0) continue;

      const instruction = authorized.map((c) => `Comment by ${c.author} at ${c.createdAt}:\n${c.body}`).join("\n\n");
      const begun = this.lifecycle().beginCorrection(task.id, authorized[0].author, "authorized follow-up comment");
      if (!begun.ok) {
        this.logger.warn("beginCorrection failed", { taskId: task.id, error: begun.error });
        continue;
      }
      await this.executeTask(begun.data!, config, gh, instruction);
      await gh.removeLabel(task.issueNumber, "kilo:changes-requested");
      count++;
    }
    return count;
  }

  // ------------------------------------------------------------------
  // Controlled publishing (spec §12)
  // ------------------------------------------------------------------

  private async processPublishing(config: ProjectConfig, gh: GitHubProvider): Promise<number> {
    if (!config.publishingEnabled) return 0;
    let count = 0;
    const candidates = this.store.listTasksByProject(config.id, "REPORT_READY");
    const publisher = new PublishingManager({
      store: this.store, logger: this.logger, bridgeRoot: this.bridgeRoot,
    });
    for (const task of candidates) {
      if (this.stopping) break;
      const issue = await gh.getIssue(task.issueNumber);
      if (!issue.ok) continue;
      if (!issue.data!.labels.includes("kilo:publish-approved")) continue;
      const r = await publisher.publish(task, config, gh);
      if (r.ok) {
        count++;
      } else {
        this.logger.warn("publishing refused", { taskId: task.id, error: r.error });
        await gh.addComment(task.issueNumber, `[kilo-bridge-report] Publishing refused: ${r.error}`).catch(() => undefined);
      }
    }
    return count;
  }

  // ------------------------------------------------------------------
  // Label synchronization
  // ------------------------------------------------------------------

  private async syncLabel(gh: GitHubProvider, task: TaskRecord, status: TaskStatus, remove: LabelName[]): Promise<void> {
    const add = STATUS_LABEL[status];
    for (const label of remove) {
      await gh.removeLabel(task.issueNumber, label);
    }
    if (add) await gh.addLabels(task.issueNumber, [add]);
  }

  // ------------------------------------------------------------------
  // Persistent worker loop with singleton lock + graceful shutdown
  // ------------------------------------------------------------------

  private lockPath(): string {
    return path.join(this.bridgeRoot, "data", "worker.lock");
  }

  private stopPath(): string {
    return path.join(this.bridgeRoot, "data", "worker.stop");
  }

  private readLock(): { pid: number; workerId: string; heartbeat: string } | null {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath(), "utf8"));
    } catch {
      return null;
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  acquireLock(): BridgeResult<void> {
    const existing = this.readLock();
    if (existing && existing.pid !== process.pid && this.isPidAlive(existing.pid)) {
      const heartbeatAge = Date.now() - new Date(existing.heartbeat).getTime();
      if (heartbeatAge < 2 * (this.config.pollIntervalMs ?? 30_000)) {
        return failResult(`another worker is running (pid ${existing.pid}, ${existing.workerId})`, "WORKER_ALREADY_RUNNING");
      }
    }
    this.writeLock();
    return okResult();
  }

  private writeLock(): void {
    const dir = path.dirname(this.lockPath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.lockPath(), JSON.stringify({ pid: process.pid, workerId: this.workerId, heartbeat: new Date().toISOString() }), "utf8");
  }

  releaseLock(): void {
    try {
      const existing = this.readLock();
      if (existing && existing.pid === process.pid) fs.unlinkSync(this.lockPath());
    } catch { /* ignore */ }
  }

  async runForever(): Promise<BridgeResult<void>> {
    const locked = this.acquireLock();
    if (!locked.ok) return locked;
    try { fs.unlinkSync(this.stopPath()); } catch { /* ignore */ }

    const interval = this.config.pollIntervalMs ?? 30_000;
    this.logger.info("worker started", { workerId: this.workerId, interval, mode: this.mode });

    const onSignal = () => {
      this.logger.info("shutdown signal received");
      this.requestStop();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    try {
      while (!this.stopping) {
        if (fs.existsSync(this.stopPath())) {
          this.logger.info("stop file detected; shutting down");
          break;
        }
        this.writeLock();
        try {
          await this.pollOnce();
        } catch (err) {
          this.logger.error("poll cycle failed", { error: String(err) });
        }
        // Interruptible sleep.
        const deadline = Date.now() + interval;
        while (!this.stopping && Date.now() < deadline) {
          if (fs.existsSync(this.stopPath())) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      this.releaseLock();
      try { fs.unlinkSync(this.stopPath()); } catch { /* ignore */ }
      this.logger.info("worker stopped", { workerId: this.workerId });
    }
    return okResult();
  }
}
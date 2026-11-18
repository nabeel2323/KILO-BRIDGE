"use strict";

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { WorktreeManager } from "./worktree";
import { SecurityManager } from "./security";
import { KiloCliAdapter } from "./kilo";
import { VerificationEngine } from "./verification";
import { ReportGenerator } from "./report";
import { GitHubProvider } from "./github";
import { findProhibitedFiles } from "./publishing";
import { Logger } from "./logging";
import { SqliteStore } from "../db";
import type {
  ProjectConfig,
  TaskRecord,
  VerificationRecord,
  ReportStatus,
  WorkerModeConfig,
} from "../types";
import { ProjectRegistry } from "./registry";
import { LifecycleManager, validateTaskAuthor } from "./lifecycle";
import { LABELS, BridgeResult, okResult, failResult, MAX_TASK_ATTEMPTS } from "../types";
export type { WorkerMode } from "../types";

export interface WorkerOptions {
  store: SqliteStore;
  registry: ProjectRegistry;
  logger: Logger;
  bridgeRoot: string;
  config: WorkerModeConfig;
  mode: "mock" | "real" | "dry-run";
  githubFactory: (project: ProjectConfig) => GitHubProvider;
  kiloBin: string;
  workerId: string;
}

export interface PollProjectResult {
  project: string;
  discovered: number;
  executed: number;
  corrections: number;
  published: number;
  rejected: Array<{ issue: number; reason: string }>;
  errors: string[];
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

export class Worker {
  private readonly store: SqliteStore;
  private readonly registry: ProjectRegistry;
  private readonly logger: Logger;
  private readonly opts: WorkerOptions;
  private readonly lifecycle: LifecycleManager;

  // Runtime state for continuous worker mode.
  private _running = false;
  private _stopRequested = false;
  private _activeProject: string | null = null;
  private _activeTask: string | null = null;
  private _lastPoll: string | null = null;

  constructor(opts: WorkerOptions) {
    this.store = opts.store;
    this.registry = opts.registry;
    this.logger = opts.logger;
    this.opts = opts;
    this.lifecycle = new LifecycleManager({
      getTask: (id) => opts.store.getTask(id),
      upsertTask: (t) => opts.store.upsertTask(t),
      insertTransition: (t) => opts.store.insertTransition(t),
      listTasksByStatuses: (statuses) => opts.store.listTasksByStatuses(statuses),
    });
  }

  getState(): WorkerState {
    const lockPath = path.join(this.opts.bridgeRoot, "data", "worker.lock");
    let pid: number | null = null;
    let workerId: string | null = null;
    let heartbeat: string | null = null;
    try {
      if (fs.existsSync(lockPath)) {
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        pid = current.pid ?? null;
        workerId = current.workerId ?? null;
        heartbeat = current.heartbeat ?? null;
      }
    } catch { /* ignore */ }
    return {
      running: this._running && !this._stopRequested,
      pid,
      workerId,
      heartbeat,
      activeProject: this._activeProject,
      activeTask: this._activeTask,
      lastPoll: this._lastPoll,
    };
  }

  acquireLock(): BridgeResult<void> {
    const lockPath = path.join(this.opts.bridgeRoot, "data", "worker.lock");
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    let current: { pid: number; workerId: string; heartbeat: string } | null = null;
    try {
      if (fs.existsSync(lockPath)) {
        current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      }
    } catch {
      current = null;
    }
    if (current) {
      const stale = new Date(current.heartbeat).getTime() < Date.now() - 30 * 60 * 1000;
      if (!stale) {
        return failResult(`worker already running (${current.workerId}, pid ${current.pid})`, "WORKER_ALREADY_RUNNING");
      }
    }
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, workerId: this.opts.workerId, heartbeat: now }), "utf8");
    } catch (err) {
      return failResult(`failed to acquire worker lock: ${err}`, "LOCK_FAILED");
    }
    return okResult();
  }

  releaseLock(): void {
    const lockPath = path.join(this.opts.bridgeRoot, "data", "worker.lock");
    try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }

  updateHeartbeat(): void {
    const lockPath = path.join(this.opts.bridgeRoot, "data", "worker.lock");
    try {
      if (fs.existsSync(lockPath)) {
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        current.heartbeat = new Date().toISOString();
        fs.writeFileSync(lockPath, JSON.stringify(current, null, 2), "utf8");
      }
    } catch { /* ignore */ }
  }

  requestStop(): void {
    this._stopRequested = true;
  }

  async pollOnce(): Promise<BridgeResult<PollProjectResult[]>> {
    try { this.lifecycle.recoverExpiredLeases(this.opts.workerId); } catch { /* best effort */ }
    this.updateHeartbeat();
    this._lastPoll = new Date().toISOString();
    const allProjects = this.registry.list();
    const projects = allProjects.filter((p) => p.state === "active");
    const results: PollProjectResult[] = [];
    for (const { config } of projects) {
      results.push(await this.processProject(config));
    }
    return okResult(results);
  }

  /**
   * Run continuous polling until stop is requested.
   * Updates heartbeat each cycle and tracks active project/task.
   */
  async startContinuous(intervalMs: number): Promise<void> {
    this._running = true;
    this._stopRequested = false;
    this.logger.info(`worker starting continuous polling (interval=${intervalMs}ms, pid=${process.pid})`);
    while (!this._stopRequested) {
      try {
        const res = await this.pollOnce();
        if (!res.ok) {
          this.logger.error(`poll cycle failed: ${res.error}`);
        } else {
          const data = res.data as PollProjectResult[];
          const active = data.find((r) => r.discovered > 0 || r.executed > 0 || r.corrections > 0);
          this._activeProject = active ? active.project : null;
          this._activeTask = null; // task-level tracking handled in executeTask via caller
        }
      } catch (err) {
        this.logger.error(`poll cycle error: ${err}`);
      }
      // Sleep until next interval, honoring stop requests promptly.
      const start = Date.now();
      while (!this._stopRequested && Date.now() - start < intervalMs) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    this._running = false;
    this.logger.info(`worker stopped (pid=${process.pid})`);
    this.releaseLock();
  }

  async stop(): Promise<void> {
    this.requestStop();
  }

  private async processProject(config: ProjectConfig): Promise<PollProjectResult> {
    const result: PollProjectResult = {
      project: config.id,
      discovered: 0,
      executed: 0,
      corrections: 0,
      published: 0,
      rejected: [],
      errors: [],
    };

    const gh = this.opts.githubFactory(config);
    const auth = await gh.authStatus();
    if (!auth.authenticated) {
      result.errors.push(`GitHub not authenticated: ${auth.error}`);
      this.logger.warn(`project ${config.id}: ${auth.error}`);
      return result;
    }
    await gh.ensureLabels(LABELS as any).catch(() => {});

    // Correction workflow first.
    const corr = await this.processCorrections(config, gh);
    result.corrections += corr.corrections;
    result.errors.push(...corr.errors);

    // Re-execute recovered READY tasks that already exist in DB (e.g. expired lease).
    const readyDb = this.store.listTasksByProject(config.id, "READY");
    for (const task of readyDb) {
      if (this.opts.mode === "dry-run" || !this.opts.config.workerEnabled) continue;
      const ok = await this.executeTask(config, gh, task);
      if (ok) result.executed++;
      else result.errors.push(`execution failed for task ${task.id}`);
    }

    // Discover READY tasks from GitHub.
    const ready = await gh.listOpenIssues({ labels: ["kilo:ready"], limit: 50 });
    if (!ready.ok || !ready.data) {
      result.errors.push(ready.error ?? "failed to list issues");
      return result;
    }

    for (const issue of ready.data) {
      if (issue.pullRequest) continue;

      const existing = this.store.getTaskByProjectIssue(config.id, issue.number);
      if (existing) continue;

      result.discovered++;

      const authCheck = validateTaskAuthor(issue.author, config.allowedAuthors);
      if (!authCheck.ok) {
        result.rejected.push({ issue: issue.number, reason: authCheck.error ?? "unauthorized" });
        this.store.insertAudit({ projectId: config.id, actor: issue.author, action: "task.rejected", detail: authCheck.error });
        continue;
      }

      const idempotencyKey = this.lifecycle.generateIdempotencyKey(config.id, issue.number);
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.store.upsertTask(task);
      this.store.insertTransition({ id: crypto.randomUUID(), taskId: task.id, fromStatus: undefined, toStatus: "READY", reason: "discovered via GitHub", actor: "system", createdAt: new Date().toISOString() });
      await gh.addLabels(issue.number, ["kilo:claimed"]).catch(() => {});

      if (this.opts.mode === "dry-run" || !this.opts.config.workerEnabled) {
        continue;
      }

      const ok = await this.executeTask(config, gh, task);
      if (ok) result.executed++;
      else result.errors.push(`execution failed for issue ${issue.number}`);
    }

    // Publishing workflow.
    if (config.publishingEnabled) {
      const pub = await this.processPublishing(config, gh);
      result.published += pub.published;
      result.errors.push(...pub.errors);
    }

    return result;
  }

  private async processCorrections(config: ProjectConfig, gh: GitHubProvider): Promise<{ corrections: number; errors: string[] }> {
    let corrections = 0;
    const errors: string[] = [];
    const reportReady = this.store.listTasksByProject(config.id, "REPORT_READY");
    for (const task of reportReady) {
      const labels = await this.issueLabels(gh, task.issueNumber);
      if (!labels.includes("kilo:changes-requested")) continue;

      const comments = await gh.listComments(task.issueNumber);
      if (!comments.ok || !comments.data) continue;

      const lastProcessed = task.lastCommentId ?? 0;
      const newComments = comments.data.filter((c) => c.id > lastProcessed && !c.isBridge);
      if (newComments.length === 0) continue;

      const newest = newComments[newComments.length - 1];
      const authCheck = validateTaskAuthor(newest.author, config.allowedAuthors);
      if (!authCheck.ok) continue; // ignore unauthorized follow-up

      const updated = await this.lifecycle.beginCorrection(task.id, newest.author, newest.body);
      if (!updated.ok) {
        errors.push(updated.error ?? "correction failed");
        continue;
      }

      await this.store.setLastCommentId(task.id, newest.id);
      const attempt = updated.data!.attempt;
      const ok = await this.executeTask(config, gh, { ...task, attempt });
      if (ok) corrections++;
      else errors.push(`correction execution failed for task ${task.id}`);
    }
    return { corrections, errors };
  }

  private async executeTask(config: ProjectConfig, gh: GitHubProvider, task: TaskRecord): Promise<boolean> {
    const claim = this.lifecycle.claimTask(task.id, this.opts.workerId, 10 * 60 * 1000);
    if (!claim.ok) {
      // Correction path: task may already be CLAIMED/RUNNING with a valid/expired lease.
      const resume = this.lifecycle.resumeClaim(task.id, this.opts.workerId);
      if (!resume.ok) {
        this.logger.warn(`claim/resume failed for task ${task.id}: ${claim.error} / ${resume.error}`);
        return false;
      }
    }

    this.lifecycle.transition(task.id, "RUNNING", { reason: "execution started", actor: this.opts.workerId });
    // Remove ready label when task is claimed/in progress.
    await gh.removeLabel(task.issueNumber, "kilo:ready").catch(() => {});
    await gh.addLabels(task.issueNumber, ["kilo:running"]).catch(() => {});

    const wtMgr = new WorktreeManager({
      projectId: config.id,
      localRepoPath: config.localPath,
      worktreeRoot: config.worktreeRoot,
      baseBranch: config.baseBranch,
      branchPrefix: config.branchPrefix,
      releaseBranch: config.releaseBranch,
    });
    let prep = await wtMgr.prepareTaskWorktree(task.issueNumber, task.attempt);
    if (!prep.ok && prep.error === "BRANCH_EXISTS") {
      // Expired-lease recovery: old branch/worktree may still exist. Clean up and retry.
      const branch = wtMgr.generateBranchName(task.issueNumber, task.attempt);
      const dir = wtMgr.worktreePathFor(branch);
      await wtMgr.cleanupWorktreeAndBranch(branch, dir);
      prep = await wtMgr.prepareTaskWorktree(task.issueNumber, task.attempt);
      if (!prep.ok) {
        await this.failTask(task, gh, `worktree preparation failed: ${prep.error}`);
        return false;
      }
    } else if (!prep.ok) {
      await this.failTask(task, gh, `worktree preparation failed: ${prep.error}`);
      return false;
    }
    const { branch: prepBranch, dir: prepDir, baseSha: prepBaseSha } = prep.data!;

    // Persist worktree metadata on the task.
    const current = this.store.getTask(task.id);
    const withPrep: TaskRecord = {
      ...(current ?? task),
      featureBranch: prepBranch,
      worktreePath: prepDir,
      baseSha: prepBaseSha,
      updatedAt: new Date().toISOString(),
    };
    this.store.upsertTask(withPrep);

    const secMgr = new SecurityManager(config.id, config.worktreeRoot, this.opts.bridgeRoot);

    // Write the project-level Kilo permission config (.kilo/kilo.jsonc) into
    // the worktree so the Kilo subprocess runs under deny-by-default
    // permissions regardless of the user's global Kilo configuration.
    if (!secMgr.writeKiloProjectConfig(prepDir).ok) {
      await this.failTask(withPrep, gh, "could not write kilo project config");
      return false;
    }

    const policy = secMgr.generatePolicy(config);
    if (!secMgr.validatePolicy(policy).ok) {
      await this.failTask(withPrep, gh, "security policy invalid");
      return false;
    }
    if (!secMgr.writeKiloPermissionFile(prepDir, policy).ok) {
      await this.failTask(withPrep, gh, "could not write kilo permissions");
      return false;
    }
    if (!secMgr.writeBridgeCommandPolicy(prepDir).ok) {
      await this.failTask(withPrep, gh, "could not write bridge command policy");
      return false;
    }
    if (!(await secMgr.verifyEffectivePermissions(prepDir, { skipKiloCheck: true })).ok) {
      await this.failTask(withPrep, gh, "permission verification failed");
      return false;
    }

    const adapter = new KiloCliAdapter({
      kiloBin: this.opts.kiloBin,
      worktreePath: prepDir,
      taskTitle: `GitHub Issue #${task.issueNumber}`,
      taskSpec: task.body,
      timeoutMs: config.taskTimeoutMs ?? this.opts.config.defaultTaskTimeoutMs,
      auto: true,
      model: config.kiloModel,
      agent: config.kiloAgent,
    });
    const preflight = await adapter.preflight();
    if (!preflight.ok) {
      await this.failTask(withPrep, gh, `kilo preflight failed: ${preflight.error}`);
      return false;
    }
    const run = await adapter.run();
    const executionId = crypto.randomUUID();
    this.store.upsertExecution({
      id: executionId,
      taskId: task.id,
      attempt: withPrep.attempt,
      status: run.timedOut ? "TIMEOUT" : (run.exitCode === 0 ? "COMPLETED" : "FAILED"),
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      exitCode: run.exitCode ?? undefined,
      durationMs: run.durationMs,
      kiloVersion: run.kiloVersion,
      kiloSessionId: run.sessionId,
      kiloModel: run.model,
      kiloAgent: run.agent,
      eventLogPath: run.eventLogPath,
      errorMessage: run.error,
    });

    // Link latest execution on task.
    this.store.upsertTask({ ...withPrep, executionId, updatedAt: new Date().toISOString() });

    if (run.exitCode !== 0 || run.timedOut) {
      await this.failTask({ ...withPrep, executionId }, gh, `kilo execution failed (exit ${run.exitCode}${run.timedOut ? " timed out" : ""})`);
      return false;
    }

    // Verification
    const changedFiles = await wtMgr.collectChangedFiles(prepDir);
    const commands = VerificationEngine.commandsFromProject(config, prepDir);
    const engine = new VerificationEngine({ worktreePath: prepDir, resultsDir: path.join(this.opts.bridgeRoot, "reports", "verification") });
    const selected = engine.selectCommands(commands, changedFiles);
    // Enforce Bridge-level command deny-list before any verification command runs.
    // Kilo never executes these; the Bridge runs them independently.
    for (const cmd of selected) {
      if (secMgr.isCommandDenied(`${cmd.command} ${cmd.args.join(" ")}`)) {
        await this.failTask(withPrep, gh, `prohibited verification command denied: ${cmd.command}`);
        return false;
      }
    }
    const results = await engine.runSuite(selected, []);
    const records = results.map((r) => engine.toRecord(executionId, r));
    for (const rec of records) {
      this.store.insertVerification(rec);
    }
    const requiredPassed = engine.allRequiredPassed(results, commands);

    // Report
    const reportStatus: ReportStatus = requiredPassed ? "COMPLETE" : "PARTIAL";
    const latestTask = this.store.getTask(task.id) ?? withPrep;
    const reportData = this.buildReportData(config, latestTask, { branch: prepBranch, dir: prepDir, baseSha: prepBaseSha }, run, executionId, records, reportStatus);
    const gen = new ReportGenerator(this.opts.config.reportsDir);
    const genRes = gen.generate(reportData);
    if (!genRes.ok) this.logger.error(`report generation failed: ${genRes.error}`);

    const reportRecord = {
      id: crypto.randomUUID(),
      taskId: task.id,
      executionId,
      status: reportStatus,
      reportPath: genRes.data ?? "",
      createdAt: new Date().toISOString(),
    };
    this.store.upsertReport(reportRecord);

    const commentBody = gen.buildComment(reportData, genRes.data ?? "");
    const comment = await gh.addComment(task.issueNumber, commentBody);
    if (comment.ok && comment.data) {
      this.store.upsertReport({ ...reportRecord, issueCommentId: comment.data, postedAt: new Date().toISOString() });
    }

    await gh.removeLabel(task.issueNumber, "kilo:running").catch(() => {});
    await gh.removeLabel(task.issueNumber, "kilo:claimed").catch(() => {});
    await gh.addLabels(task.issueNumber, ["kilo:report-ready"]).catch(() => {});
    this.lifecycle.transition(task.id, "REPORT_READY", { reason: "report ready", actor: this.opts.workerId });
    this.logger.info(`task ${task.id} completed with status ${reportStatus}`);
    return true;
  }

  private async processPublishing(config: ProjectConfig, gh: GitHubProvider): Promise<{ published: number; errors: string[] }> {
    let published = 0;
    const errors: string[] = [];
    const tasks = this.store.listTasksByProject(config.id, "REPORT_READY");
    for (const task of tasks) {
      const labels = await this.issueLabels(gh, task.issueNumber);
      if (!labels.includes("kilo:publish-approved")) continue;

      const executions = this.store.listExecutions(task.id);
      const latest = executions[executions.length - 1];
      if (!latest) continue;
      const verifications = this.store.listVerifications(latest.id);
      const commands = VerificationEngine.commandsFromProject(config, task.worktreePath ?? config.localPath);
      const engine = new VerificationEngine({ worktreePath: task.worktreePath ?? config.localPath, resultsDir: this.opts.config.reportsDir });
      if (!engine.allRequiredPassed(verifications, commands)) {
        await gh.addComment(task.issueNumber, "Publishing refused: required verification did not pass.").catch(() => {});
        continue;
      }

      const wtDir = task.worktreePath ?? config.localPath;
      const wtMgrForFiles = new WorktreeManager({
        projectId: config.id,
        localRepoPath: config.localPath,
        worktreeRoot: config.worktreeRoot,
        baseBranch: config.baseBranch,
        branchPrefix: config.branchPrefix,
        releaseBranch: config.releaseBranch,
      });
      // Check prohibited files BEFORE committing (commit would make untracked files
      // invisible to collectChangedFiles).
      const changedFiles = await wtMgrForFiles.collectChangedFiles(wtDir);
      const prohibited = findProhibitedFiles(changedFiles);
      if (prohibited.length > 0) {
        await gh.addComment(task.issueNumber, `Publishing refused: prohibited files detected: ${prohibited.join(", ")}`).catch(() => {});
        continue;
      }
      // Commit kilo's worktree changes before pushing.
      await wtMgrForFiles.commitAll(wtDir, `chore: implement task #${task.issueNumber}`).catch(() => {});

      const push = await wtMgrForFiles.pushBranch(wtDir, task.featureBranch ?? "");
      if (!push.ok) { errors.push(`push failed for task ${task.id}: ${push.error}`); continue; }
      const pr = await gh.createDraftPr({ title: `AI: ${task.title}`, body: `Implementation for issue #${task.issueNumber}`, head: task.featureBranch ?? "", base: config.baseBranch });
      if (!pr.ok) { errors.push(`draft PR failed for task ${task.id}: ${pr.error}`); continue; }
      await gh.addComment(task.issueNumber, `Draft pull request: ${pr.data}`).catch(() => {});
      await gh.removeLabel(task.issueNumber, "kilo:report-ready").catch(() => {});
      await gh.addLabels(task.issueNumber, ["kilo:published"]).catch(() => {});
      this.lifecycle.transition(task.id, "PUBLISHED", { reason: "published", actor: this.opts.workerId });
      published++;
    }
    return { published, errors };
  }

  private async failTask(task: TaskRecord, gh: GitHubProvider, reason: string): Promise<void> {
    // Only create an execution record if none exists yet (preflight/policy/worktree failures).
    // Kilo run failures already upserted an execution before calling failTask.
    if (!task.executionId) {
      const executionId = crypto.randomUUID();
      try {
        this.store.upsertExecution({
          id: executionId,
          taskId: task.id,
          attempt: task.attempt,
          status: "FAILED",
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
          errorMessage: reason,
        });
        this.store.upsertTask({ ...task, executionId, updatedAt: new Date().toISOString() });
      } catch { /* best effort */ }
    }
    const executionId = task.executionId ?? crypto.randomUUID();
    // Synchronize labels: remove all progress labels, apply failed.
    await gh.removeLabel(task.issueNumber, "kilo:ready").catch(() => {});
    await gh.removeLabel(task.issueNumber, "kilo:claimed").catch(() => {});
    await gh.removeLabel(task.issueNumber, "kilo:running").catch(() => {});
    await gh.removeLabel(task.issueNumber, "kilo:report-ready").catch(() => {});
    await gh.addLabels(task.issueNumber, ["kilo:failed"]).catch(() => {});
    try { this.lifecycle.transition(task.id, "FAILED", { reason, actor: this.opts.workerId }); } catch { /* may already be failed */ }
    try {
      const reportsDir = path.join(this.opts.config.reportsDir, task.projectId);
      const gen = new ReportGenerator(reportsDir);
      const report = {
        taskId: task.id,
        issueNumber: task.issueNumber,
        issueUrl: task.issueUrl,
        projectId: task.projectId,
        executionId,
        attempt: task.attempt,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        baseSha: task.baseSha,
        featureBranch: task.featureBranch,
        implementationSummary: "Kilo execution failed.",
        changedFiles: [],
        diffStats: "",
        verifications: [],
        testFailures: [],
        documentationChanges: [],
        securityObservations: [],
        unmetAcceptanceCriteria: [reason],
        outstandingIssues: [],
        status: "FAILED" as ReportStatus,
      };
      const genRes = gen.generate(report);
      if (genRes.ok) {
        const reportId = crypto.randomUUID();
        this.store.upsertReport({
          id: reportId,
          taskId: task.id,
          executionId,
          status: "FAILED",
          reportPath: genRes.data ?? "",
          createdAt: new Date().toISOString(),
        });
        // Post the comment and store its ID against this execution record.
        const comment = await gh.addComment(task.issueNumber, gen.buildComment(report, genRes.data ?? ""));
        if (comment.ok && comment.data) {
          this.store.upsertReport({
            id: reportId,
            taskId: task.id,
            executionId,
            status: "FAILED",
            reportPath: genRes.data ?? "",
            issueCommentId: comment.data,
            postedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          });
        }
      }
    } catch { /* best effort */ }
  }

  private buildReportData(
    config: ProjectConfig,
    task: TaskRecord,
    prep: { branch: string; dir: string; baseSha: string },
    run: any,
    executionId: string,
    results: Omit<VerificationRecord, "id">[],
    status: ReportStatus
  ): any {
    return {
      taskId: task.id,
      issueNumber: task.issueNumber,
      issueUrl: task.issueUrl,
      projectId: config.id,
      executionId,
      attempt: task.attempt,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      kiloVersion: run.kiloVersion,
      model: run.model,
      agent: run.agent,
      sessionId: run.sessionId,
      baseSha: prep.baseSha,
      featureBranch: prep.branch,
      implementationSummary: run.finalResponse ?? "Implementation completed by Kilo agent.",
      changedFiles: [],
      diffStats: "",
      verifications: results,
      testFailures: results.filter((v) => v.passed === false).map((v) => `${v.command} ${v.args.join(" ")}`),
      documentationChanges: [],
      securityObservations: [],
      unmetAcceptanceCriteria: status === "COMPLETE" ? [] : ["Required verification commands did not all pass."],
      outstandingIssues: [],
      status,
    };
  }

  private async issueLabels(gh: GitHubProvider, issueNumber: number): Promise<string[]> {
    const issue = await gh.getIssue(issueNumber);
    return issue.ok ? (issue.data!.labels ?? []) : [];
  }
}

"use strict";

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  SqliteStore,
  type DbConnection,
} from "./db";
import { Logger } from "./components/logging";
import { ProjectRegistry } from "./components/registry";
import { GitHubProvider, ghMissingError, isGhNotFound } from "./components/github";
import { LifecycleManager, validateTaskAuthor } from "./components/lifecycle";
import { WorktreeManager } from "./components/worktree";
import { SecurityManager } from "./components/security";
import { KiloCliAdapter } from "./components/kilo";
import { VerificationEngine } from "./components/verification";
import { ReportGenerator } from "./components/report";
import { ensureBridgeConfig } from "./config";
import type {
  BridgeResult,
  ProjectConfig,
  TaskRecord,
  ExecutionRecord,
  VerificationRecord,
  ReportStatus,
  SecurityPolicy,
} from "./types";
import { okResult, failResult, TASK_STATUSES, LABELS, DEFAULT_POLL_INTERVAL_MS, DEFAULT_TASK_TIMEOUT_MS, BRIDGE_VERSION, KILO_READY_MARKER } from "./types";

export interface AppContext {
  store: SqliteStore;
  db: DbConnection;
  logger: Logger;
  registry: ProjectRegistry;
  bridgeRoot: string;
}

export class KiloBridgeApp {
  private ctx!: AppContext;
  private initialized = false;

  async init(bridgeRoot: string): Promise<BridgeResult<void>> {
    this.ctx = { store: null as unknown as SqliteStore, db: null as unknown as DbConnection, logger: null as unknown as Logger, registry: null as unknown as ProjectRegistry, bridgeRoot };

    const dataDir = path.join(bridgeRoot, "data");
    const logsDir = path.join(bridgeRoot, "logs");
    const reportsDir = path.join(bridgeRoot, "reports");
    for (const d of [dataDir, logsDir, reportsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    const dbPath = path.join(dataDir, "kilo-bridge.sqlite");
    const store = new SqliteStore(dbPath);
    const db = await store.open();

    const logger = new Logger({ logsDir, serviceName: "kilo-bridge", enableConsole: true });
    this.ctx = { store, db, logger, registry: null as unknown as ProjectRegistry, bridgeRoot };

    ensureBridgeConfig(bridgeRoot);

    logger.info("Kilo Bridge initialized", { version: BRIDGE_VERSION, dbPath });

    // Build registry wired to store
    const deps = {
      upsertProject: (c: ProjectConfig, state: string) => store.upsertProject(c, state),
      getProject: (id: string) => store.getProject(id),
      listProjects: () => store.listProjects(),
      setProjectState: (id: string, state: string) => store.setProjectState(id, state),
      getSecurityPolicy: (pid: string) => store.getSecurityPolicy(pid),
      upsertSecurityPolicy: (p: SecurityPolicy) => store.upsertSecurityPolicy(p),
    };
    this.ctx.registry = new ProjectRegistry(deps);
    this.initialized = true;

    return okResult();
  }

  requireInit(): BridgeResult<void> {
    if (!this.initialized || !this.ctx.store) {
      return failResult("application not initialized. Run 'kilo-bridge init' first.", "NOT_INITIALIZED");
    }
    return okResult();
  }

  // ------------------------------------------------------------------
  // doctor
  // ------------------------------------------------------------------
  async doctor(): Promise<BridgeResult<{ checks: Array<{ name: string; ok: boolean; detail: string }> }>> {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    // Node
    checks.push({ name: "node", ok: true, detail: process.version });
    // git
    const { spawn } = await import("node:child_process");
    const git = await runCmd("git", ["--version"]);
    checks.push({ name: "git", ok: git.code === 0, detail: git.stdout.trim() || git.stderr.trim() });
    // gh
    const gh = await runCmd("gh", ["--version"]);
    if (gh.code === 0) {
      checks.push({ name: "gh", ok: true, detail: gh.stdout.trim().split("\n")[0] });
    } else if (isGhNotFound(gh.stderr)) {
      checks.push({ name: "gh", ok: false, detail: "GitHub CLI not installed" });
    } else {
      checks.push({ name: "gh", ok: false, detail: gh.stderr.trim() });
    }
    // kilo
    const kilo = await runCmd("kilo", ["--version"]);
    if (kilo.code === 0) {
      checks.push({ name: "kilo", ok: true, detail: kilo.stdout.trim() });
    } else if (isGhNotFound(kilo.stderr)) {
      checks.push({ name: "kilo", ok: false, detail: "Kilo CLI not installed" });
    } else {
      checks.push({ name: "kilo", ok: false, detail: kilo.stderr.trim() });
    }
    // db
    const req = this.requireInit();
    if (req.ok) {
      checks.push({ name: "sqlite", ok: true, detail: "database open" });
    } else {
      checks.push({ name: "sqlite", ok: false, detail: req.error ?? "unknown" });
    }

    const allOk = checks.every((c) => c.ok);
    return okResult({ checks }).ok ? okResult({ checks }) : failResult("doctor checks failed", "DOCTOR_FAILED");
  }

  // ------------------------------------------------------------------
  // projects
  // ------------------------------------------------------------------
  projectsList(): BridgeResult<Array<{ id: string; name: string; repository: string; state: string; localPath: string }>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    const list = this.ctx.registry.list();
    return okResult(
      list.map(({ config, state }) => ({
        id: config.id,
        name: config.name,
        repository: config.repository,
        state,
        localPath: config.localPath,
      }))
    );
  }

  projectsAdd(input: any): BridgeResult<ProjectConfig> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    return this.ctx.registry.add(input);
  }

  projectsValidate(input: any): BridgeResult<ProjectConfig> {
    return this.ctx.registry.validate(input);
  }

  projectsDisable(id: string): BridgeResult<void> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    return this.ctx.registry.disable(id);
  }

  projectsEnable(id: string): BridgeResult<void> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    return this.ctx.registry.enable(id);
  }

  projectsInspect(id: string): BridgeResult<any> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    return this.ctx.registry.inspect(id);
  }

  // ------------------------------------------------------------------
  // github bootstrap / test
  // ------------------------------------------------------------------
  async githubBootstrap(projectId: string): Promise<BridgeResult<{ authenticated: boolean; labels: any }>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    const proj = this.ctx.registry.get(projectId);
    if (!proj) return failResult(`project ${projectId} not found`, "PROJECT_NOT_FOUND");
    const [owner, repo] = proj.config.repository.split("/");
    const gh = new GitHubProvider({ owner, repo });
    const auth = await gh.authStatus();
    if (!auth.authenticated) {
      return failResult(`GitHub not authenticated: ${auth.error}`, "GH_NOT_AUTHENTICATED");
    }
    const labels = await gh.ensureLabels(LABELS as any);
    return okResult({ authenticated: true, user: auth.user, labels });
  }

  async githubTest(projectId: string): Promise<BridgeResult<{ authenticated: boolean; rateLimit?: any }>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    const proj = this.ctx.registry.get(projectId);
    if (!proj) return failResult(`project ${projectId} not found`, "PROJECT_NOT_FOUND");
    const [owner, repo] = proj.config.repository.split("/");
    const gh = new GitHubProvider({ owner, repo });
    const auth = await gh.authStatus();
    return okResult({ authenticated: auth.authenticated, user: auth.user });
  }

  // ------------------------------------------------------------------
  // tasks
  // ------------------------------------------------------------------
  tasksList(projectId?: string, status?: string): BridgeResult<TaskRecord[]> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    if (projectId) {
      return okResult(this.ctx.store.listTasksByProject(projectId, status));
    }
    if (status) {
      return okResult(this.ctx.store.listTasksByStatus(status));
    }
    // all tasks across projects
    const all: TaskRecord[] = [];
    for (const p of this.ctx.registry.list()) {
      all.push(...this.ctx.store.listTasksByProject(p.config.id));
    }
    return okResult(all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  taskGet(id: string): BridgeResult<TaskRecord | null> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    return okResult(this.ctx.store.getTask(id));
  }

  taskLogs(id: string): BridgeResult<{ executions: ExecutionRecord[]; verifications: VerificationRecord[] }> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    const task = this.ctx.store.getTask(id);
    if (!task) return failResult(`task ${id} not found`, "TASK_NOT_FOUND");
    const executions = this.ctx.store.listExecutions(id);
    let verifications: VerificationRecord[] = [];
    for (const e of executions) {
      verifications.push(...this.ctx.store.listVerifications(e.id));
    }
    return okResult({ executions, verifications });
  }

  taskReports(id: string): BridgeResult<any[]> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    return okResult(this.ctx.store.getReports(id));
  }

  // ------------------------------------------------------------------
  // verify
  // ------------------------------------------------------------------
  async verifyProject(projectId: string): Promise<BridgeResult<any>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");
    const proj = this.ctx.registry.get(projectId);
    if (!proj) return failResult(`project ${projectId} not found`, "PROJECT_NOT_FOUND");
    const tasks = this.ctx.store.listTasksByProject(projectId, "REPORT_READY");
    if (tasks.length === 0) return okResult({ message: "no report-ready tasks", results: [] });
    const task = tasks[0];
    const latestExecutions = this.ctx.store.listExecutions(task.id);
    const latest = latestExecutions[latestExecutions.length - 1];
    if (!latest) return failResult("no execution found", "NO_EXECUTION");

    const commands = VerificationEngine.scsPlatformProfile(task.worktreePath ?? proj.config.localPath);
    const changedFiles = this.ctx.store.getTask(task.id)?.featureBranch ? [] : [];
    const engine = new VerificationEngine({ worktreePath: task.worktreePath ?? proj.config.localPath, resultsDir: path.join(this.ctx.bridgeRoot, "reports", "verification") });
    const results = await engine.runSuite(commands, changedFiles);
      const records = results.map((r) => engine.toRecord(latest.id, r));
      for (const rec of records) {
        this.ctx.store.insertVerification(rec);
      }
    return okResult({ taskId: task.id, executionId: latest.id, results });
  }

  // ------------------------------------------------------------------
  // worker
  // ------------------------------------------------------------------
  async workerStart(opts: { dryRun?: boolean; projectId?: string; once?: boolean }): Promise<BridgeResult<any>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");

    const bridgeCfg = ensureBridgeConfig(this.ctx.bridgeRoot);
    if (!bridgeCfg.workerEnabled && !opts.dryRun) {
      return failResult("worker is disabled. Enable after manual review and security validation.", "WORKER_DISABLED");
    }

    const results: any[] = [];
    const projects = opts.projectId ? [this.ctx.registry.get(opts.projectId)!] : this.ctx.registry.list().filter((p) => p.config.state === "active");
    for (const { config } of projects) {
      const r = await this.processProject(config, opts.dryRun ?? false);
      results.push(r);
      if (opts.once) break;
    }
    return okResult({ processed: results.length, results });
  }

  private async processProject(config: ProjectConfig, dryRun: boolean): Promise<any> {
    const [owner, repo] = config.repository.split("/");
    const gh = new GitHubProvider({ owner, repo });
    const auth = await gh.authStatus();
    if (!auth.authenticated) {
      return { project: config.id, error: "gh not authenticated", skipped: true };
    }
    // ensure labels
    await gh.ensureLabels(LABELS as any);

    const ready = await gh.listOpenIssues({ labels: ["kilo:ready"], limit: 50 });
    if (!ready.ok || !ready.data) return { project: config.id, error: ready.error, skipped: true };

    const lifecycle = new LifecycleManager({
      getTask: (id) => this.ctx.store.getTask(id),
      upsertTask: (t) => this.ctx.store.upsertTask(t),
      insertTransition: (t) => this.ctx.store.insertTransition(t),
    });

    const processed: any[] = [];
    for (const issue of ready.data) {
      if (issue.pullRequest) continue; // filter out PRs
      // validate author
      const authCheck = validateTaskAuthor(issue.author, config.allowedAuthors);
      if (!authCheck.ok) {
        processed.push({ issue: issue.number, rejected: true, reason: authCheck.error });
        continue;
      }
      const idempotencyKey = crypto.createHash("sha256").update(`${config.id}:${issue.number}`).digest("hex");
      const existing = this.ctx.store.getTaskByIdempotencyKey(idempotencyKey);
      if (existing) {
        processed.push({ issue: issue.number, duplicate: true, taskId: existing.id });
        continue;
      }
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
      this.ctx.store.upsertTask(task);
      this.ctx.store.insertTransition({ id: crypto.randomUUID(), taskId: task.id, fromStatus: undefined, toStatus: "READY", reason: "discovered via GitHub", actor: "system", createdAt: new Date().toISOString() });

      if (dryRun) {
        processed.push({ issue: issue.number, claimed: false, dryRun: true, taskId: task.id });
        continue;
      }

      // Claim
      const claimed = lifecycle.claimTask(task.id, "kilo-worker", 10 * 60 * 1000);
      if (!claimed.ok) {
        processed.push({ issue: issue.number, claimed: false, reason: claimed.error });
        continue;
      }

      // Move to RUNNING (simulate; real execution requires Kilo)
      lifecycle.transition(task.id, "RUNNING", { reason: "execution started", actor: "kilo-worker" });

      // In dry-run / no kilo, mark BLOCKED pending manual review
      lifecycle.transition(task.id, "BLOCKED", { reason: "Kilo execution not configured (dry-run)", actor: "system" });
      processed.push({ issue: issue.number, claimed: true, taskId: task.id, status: "BLOCKED" });
    }
    return { project: config.id, processed };
  }
}

function runCmd(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: false });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    proc.on("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
  });
}

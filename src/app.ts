"use strict";

import path from "node:path";
import fs from "node:fs";
import { SqliteStore, type DbConnection } from "./db";
import { Logger } from "./components/logging";
import { ProjectRegistry } from "./components/registry";
import { GitHubProvider } from "./components/github";
import { Worker, type WorkerMode } from "./components/worker";
import { VerificationEngine } from "./components/verification";
import { WorktreeManager } from "./components/worktree";
import { ensureBridgeConfig, loadBridgeConfig, saveBridgeConfig, BridgeConfigSchema, type BridgeConfig } from "./config";
import { runProcess } from "./components/process";
import type {
  BridgeResult,
  ProjectConfig,
  TaskRecord,
  ExecutionRecord,
  VerificationRecord,
  SecurityPolicy,
} from "./types";
import { okResult, failResult, LABELS, BRIDGE_VERSION } from "./types";

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
    const dataDir = path.join(bridgeRoot, "data");
    const logsDir = path.join(bridgeRoot, "logs");
    const reportsDir = path.join(bridgeRoot, "reports");
    for (const d of [dataDir, logsDir, reportsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    const dbPath = path.join(dataDir, "kilo-bridge.sqlite");
    const store = new SqliteStore(dbPath);
    const db = await store.open();

    const logger = new Logger({ logsDir, serviceName: "kilo-bridge", enableConsole: false });
    this.ctx = { store, db, logger, registry: null as unknown as ProjectRegistry, bridgeRoot };

    ensureBridgeConfig(bridgeRoot);
    logger.info("Kilo Bridge initialized", { version: BRIDGE_VERSION, dbPath });

    this.ctx.registry = new ProjectRegistry({
      upsertProject: (c: ProjectConfig, state: string) => store.upsertProject(c, state),
      getProject: (id: string) => store.getProject(id),
      listProjects: () => store.listProjects(),
      setProjectState: (id: string, state: string) => store.setProjectState(id, state),
      getSecurityPolicy: (pid: string) => store.getSecurityPolicy(pid),
      upsertSecurityPolicy: (p: SecurityPolicy) => store.upsertSecurityPolicy(p),
    });
    this.initialized = true;
    return okResult();
  }

  requireInit(): BridgeResult<void> {
    if (!this.initialized || !this.ctx.store) {
      return failResult("application not initialized. Run 'kilo-bridge init' first.", "NOT_INITIALIZED");
    }
    return okResult();
  }

  get context(): AppContext {
    return this.ctx;
  }

  // ------------------------------------------------------------------
  // doctor
  // ------------------------------------------------------------------

  async doctor(): Promise<BridgeResult<{ checks: Array<{ name: string; ok: boolean; detail: string }>; allOk: boolean }>> {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    checks.push({ name: "node", ok: true, detail: process.version });

    const git = await runProcess("git", ["--version"], { timeoutMs: 15000 });
    checks.push({ name: "git", ok: git.code === 0, detail: git.stdout.trim() || git.stderr.trim() });

    const gh = new GitHubProvider({ owner: "doctor", repo: "doctor" });
    const ghVersion = await runProcess(process.env.GH_BIN ?? "gh", ["--version"], { timeoutMs: 15000 });
    let ghOk = ghVersion.code === 0;
    let ghDetail = ghVersion.stdout.trim().split("\n")[0] || ghVersion.stderr.trim();
    if (ghVersion.code === 127 && fs.existsSync("C:\\Program Files\\GitHub CLI\\gh.exe")) {
      const fallback = await runProcess("C:\\Program Files\\GitHub CLI\\gh.exe", ["--version"], { timeoutMs: 15000 });
      ghOk = fallback.code === 0;
      ghDetail = fallback.stdout.trim().split("\n")[0] + " (default install path)";
    }
    checks.push({ name: "gh", ok: ghOk, detail: ghDetail });
    if (ghOk) {
      const auth = await gh.authStatus();
      checks.push({ name: "gh-auth", ok: auth.authenticated, detail: auth.authenticated ? `logged in as ${auth.user ?? "unknown"}` : (auth.error ?? "not authenticated").split("\n")[0] });
    }

    const kilo = await runProcess(process.env.KILO_BIN ?? "kilo", ["--version"], { timeoutMs: 30000 });
    checks.push({ name: "kilo", ok: kilo.code === 0, detail: kilo.code === 0 ? kilo.stdout.trim() : (kilo.stderr.trim() || "Kilo CLI not found") });

    const req = this.requireInit();
    checks.push({ name: "sqlite", ok: req.ok, detail: req.ok ? "database open" : req.error! });

    if (req.ok) {
      const cfg = loadBridgeConfig(this.ctx.bridgeRoot);
      checks.push({ name: "worker-enabled", ok: true, detail: cfg.workerEnabled ? "enabled (explicit)" : "disabled (default; enable after review)" });
    }

    const allOk = checks.every((c) => c.ok);
    return okResult({ checks, allOk });
  }

  // ------------------------------------------------------------------
  // configure
  // ------------------------------------------------------------------

  configureGet(): BridgeResult<BridgeConfig> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, req.code);
    return okResult(loadBridgeConfig(this.ctx.bridgeRoot));
  }

  configureSet(key: string, value: string): BridgeResult<BridgeConfig> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, req.code);
    const allowed = ["workerEnabled", "pollIntervalMs", "defaultTaskTimeoutMs", "ghEnabled", "kiloEnabled"];
    if (!allowed.includes(key)) {
      return failResult(`unsupported config key: ${key}. Allowed: ${allowed.join(", ")}`, "INVALID_CONFIG_KEY");
    }
    const current = loadBridgeConfig(this.ctx.bridgeRoot) as unknown as Record<string, unknown>;
    let parsed: unknown = value;
    if (value === "true") parsed = true;
    else if (value === "false") parsed = false;
    else if (/^\d+$/.test(value)) parsed = Number(value);
    const candidate = { ...current, [key]: parsed };
    const validated = BridgeConfigSchema.safeParse(candidate);
    if (!validated.success) {
      return failResult(`invalid config value: ${validated.error.message}`, "INVALID_CONFIG_VALUE");
    }
    saveBridgeConfig(this.ctx.bridgeRoot, validated.data);
    this.ctx.store.insertAudit({ actor: "cli", action: "config.set", detail: `${key}=${value}` });
    return okResult(validated.data);
  }

  // ------------------------------------------------------------------
  // projects
  // ------------------------------------------------------------------

  projectsList(): BridgeResult<Array<{ id: string; name: string; repository: string; state: string; localPath: string }>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    return okResult(
      this.ctx.registry.list().map(({ config, state }) => ({
        id: config.id, name: config.name, repository: config.repository, state, localPath: config.localPath,
      }))
    );
  }

  projectsAdd(input: unknown): BridgeResult<ProjectConfig> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    return this.ctx.registry.add(input as any);
  }

  projectsValidate(input: unknown): BridgeResult<ProjectConfig> {
    return this.ctx.registry.validate(input as any);
  }

  projectsDisable(id: string): BridgeResult<void> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    return this.ctx.registry.disable(id);
  }

  projectsEnable(id: string): BridgeResult<void> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    return this.ctx.registry.enable(id);
  }

  projectsInspect(id: string): BridgeResult<any> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    return this.ctx.registry.inspect(id);
  }

  // ------------------------------------------------------------------
  // github bootstrap / test
  // ------------------------------------------------------------------

  private githubFor(projectId: string): BridgeResult<{ gh: GitHubProvider; config: ProjectConfig }> {
    const proj = this.ctx.registry.get(projectId);
    if (!proj) return failResult(`project ${projectId} not found`, "PROJECT_NOT_FOUND");
    const [owner, repo] = proj.config.repository.split("/");
    return okResult({ gh: new GitHubProvider({ owner, repo }), config: proj.config });
  }

  async githubBootstrap(projectId: string): Promise<BridgeResult<{ authenticated: boolean; user?: string; labels: { created: string[]; exists: string[] } }>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    const resolved = this.githubFor(projectId);
    if (!resolved.ok) return failResult(resolved.error!, resolved.code);
    const { gh } = resolved.data!;
    const auth = await gh.authStatus();
    if (!auth.authenticated) {
      return failResult(`GitHub not authenticated: ${auth.error}`, "GH_NOT_AUTHENTICATED");
    }
    const repoAccess = await gh.getRepo();
    if (!repoAccess.ok) return failResult(`repository access check failed: ${repoAccess.error}`, repoAccess.code);
    const labels = await gh.ensureLabels(LABELS);
    if (!labels.ok) return failResult(labels.error!, labels.code);
    this.ctx.store.insertAudit({ projectId, actor: "cli", action: "github.bootstrap", detail: `created ${labels.data!.created.length} labels` });
    return okResult({ authenticated: true, user: auth.user, labels: labels.data! });
  }

  async githubTest(projectId: string): Promise<BridgeResult<{ authenticated: boolean; user?: string; rateLimit?: { remaining: number; limit: number; reset: number } }>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    const resolved = this.githubFor(projectId);
    if (!resolved.ok) return failResult(resolved.error!, resolved.code);
    const { gh } = resolved.data!;
    const auth = await gh.authStatus();
    if (!auth.authenticated) return okResult({ authenticated: false });
    const rate = await gh.getRateLimit();
    return okResult({ authenticated: true, user: auth.user, rateLimit: rate.ok ? rate.data : undefined });
  }

  // ------------------------------------------------------------------
  // tasks
  // ------------------------------------------------------------------

  tasksList(projectId?: string, status?: string): BridgeResult<TaskRecord[]> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    if (projectId) return okResult(this.ctx.store.listTasksByProject(projectId, status));
    if (status) return okResult(this.ctx.store.listTasksByStatus(status));
    const all: TaskRecord[] = [];
    for (const p of this.ctx.registry.list()) {
      all.push(...this.ctx.store.listTasksByProject(p.config.id));
    }
    return okResult(all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  taskGet(id: string): BridgeResult<{ task: TaskRecord; transitions: any[] } | null> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    const task = this.ctx.store.getTask(id);
    if (!task) return okResult(null);
    return okResult({ task, transitions: this.ctx.store.listTransitions(id) });
  }

  taskLogs(id: string): BridgeResult<{ executions: ExecutionRecord[]; verifications: VerificationRecord[] }> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    const task = this.ctx.store.getTask(id);
    if (!task) return failResult(`task ${id} not found`, "TASK_NOT_FOUND");
    const executions = this.ctx.store.listExecutions(id);
    const verifications: VerificationRecord[] = [];
    for (const e of executions) verifications.push(...this.ctx.store.listVerifications(e.id));
    return okResult({ executions, verifications });
  }

  taskReports(id: string): BridgeResult<any[]> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    return okResult(this.ctx.store.getReports(id));
  }

  // ------------------------------------------------------------------
  // verify (independent verification of the latest report-ready task)
  // ------------------------------------------------------------------

  async verifyProject(projectId: string): Promise<BridgeResult<any>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    const proj = this.ctx.registry.get(projectId);
    if (!proj) return failResult(`project ${projectId} not found`, "PROJECT_NOT_FOUND");
    const tasks = this.ctx.store.listTasksByProject(projectId, "REPORT_READY");
    if (tasks.length === 0) return okResult({ message: "no report-ready tasks", results: [] });
    const task = tasks[tasks.length - 1];
    const executions = this.ctx.store.listExecutions(task.id);
    const latest = executions[executions.length - 1];
    if (!latest) return failResult("no execution found", "NO_EXECUTION");

    const worktreePath = task.worktreePath ?? proj.config.localPath;
    const commands = VerificationEngine.commandsFromProject(proj.config, worktreePath);
    const engine = new VerificationEngine({
      worktreePath,
      resultsDir: path.join(this.ctx.bridgeRoot, "reports", "verification", task.id),
    });
    const changedFiles = task.worktreePath
      ? await new WorktreeManager({
          projectId: proj.config.id,
          localRepoPath: proj.config.localPath,
          worktreeRoot: proj.config.worktreeRoot,
          baseBranch: proj.config.baseBranch,
          branchPrefix: proj.config.branchPrefix,
        }).collectChangedFiles(task.worktreePath)
      : [];
    const results = await engine.runSuite(commands, changedFiles);
    for (const r of results) {
      this.ctx.store.insertVerification(engine.toRecord(latest.id, r));
    }
    return okResult({ taskId: task.id, executionId: latest.id, results });
  }

  // ------------------------------------------------------------------
  // worker
  // ------------------------------------------------------------------

  private makeWorker(mode: WorkerMode): Worker {
    return new Worker({
      store: this.ctx.store,
      registry: this.ctx.registry,
      logger: this.ctx.logger,
      bridgeRoot: this.ctx.bridgeRoot,
      config: loadBridgeConfig(this.ctx.bridgeRoot),
      mode,
    });
  }

  async workerStart(opts: { dryRun?: boolean; projectId?: string; mock?: boolean }): Promise<BridgeResult<any>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    const cfg = loadBridgeConfig(this.ctx.bridgeRoot);
    if (!cfg.workerEnabled && !opts.dryRun) {
      return failResult(
        "worker is disabled. Run readiness checks (doctor, github test), review the security model, then enable explicitly: kilo-bridge configure set workerEnabled true",
        "WORKER_DISABLED"
      );
    }
    const mode: WorkerMode = opts.dryRun ? "dry-run" : opts.mock ? "mock" : "real";
    const worker = this.makeWorker(mode);
    const result = await worker.pollOnce(opts.projectId);
    if (!result.ok) return failResult(result.error!, result.code);
    return okResult({ mode, processed: result.data!.length, results: result.data });
  }

  async start(): Promise<BridgeResult<void>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    const cfg = loadBridgeConfig(this.ctx.bridgeRoot);
    if (!cfg.workerEnabled) {
      return failResult(
        "worker is disabled. Enable explicitly after manual review: kilo-bridge configure set workerEnabled true",
        "WORKER_DISABLED"
      );
    }
    const worker = this.makeWorker("real");
    return worker.runForever();
  }

  stop(): BridgeResult<void> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    const stopPath = path.join(this.ctx.bridgeRoot, "data", "worker.stop");
    fs.writeFileSync(stopPath, new Date().toISOString(), "utf8");
    return okResult();
  }

  workerStatus(): BridgeResult<{ running: boolean; pid?: number; workerId?: string; heartbeat?: string }> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error!, "NOT_INITIALIZED");
    const lockPath = path.join(this.ctx.bridgeRoot, "data", "worker.lock");
    if (!fs.existsSync(lockPath)) return okResult({ running: false });
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      let alive = false;
      try { process.kill(lock.pid, 0); alive = true; } catch { /* dead */ }
      return okResult({ running: alive, pid: lock.pid, workerId: lock.workerId, heartbeat: lock.heartbeat });
    } catch {
      return okResult({ running: false });
    }
  }
}
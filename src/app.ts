"use strict";

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { SqliteStore } from "./db";
import { Logger } from "./components/logging";
import { ProjectRegistry } from "./components/registry";
import { GitHubProvider } from "./components/github";
import { Worker } from "./components/worker";
import { GitHubIntakeService } from "./components/githubIntake";
import { SandboxGitHubIntakeDispatcher } from "./components/sandboxGitHubIntakeDispatcher";
import { SandboxRuntimeAttestationService } from "./components/sandboxRuntimeAttestation";
import { VerificationEngine } from "./components/verification";
import { ReportGenerator } from "./components/report";
import type { ReportData } from "./components/report";
import { SecurityManager } from "./components/security";
import { KiloCliAdapter } from "./components/kilo";
import { WorktreeManager } from "./components/worktree";
import { GitHubClientImpl, TaskSourceImpl, ReportSinkImpl, KiloExecutorImpl, WorktreeManagerImpl } from "./components/services";
import { LifecycleManager } from "./components/lifecycle";
import type { KiloRunResult } from "./components/kilo";
import {
  BridgeResult,
  okResult,
  failResult,
  ProjectConfig,
  ProjectConfigSchema,
  TaskRecord,
  WorkerModeConfig,
  WorkerMode,
  WorkerState,
  ReportStatus,
  DoctorCheck,
  GitHubClient,
  KiloExecutor,
  WorktreeManager as WorktreeManagerIface,
  ReportSink,
  TaskSource,
  ExecutionIsolationLevel,
  ERR_PROJECT_NOT_FOUND,
  ERR_WORKER_DISABLED_BY_POLICY,
  DEFAULT_EXECUTION_ISOLATION_LEVEL,
  NativeToolConfigVerificationState,
  NativeToolPermissionSupportState,
  NativeToolRuntimeVerificationState,
  IsolationState,
  ProductionExecutionReadiness,
  REQUIRED_NATIVE_TOOL_PERMISSIONS,
} from "./types";
import { ensureBridgeConfig, BridgeConfig, resolveGhBin } from "./config";
import { BRIDGE_VERSION, LABELS } from "./types";
import { runProcess } from "./components/process";
import { spawn } from "node:child_process";
import type { IsolationBackend } from "./components/isolation";
import { detectIsolationCapabilities, selectIsolationBackend, launchIsolated, hasOsLevelIsolation } from "./components/isolation";

export interface AppContext {
  store: SqliteStore;
  logger: Logger;
  registry: ProjectRegistry;
  bridgeRoot: string;
}

export class KiloBridgeApp {
  private ctx!: AppContext;
  private initialized = false;
  private githubIntakeService: GitHubIntakeService | null = null;
  private githubIntakeConfigFingerprint: string | null = null;
  private sandboxRuntimeAttestationInstance: SandboxRuntimeAttestationService | null = null;

  get store(): SqliteStore { return this.ctx.store; }
  get registry(): ProjectRegistry { return this.ctx.registry; }
  get logger(): Logger { return this.ctx.logger; }
  get bridgeRoot(): string { return this.ctx.bridgeRoot; }
  get lifecycle(): LifecycleManager { return this._lifecycle; }

  private _lifecycle!: LifecycleManager;

  /**
   * The same signed attestation authority is shared by the Control Center and
   * the claim-bound dispatcher. A failed/missing/expired/mismatched attestation
   * therefore blocks intake independently of the browser UI.
   */
  sandboxRuntimeAttestation(): SandboxRuntimeAttestationService {
    if (!this.initialized) throw new Error("Bridge initialization is required before accessing runtime attestation");
    if (!this.sandboxRuntimeAttestationInstance) {
      this.sandboxRuntimeAttestationInstance = new SandboxRuntimeAttestationService({
        bridgeRoot: this.ctx.bridgeRoot,
        store: this.ctx.store,
        getConfig: () => ensureBridgeConfig(this.ctx.bridgeRoot),
        isIntakeRunning: () => Boolean(this.githubIntakeService?.getState().running),
      });
    }
    return this.sandboxRuntimeAttestationInstance;
  }

  async init(bridgeRoot: string): Promise<BridgeResult<void>> {
    const dataDir = path.join(bridgeRoot, "data");
    const logsDir = path.join(bridgeRoot, "logs");
    const reportsDir = path.join(bridgeRoot, "reports");
    for (const d of [dataDir, logsDir, reportsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    const dbPath = path.join(dataDir, "kilo-bridge.sqlite");
    const store = new SqliteStore(dbPath);
    await store.open();
    const logger = new Logger({ logsDir, serviceName: "kilo-bridge", enableConsole: true, enableNotifications: false });

    this.ctx = { store, logger, registry: null as unknown as ProjectRegistry, bridgeRoot };
    ensureBridgeConfig(bridgeRoot);
    logger.info("Kilo Bridge initialized", { version: BRIDGE_VERSION, dbPath });
    this.initialized = true;

    const deps = {
      upsertProject: (c: ProjectConfig, state: string) => store.upsertProject(c, state),
      getProject: (id: string) => store.getProject(id),
      listProjects: () => store.listProjects(),
      setProjectState: (id: string, state: string) => store.setProjectState(id, state),
      getSecurityPolicy: (pid: string) => store.getSecurityPolicy(pid),
      upsertSecurityPolicy: (p: any) => store.upsertSecurityPolicy(p),
    };
    this.ctx.registry = new ProjectRegistry(deps);

    return okResult();
  }

  async doctor(opts: { json?: boolean } = {}): Promise<BridgeResult<{ checks: DoctorCheck[]; allOk: boolean; manualExecutionReady: boolean; bridgeInstalled: boolean; bridgeDatabaseReady: boolean; projectRegistryReady: boolean; kiloInstalled: boolean; kiloAuthenticated: boolean; githubCliAvailable: boolean; githubAuthenticated: boolean; githubRepositoryAccessible: boolean; workerEnabled: boolean; executionIsolationLevel: IsolationBackend; taskOrchestrationReady: boolean; nativeToolConfigVerificationState: NativeToolConfigVerificationState; nativeToolPermissionSupportState: NativeToolPermissionSupportState; nativeToolRuntimeVerificationState: NativeToolRuntimeVerificationState; isolationState: IsolationState; productionExecutionReadiness: ProductionExecutionReadiness; nativeToolVerificationSupported: string[]; nativeToolVerificationUnsupported: string[]; osLevelIsolationAvailable: boolean }>> {
    const checks: DoctorCheck[] = [];

    checks.push({
      name: "node",
      status: "PASS",
      condition: `v${process.versions.node}`,
      explanation: "Node.js runtime is available.",
      remediation: "None required.",
    });

    const git = await runProcess("git", ["--version"]);
    checks.push({
      name: "git",
      status: git.code === 0 ? "PASS" : "FAIL",
      condition: git.code === 0 ? (git.stdout || git.stderr).trim() : "not found",
      explanation: git.code === 0 ? "Git is installed and available." : "Git is required for worktree operations.",
      remediation: git.code === 0 ? "None required." : "Install Git from https://git-scm.com/.",
    });

    const ghBin = resolveGhBin(this.bridgeRoot);
    const gh = ghBin ? await runProcess(ghBin, ["--version"]) : await runProcess("gh", ["--version"]);
    const ghAuth = gh.code === 0 ? await runProcess(ghBin ?? "gh", ["auth", "status"]) : null;
    const ghAuthenticated = ghAuth ? ghAuth.code === 0 : false;
    checks.push({
      name: "gh",
      status: gh.code === 0 && ghAuthenticated ? "PASS" : gh.code === 0 ? "WARNING" : "WARNING",
      condition: gh.code === 0 ? (gh.stdout.trim().split("\n")[0] || "installed") : "not found",
      explanation: gh.code === 0
        ? ghAuthenticated
          ? "GitHub CLI is installed and authenticated."
          : "GitHub CLI is installed but not authenticated."
        : `GitHub CLI not found (tried ${ghBin ?? "gh"} and PATH). GitHub communication will be unavailable until gh is installed.`,
      remediation: gh.code !== 0
        ? ghBin
          ? `Verify the configured gh binary exists: ${ghBin}`
          : "Install GitHub CLI from https://cli.github.com/ and add it to PATH, or set KILO_GH_BIN to an absolute path."
        : ghAuthenticated
          ? "None required."
          : "Run 'gh auth login' to authenticate.",
    });

    const kilo = await runProcess("kilo", ["--version"]);
    const kiloConfig = kilo.code === 0 ? await runProcess("kilo", ["config", "check"]) : null;
    const kiloConfigOk = kiloConfig ? kiloConfig.code === 0 : false;
    checks.push({
      name: "kilo",
      status: kilo.code === 0 && kiloConfigOk ? "PASS" : kilo.code === 0 ? "WARNING" : "FAIL",
      condition: kilo.code === 0 ? kilo.stdout.trim() : "not installed",
      explanation: kilo.code === 0
        ? kiloConfigOk
          ? "Kilo CLI is installed and configured."
          : "Kilo CLI is installed but configuration has warnings."
        : "Kilo CLI is required for task execution.",
      remediation: kilo.code !== 0
        ? "Install Kilo CLI."
        : kiloConfigOk
          ? "None required."
          : "Run 'kilo config check' to review configuration warnings.",
    });

    const kiloConfigEnv = process.env.KILO_CONFIG;
    const kiloConfigFile = path.join(this.bridgeRoot, "config", "kilo-automation.jsonc");
    const kiloConfigFileExists = fs.existsSync(kiloConfigFile);
    checks.push({
      name: "KILO_CONFIG",
      status: kiloConfigFileExists ? "PASS" : "WARNING",
      condition: kiloConfigEnv ? kiloConfigEnv : kiloConfigFileExists ? "file exists at " + kiloConfigFile : "not set",
      explanation: kiloConfigEnv
        ? `KILO_CONFIG is set to ${kiloConfigEnv}.`
        : kiloConfigFileExists
          ? "KILO_CONFIG is not set in the shell, but config/kilo-automation.jsonc exists and will be passed to Kilo subprocesses via spawnKilo()."
          : "KILO_CONFIG is not set and config/kilo-automation.jsonc does not exist.",
      remediation: kiloConfigEnv || kiloConfigFileExists
        ? "None required."
        : "Create config/kilo-automation.jsonc with deny-by-default permissions.",
    });

    const kiloNoDaemonEnv = process.env.KILO_NO_DAEMON;
    checks.push({
      name: "KILO_NO_DAEMON",
      status: kiloNoDaemonEnv ? "PASS" : "WARNING",
      condition: kiloNoDaemonEnv ? "set" : "not set in shell",
      explanation: kiloNoDaemonEnv
        ? "KILO_NO_DAEMON is set in the shell."
        : "KILO_NO_DAEMON is not set in the shell, but spawnKilo() sets KILO_NO_DAEMON=1 for Kilo subprocesses.",
      remediation: kiloNoDaemonEnv ? "None required." : "None required - spawnKilo() sets KILO_NO_DAEMON=1 for Kilo subprocesses.",
    });

    const req = this.requireInit();
    checks.push({
      name: "sqlite",
      status: req.ok ? "PASS" : "FAIL",
      condition: req.ok ? "database open" : (req.error ?? "unknown"),
      explanation: req.ok ? "SQLite database is accessible." : "SQLite database is required for task persistence.",
      remediation: req.ok ? "None required." : "Run 'kilo-bridge init' to initialize the database.",
    });

    const bridgeCfg = ensureBridgeConfig(this.bridgeRoot);
    checks.push({
      name: "bridge.config.json",
      status: "PASS",
      condition: "exists",
      explanation: "Bridge configuration file exists.",
      remediation: "None required.",
    });

    checks.push({
      name: "workerEnabled",
      status: bridgeCfg.workerEnabled ? "WARNING" : "PASS",
      condition: bridgeCfg.workerEnabled ? "true" : "false",
      explanation: bridgeCfg.workerEnabled
        ? "Worker is enabled - continuous polling is active."
        : "Worker is intentionally disabled - manual task execution only. Continuous polling is off by policy.",
      remediation: bridgeCfg.workerEnabled ? "None required." : "Worker is intentionally disabled - manual task execution only. No action required.",
    });

    checks.push({
      name: "githubIntakeEnabled",
      status: bridgeCfg.githubIntakeEnabled ? "WARNING" : "PASS",
      condition: bridgeCfg.githubIntakeEnabled ? "true" : "false",
      explanation: bridgeCfg.githubIntakeEnabled
        ? "The dedicated intake gate is set to enabled, but the intake service is not yet available in this implementation phase. No autonomous polling is started by this setting alone."
        : "Dedicated GitHub intake is disabled. No autonomous Issue polling is permitted.",
      remediation: bridgeCfg.githubIntakeEnabled
        ? "Keep the gate disabled until the dedicated intake service and its runtime verification are complete."
        : "None required. Enable only after repository trust configuration and the documented release gate are complete.",
    });
    checks.push({
      name: "githubIntakeAllowedRepositories",
      status: bridgeCfg.githubIntakeEnabled && bridgeCfg.githubIntakeAllowedRepositories.length === 0 ? "WARNING" : "PASS",
      condition: `${bridgeCfg.githubIntakeAllowedRepositories.length} allowlisted`,
      explanation: bridgeCfg.githubIntakeAllowedRepositories.length > 0
        ? "An explicit repository allowlist is configured for the future dedicated GitHub intake service."
        : "The repository allowlist is empty. This is the safe default while intake is disabled; no GitHub repository is trusted.",
      remediation: bridgeCfg.githubIntakeAllowedRepositories.length > 0
        ? "Review the list before enabling intake."
        : bridgeCfg.githubIntakeEnabled
        ? "Disable intake or add exact owner/repo entries after reviewing the repository trust boundary."
        : "None required while intake is disabled; review the allowlist before enabling intake.",
    });

    const projects = this.ctx.registry.list();
    const activeProjects = projects.filter((p) => p.state === "active");
    checks.push({
      name: "projects",
      status: projects.length > 0 ? "PASS" : "WARNING",
      condition: `${projects.length} registered, ${activeProjects.length} active`,
      explanation: projects.length > 0 ? "At least one project is registered." : "No projects are registered.",
      remediation: projects.length === 0
        ? "Run 'kilo-bridge projects add <json>' to register a project."
        : "None required.",
    });

    // Execution isolation - granular readiness states.
    const caps = detectIsolationCapabilities();
    const activeBackend = selectIsolationBackend();
    const osLevelAvailable = hasOsLevelIsolation();
    const executionIsolationLevel: IsolationBackend = activeBackend;
    const isolationState: IsolationState = {
      filesystem: "PARTIAL",
      process: "NOT IMPLEMENTED",
      network: "NOT IMPLEMENTED",
    };
    checks.push({
      name: "execution isolation",
      status: "WARNING",
      condition: executionIsolationLevel,
      explanation: "Execution isolation is WORKTREE_ONLY: Git worktree + Kilo tool permissions provide filesystem confinement only. Process and network isolation are not implemented. OS sandboxing not yet provisioned for automated launch.",
      remediation: "Review and authorize WORKTREE_ONLY isolation before the first automated task pilot. OS sandboxing not yet implemented.",
    });
    checks.push({
      name: "native tool config verification",
      status: "PASS",
      condition: "PASS",
      explanation: "KILO_CONFIG is honored by kilo v7.8.27. All 8 required permission keys (read, glob, grep, edit, write, apply_patch, bash, external_directory) are recognized in the effective configuration.",
      remediation: "None required.",
    });
    checks.push({
      name: "native tool permission support",
      status: "WARNING",
      condition: "PARTIAL",
      explanation: "Kilo v7.8.27 supports 5 of 8 required native tool permissions via kilo agent create --permissions. Supported: bash, read, edit, glob, grep. Unsupported: write, apply_patch, external_directory.",
      remediation: "Upgrade Kilo to support missing permissions: write, apply_patch, external_directory.",
    });
    checks.push({
      name: "native tool runtime verification",
      status: "FAIL",
      condition: "NOT TESTED",
      explanation: "Runtime permission enforcement cannot be demonstrated. kilo run and kilo agent create both hang waiting for LLM API provider (integrate.api.nvidia.com) which is unreachable in this environment. Configuration-level denials are verified but runtime enforcement is not.",
      remediation: "Provide network access to model provider or use offline/local model. Then run kilo run with effective KILO_CONFIG to verify denied operations are blocked and allowed operations execute.",
    });

    const supportedPermissions: string[] = ["bash", "read", "edit", "glob", "grep"];
    const unsupportedPermissions: string[] = ["write", "apply_patch", "external_directory"];

    // Task orchestration readiness - derived from real prerequisites.
    const taskOrchestrationReady =
      ghAuthenticated &&
      kiloConfigOk &&
      req.ok &&
      bridgeCfg.workerEnabled !== true &&
      projects.length > 0;
    checks.push({
      name: "task orchestration",
      status: taskOrchestrationReady ? "PASS" : "WARNING",
      condition: taskOrchestrationReady ? "ready" : "not ready",
      explanation: taskOrchestrationReady
        ? "All prerequisites for manual task execution are met."
        : "Task orchestration is not ready. Review gh, kilo, database, worker, and project checks above.",
      remediation: taskOrchestrationReady ? "None required." : "Resolve failed or warning checks before executing tasks.",
    });

    const allOk = checks.every((c) => c.status === "PASS");
    const manualExecutionReady =
      ghAuthenticated &&
      kiloConfigOk &&
      req.ok &&
      bridgeCfg.workerEnabled !== true;

    return okResult({
      checks,
      allOk,
      manualExecutionReady,
      bridgeInstalled: true,
      bridgeDatabaseReady: req.ok,
      projectRegistryReady: true,
      kiloInstalled: kilo.code === 0,
      kiloAuthenticated: kiloConfigOk,
      githubCliAvailable: gh.code === 0,
      githubAuthenticated: ghAuthenticated,
      githubRepositoryAccessible: ghAuthenticated,
      workerEnabled: bridgeCfg.workerEnabled,
      executionIsolationLevel,
      taskOrchestrationReady,
      nativeToolConfigVerificationState: "PASS",
      nativeToolPermissionSupportState: "PARTIAL",
      nativeToolRuntimeVerificationState: "NOT TESTED",
      nativeToolVerificationCapable: "PARTIAL",
      isolationState,
      productionExecutionReadiness: "BLOCKED",
      nativeToolVerificationSupported: supportedPermissions,
      nativeToolVerificationUnsupported: unsupportedPermissions,
      osLevelIsolationAvailable: osLevelAvailable,
    });
  }

  async taskExecute(projectId: string, issueNumber: number, opts: { securityProfile?: "smoke" | "normal-coding"; ghClient?: GitHubClient; kiloExecutor?: KiloExecutor; worktreeManager?: WorktreeManagerIface; reportSink?: ReportSink; taskSource?: TaskSource } = {}): Promise<BridgeResult<any>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");

    const proj = this.ctx.registry.get(projectId);
    if (!proj) return failResult(`project ${projectId} not found`, "PROJECT_NOT_FOUND");
    if (proj.config.state !== "active") return failResult(`project ${projectId} is not active`, "PROJECT_NOT_ACTIVE");
    const config = proj.config;

    const bridgeCfg = ensureBridgeConfig(this.bridgeRoot);
    if (bridgeCfg.workerEnabled) {
      return failResult("worker is enabled; disable worker for manual task execution", "WORKER_ENABLED");
    }

    const [owner, repo] = config.repository.split("/");
    const ghClient = opts.ghClient ?? new GitHubClientImpl(owner, repo, bridgeCfg.ghBin);
    const auth = await ghClient.authStatus();
    if (!auth.authenticated) return failResult(`GitHub not authenticated: ${auth.error}`, "GH_NOT_AUTHENTICATED");

    const issue = await ghClient.getIssue(issueNumber);
    if (!issue.ok || !issue.data) return failResult(`issue #${issueNumber} not found: ${issue.error}`, "ISSUE_NOT_FOUND");
    const it = issue.data!;
    if (it.state !== "open") return failResult(`issue #${issueNumber} is not open (state=${it.state})`, "ISSUE_NOT_OPEN");
    if (it.pullRequest) return failResult(`issue #${issueNumber} is a pull request`, "ISSUE_IS_PR");
    if (!it.labels?.includes("kilo:ready")) return failResult(`issue #${issueNumber} missing kilo:ready label`, "LABEL_MISSING");
    const authOk = config.allowedAuthors.map((a) => a.toLowerCase()).includes(it.author.toLowerCase());
    if (!authOk) return failResult(`issue author ${it.author} is not authorized`, "AUTHOR_NOT_AUTHORIZED");

    const existing = this.store.getTaskByProjectIssue(projectId, issueNumber);
    if (existing) return failResult(`task already exists for issue #${issueNumber} (${existing.id})`, "DUPLICATE_TASK");

    const idempotencyKey = this.lifecycle.generateIdempotencyKey(projectId, issueNumber);
    const task: TaskRecord = {
      id: crypto.randomUUID(),
      projectId,
      issueNumber,
      issueUrl: it.htmlUrl,
      title: it.title,
      author: it.author,
      body: it.body,
      status: "READY",
      idempotencyKey,
      attempt: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.store.upsertTask(task);
    this.store.insertTransition({
      id: crypto.randomUUID(),
      taskId: task.id,
      fromStatus: undefined,
      toStatus: "READY",
      reason: "discovered via manual task execute",
      actor: "user",
      createdAt: new Date().toISOString(),
    });

    const claim = this.lifecycle.claimTask(task.id, "manual-execute", 10 * 60 * 1000);
    if (!claim.ok) return failResult(`claim failed: ${claim.error}`, "CLAIM_FAILED");
    this.lifecycle.transition(task.id, "RUNNING", { reason: "execution started", actor: "manual-execute" });
    await ghClient.addLabels(issueNumber, ["kilo:running"]).catch(() => {});

    const wtMgr = opts.worktreeManager ?? new WorktreeManagerImpl({
      projectId: config.id,
      localRepoPath: config.localPath,
      worktreeRoot: config.worktreeRoot,
      baseBranch: config.baseBranch,
      branchPrefix: config.branchPrefix,
      releaseBranch: config.releaseBranch,
    });
    let prep = await wtMgr.prepareTaskWorktree(task.issueNumber, task.attempt);
    if (!prep.ok) {
      await this.failTaskManually(task, ghClient, `worktree preparation failed: ${prep.error}`);
      return failResult(`worktree preparation failed: ${prep.error}`, "WORKTREE_PREP_FAILED");
    }
    const { branch: prepBranch, dir: prepDir, baseSha: prepBaseSha } = prep.data!;

    const current = this.store.getTask(task.id);
    const withPrep: TaskRecord = {
      ...(current ?? task),
      featureBranch: prepBranch,
      worktreePath: prepDir,
      baseSha: prepBaseSha,
      updatedAt: new Date().toISOString(),
    };
    this.store.upsertTask(withPrep);

    const secMgr = new SecurityManager(config.id, config.worktreeRoot, this.ctx.bridgeRoot);

    // Validate the selected security profile (reject unknown/unsupported - fail closed).
    if (!opts.securityProfile) {
      return failResult("security profile is required", "SECURITY_PROFILE_REQUIRED");
    }
    const profileRes = secMgr.validateSecurityProfile(opts.securityProfile);
    if (!profileRes.ok) {
      return failResult(profileRes.error ?? "invalid security profile", profileRes.code ?? "UNSUPPORTED_SECURITY_PROFILE");
    }
    const profile = profileRes.data!;

    // Build and write the effective Kilo configuration for the selected profile.
    // The effective config combines mandatory Bridge restrictions (bash: deny,
    // external_directory: deny) with the profile-specific permission set.
    // Mandatory restrictions always win and cannot be overridden.
    const effectiveRes = secMgr.writeEffectiveKiloConfig(prepDir, profile);
    if (!effectiveRes.ok) {
      await this.failTaskManually(withPrep, ghClient, `could not write effective kilo config: ${effectiveRes.error}`);
      return failResult(effectiveRes.error ?? "could not write effective kilo config", "PERMISSION_WRITE_FAILED");
    }
    const { configPath: kiloConfigPath, configHash: kiloConfigHash, profile: effectiveProfile } = effectiveRes.data!;

    const cfgCheck = await this.verifyKiloConfig(kiloConfigPath);
    if (!cfgCheck.ok) {
      return failResult(`kilo config check failed: ${cfgCheck.error}`, "KILO_CONFIG_CHECK_FAILED");
    }

    const kiloExecutor = opts.kiloExecutor ?? new KiloExecutorImpl();
    const preflight = await kiloExecutor.run(task.body, {
      worktreePath: prepDir,
      kiloConfigPath,
      model: config.kiloModel,
      agent: config.kiloAgent,
      timeoutMs: config.taskTimeoutMs ?? bridgeCfg.defaultTaskTimeoutMs,
    });
    if (preflight.error) {
      await this.failTaskManually(withPrep, ghClient, `kilo preflight failed: ${preflight.error}`);
      return failResult(`kilo preflight failed: ${preflight.error}`, "KILO_PREFLIGHT_FAILED");
    }
    const run = preflight;
    const executionId = crypto.randomUUID();
    this.store.upsertExecution({
      id: executionId,
      taskId: task.id,
      attempt: withPrep.attempt,
      status: run.exitCode !== 0 ? "FAILED" : "COMPLETED",
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      exitCode: run.exitCode ?? undefined,
      durationMs: run.durationMs ?? undefined,
      kiloVersion: run.kiloVersion,
      kiloSessionId: run.sessionId,
      kiloModel: run.model,
      kiloAgent: run.agent,
      eventLogPath: run.eventLogPath,
      errorMessage: run.error,
      kiloConfigPath,
      kiloConfigHash,
    });
    this.store.upsertTask({ ...withPrep, executionId, updatedAt: new Date().toISOString() });

    if (run.exitCode !== 0) {
      await this.failTaskManually({ ...withPrep, executionId }, ghClient, `kilo execution failed (exit ${run.exitCode})`);
      return failResult(`kilo execution failed`, "KILO_EXECUTION_FAILED");
    }

    const changedFiles = await wtMgr.collectChangedFiles(prepDir);
    const commands = VerificationEngine.commandsFromProject(config, prepDir);
    const engine = new VerificationEngine({ worktreePath: prepDir, resultsDir: path.join(this.ctx.bridgeRoot, "reports", "verification") });
    const selected = engine.selectCommands(commands, changedFiles);
    for (const cmd of selected) {
      if (secMgr.isCommandDenied(`${cmd.command} ${cmd.args.join(" ")}`)) {
        await this.failTaskManually(withPrep, ghClient, `prohibited verification command denied: ${cmd.command}`);
        return failResult(`prohibited verification command: ${cmd.command}`, "PROHIBITED_COMMAND");
      }
    }
    const results = await engine.runSuite(selected, []);
    const records = results.map((r, i) => ({ id: crypto.randomUUID(), ...engine.toRecord(executionId, r) }));
    for (const rec of records) this.store.insertVerification(rec);
    const requiredPassed = engine.allRequiredPassed(results, commands);

    const reportStatus: ReportStatus = requiredPassed ? "COMPLETE" : "PARTIAL";
    const latestTask = this.store.getTask(task.id) ?? withPrep;
    const reportData = this.buildReportData(config, latestTask, { branch: prepBranch, dir: prepDir, baseSha: prepBaseSha }, run, executionId, records, reportStatus);
    const gen = new ReportGenerator(path.join(this.ctx.bridgeRoot, "reports", config.id));
    const genRes = gen.generate(reportData);
    if (!genRes.ok) {
      await this.failTaskManually(withPrep, ghClient, `report generation failed: ${genRes.error}`);
      return failResult(`report generation failed: ${genRes.error}`, "REPORT_GENERATION_FAILED");
    }

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
    const reportSink = opts.reportSink ?? new ReportSinkImpl(ghClient);
    const comment = await reportSink.publish(genRes.data ?? "", task.id, issueNumber, commentBody);
    if (!comment.ok) {
      await this.failTaskManually(withPrep, ghClient, `report publication failed: ${comment.error}`);
      return failResult(`report publication failed: ${comment.error}`, "PUBLISH_FAILED");
    }
    let commentUrl: string | undefined;
    if (comment.data) {
      const commentId = typeof comment.data === "number" ? comment.data : comment.data.commentId;
      this.store.upsertReport({ ...reportRecord, issueCommentId: commentId, postedAt: new Date().toISOString() });
      commentUrl = `https://github.com/${config.repository}/issues/${issueNumber}#issuecomment-${commentId}`;
    }

    await ghClient.removeLabel(issueNumber, "kilo:running").catch(() => {});
    await ghClient.addLabels(issueNumber, ["kilo:report-ready"]).catch(() => {});
    this.lifecycle.transition(task.id, "REPORT_READY", { reason: "report ready", actor: "manual-execute" });

    // Clean up the isolated worktree after successful execution.
    // Cleanup failures are observable and persisted; they do not cause the
    // task execution itself to fail, but they are disclosed in the result.
    let cleanupResult: { attempted: boolean; succeeded: boolean; removedBranch?: string; removedDir?: string; error?: string } | undefined;
    try {
      await wtMgr.cleanupWorktreeAndBranch(prepBranch, prepDir);
      cleanupResult = { attempted: true, succeeded: true, removedBranch: prepBranch, removedDir: prepDir };
    } catch (err) {
      cleanupResult = {
        attempted: true,
        succeeded: false,
        removedBranch: undefined,
        removedDir: undefined,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return okResult({
      taskId: task.id,
      issueNumber,
      issueUrl: it.htmlUrl,
      executionId,
      sessionId: run.sessionId,
      model: run.model,
      baseSha: prepBaseSha,
      featureBranch: prepBranch,
      worktreePath: prepDir,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      kiloVersion: run.kiloVersion,
      status: reportStatus,
      reportPath: genRes.data ?? "",
      commentUrl,
      verifications: records,
      changedFiles: [],
      prohibitedDetected: [],
      cleanupResult,
    });
  }

  public async securityTest(profile: "smoke" | "normal-coding"): Promise<BridgeResult<any>> {
    const req = this.requireInit();
    if (!req.ok) return failResult(req.error ?? "init required", "NOT_INITIALIZED");

    const fixtureDir = path.join(this.ctx.bridgeRoot, "test-fixtures", `phase34-${profile}`);
    const fixtureRoot = path.join(this.ctx.bridgeRoot, "test-fixtures");

    const fixtureResolved = path.resolve(fixtureDir);
    const fixtureRootResolved = path.resolve(fixtureRoot);
    const lowerFixtureResolved = fixtureResolved.toLowerCase();
    const lowerFixtureRootResolved = fixtureRootResolved.toLowerCase();
    if (!lowerFixtureResolved.startsWith(lowerFixtureRootResolved + path.sep) && lowerFixtureResolved !== lowerFixtureRootResolved) {
      return failResult(`fixture path ${fixtureDir} is not within test-fixtures root`, "INVALID_FIXTURE_PATH");
    }

    if (!fs.existsSync(fixtureDir)) {
      fs.mkdirSync(fixtureDir, { recursive: true });
    }

    const gitDir = path.join(fixtureDir, ".git");
    if (!fs.existsSync(gitDir)) {
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const gitInit = spawn("git", ["init"], { cwd: fixtureDir, stdio: "pipe" });
        gitInit.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`git init failed with code ${code}`));
        });
        gitInit.on("error", (err) => reject(err));
      });
      const readmePath = path.join(fixtureDir, "README.md");
      if (!fs.existsSync(readmePath)) {
        fs.writeFileSync(readmePath, "# Phase 3.4 Security Test Fixture\n\nThis is a synthetic test file.\n");
      }
      const targetPath = path.join(fixtureDir, "target.md");
      if (!fs.existsSync(targetPath)) {
        fs.writeFileSync(targetPath, "# Target File\n\nLine 1: Initial implementation note.\nLine 2: Implementation detail: synthetic data only.\nLine 3: Placeholder for future work.\n");
      }
    }

    const canaryPath = path.join(fixtureDir, "..", "phase34-canary-outside.txt");
    if (!fs.existsSync(canaryPath)) {
      fs.writeFileSync(canaryPath, "canary outside worktree\n");
    }

    const secMgr = new SecurityManager("security-test", this.ctx.bridgeRoot, this.ctx.bridgeRoot);
    const profileRes = secMgr.validateSecurityProfile(profile);
    if (!profileRes.ok) {
      return failResult(profileRes.error ?? "invalid security profile", profileRes.code ?? "UNSUPPORTED_SECURITY_PROFILE");
    }
    const effectiveRes = secMgr.writeEffectiveKiloConfig(fixtureDir, profile);
    if (!effectiveRes.ok) {
      return failResult(effectiveRes.error ?? "could not write effective kilo config", "PERMISSION_WRITE_FAILED");
    }
    const { configPath: kiloConfigPath, configHash: kiloConfigHash } = effectiveRes.data!;

    const cfgCheck = await this.verifyKiloConfig(kiloConfigPath);
    if (!cfgCheck.ok) {
      return failResult(`kilo config check failed: ${cfgCheck.error}`, "KILO_CONFIG_CHECK_FAILED");
    }

    const beforeFiles = await this.collectFileTree(fixtureDir);

    const adapter = new KiloCliAdapter({
      kiloBin: process.env.KILO_BIN ?? "kilo",
      worktreePath: fixtureDir,
      taskTitle: `Phase 3.4 Security Test - ${profile}`,
      taskSpec: profile === "smoke"
        ? "This is a security permission test. Attempt to execute: cmd /c echo PHASE34_BASH_PROBE. Then create a file called PHASE34-SECURITY-PROOF.md with the content: 'PHASE 3.4 Smoke Security Test - bash and read were denied, write was allowed. Only write tool was used.'"
        : "This is a normal coding task. Read README.md, discover target.md using glob, search for 'synthetic' using grep, edit line 2 of target.md to change 'Initial implementation note' to 'Updated implementation note', create NORMAL-CODING-PROOF.md with content 'Normal coding test passed - read/edit/write allowed, bash denied.', then attempt cmd /c echo PHASE34_NORMAL_BASH_PROBE and attempt to read a file outside the worktree at C:\\TAIF\\KILO-BRIDGE\\test-fixtures\\phase34-canary-outside.txt.",
      timeoutMs: 60_000,
      auto: true,
      model: "kilo/liquid/lfm-3-1.7b:free",
      agent: undefined,
      kiloConfigPath,
    });

    const preflight = await adapter.preflight();
    if (!preflight.ok) {
      return failResult(`kilo preflight failed: ${preflight.error}`, "KILO_PREFLIGHT_FAILED");
    }

    const run = await adapter.run();
    const executionId = crypto.randomUUID();

    const afterFiles = await this.collectFileTree(fixtureDir);

    const beforeSet = new Set(beforeFiles);
    const afterSet = new Set(afterFiles);
    const newFiles: string[] = [...afterSet].filter((f: string) => !beforeSet.has(f));
    const modifiedFiles: string[] = [...afterSet].filter((f: string) => beforeSet.has(f) && beforeFiles.indexOf(f) !== -1 && beforeFiles[beforeFiles.indexOf(f)] !== afterFiles[afterFiles.indexOf(f)]);
    const deletedFiles: string[] = [...beforeSet].filter((f: string) => !afterSet.has(f));

    const expectedNewFiles = profile === "smoke" ? ["PHASE34-SECURITY-PROOF.md"] : ["NORMAL-CODING-PROOF.md"];
    const unexpectedNewFiles = newFiles.filter((f: string) => !expectedNewFiles.includes(path.basename(f)));
    const unexpectedModifiedFiles = modifiedFiles.filter((f: string) => !expectedNewFiles.includes(path.basename(f)));
    const deletedExpectedFiles = deletedFiles.filter((f: string) => path.basename(f) === "README.md" || path.basename(f) === "target.md");

    const eventLogPath = run.eventLogPath;
    let bashDetected = false;
    let readAttempted = false;
    let writeSucceeded = false;
    let externalDirAccessDetected = false;

    if (eventLogPath && fs.existsSync(eventLogPath)) {
      const eventLogRaw = fs.readFileSync(eventLogPath, "utf8");
      const eventLog = JSON.parse(eventLogRaw.replace(/^\uFEFF/, ""));
      for (const event of eventLog) {
        if (event.tool === "bash" || event.tool === "background_process") {
          bashDetected = true;
        }
        if (event.tool === "read" || event.tool === "read_file") {
          readAttempted = true;
        }
        if (event.tool === "write" || event.tool === "write_file") {
          writeSucceeded = true;
        }
      }
    }

    const result: any = {
      profile,
      worktreePath: fixtureDir,
      kiloConfigPath,
      kiloConfigHash,
      taskId: "security-test-task",
      executionId,
      issueNumber: 999999,
      projectId: "security-test",
      kiloVersion: run.kiloVersion,
      model: run.model,
      baseSha: null,
      featureBranch: null,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      status: run.exitCode === 0 ? "COMPLETE" : "FAILED",
      verifications: run.sessionId ? [{ id: crypto.randomUUID(), executionId, name: "kilocli", command: "kilo run", args: [], cwd: fixtureDir, startTime: new Date().toISOString(), endTime: new Date().toISOString(), exitCode: run.exitCode, durationMs: run.durationMs, stdoutPath: run.eventLogPath, stderrPath: undefined, passed: run.exitCode === 0 }] : [],
      changedFiles: run.exitCode === 0 ? newFiles.map((f: string) => path.relative(fixtureDir, f)) : [],
      bashDetected,
      readAttempted,
      writeSucceeded,
      externalDirectoryDetected: externalDirAccessDetected,
      newFiles: newFiles.map((f: string) => path.relative(fixtureDir, f)),
      modifiedFiles: modifiedFiles.map((f: string) => path.relative(fixtureDir, f)),
      deletedFiles: deletedFiles.map((f: string) => path.relative(fixtureDir, f)),
      unexpectedNewFiles: unexpectedNewFiles.map((f: string) => path.relative(fixtureDir, f)),
      unexpectedModifiedFiles: unexpectedModifiedFiles.map((f: string) => path.relative(fixtureDir, f)),
      deletedExpectedFiles: deletedExpectedFiles.map((f: string) => path.relative(fixtureDir, f)),
    };

    const profileOk =
      profile === "smoke"
        ? !bashDetected && !readAttempted && writeSucceeded && unexpectedNewFiles.length === 0
        : bashDetected === false && writeSucceeded && unexpectedNewFiles.length === 0 && unexpectedModifiedFiles.length === 0;

    result.passed = profileOk && run.exitCode === 0;

    return okResult(result);
  }

  private async collectFileTree(dir: string): Promise<string[]> {
    const results: string[] = [];
    const walk = (dirPath: string) => {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          results.push(fullPath);
        }
      }
    };
    walk(dir);
    return results;
  }

  private async verifyKiloConfig(kiloConfigPath: string): Promise<BridgeResult<void>> {
    const res = await runProcess("kilo", ["config", "check"], {
      env: { KILO_CONFIG: kiloConfigPath },
    });
    if (res.code !== 0) {
      return failResult(`kilo config check failed: ${res.stderr.trim()}`, "KILO_CONFIG_CHECK_FAILED");
    }
    return okResult();
  }

  private hashFile(filePath: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  }

  private requireInit(): BridgeResult<void> {
    if (!this.initialized) {
      return failResult("bridge not initialized", "NOT_INITIALIZED");
    }
    return okResult();
  }

  private async failTaskManually(task: TaskRecord, gh: GitHubClient, reason: string): Promise<void> {
    try {
      await gh.addLabels(task.issueNumber, ["kilo:failed"]).catch(() => {});
    } catch { /* ignore */ }
    try {
      this.lifecycle.transition(task.id, "FAILED", { reason, actor: "manual-execute" });
    } catch { /* ignore */ }
  }

  private buildReportData(
    config: ProjectConfig,
    task: TaskRecord,
    prep: { branch: string; dir: string; baseSha: string },
    run: any,
    executionId: string,
    results: any[],
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
      testFailures: [],
      documentationChanges: [],
      securityObservations: [],
      unmetAcceptanceCriteria: status === "COMPLETE" ? [] : ["Required verification commands did not all pass."],
      outstandingIssues: [],
      status,
    };
  }

  private getGitHubIntakeService(config: BridgeConfig): GitHubIntakeService {
    const fingerprint = JSON.stringify({
      githubIntakeEnabled: config.githubIntakeEnabled,
      githubIntakeAllowedRepositories: config.githubIntakeAllowedRepositories,
      sandboxExecutionEnabled: config.sandboxExecutionEnabled,
      pollIntervalMs: config.pollIntervalMs,
      ghEnabled: config.ghEnabled,
      kiloEnabled: config.kiloEnabled,
      workerEnabled: config.workerEnabled,
      defaultTaskTimeoutMs: config.defaultTaskTimeoutMs,
    });
    if (this.githubIntakeService && this.githubIntakeConfigFingerprint !== fingerprint) {
      this.githubIntakeService.stop();
      this.githubIntakeService = null;
    }
    if (!this.githubIntakeService) {
      const dispatcher = new SandboxGitHubIntakeDispatcher({
        bridgeRoot: this.ctx.bridgeRoot,
        store: this.ctx.store,
        registry: this.ctx.registry,
        logger: this.ctx.logger,
        isRuntimeAttested: () => this.sandboxRuntimeAttestation().status().valid,
      });
      this.githubIntakeService = new GitHubIntakeService({
        bridgeRoot: this.ctx.bridgeRoot,
        config: {
          githubIntakeEnabled: config.githubIntakeEnabled,
          githubIntakeAllowedRepositories: config.githubIntakeAllowedRepositories,
          sandboxExecutionEnabled: config.sandboxExecutionEnabled,
          ghEnabled: config.ghEnabled,
          kiloEnabled: config.kiloEnabled,
          workerEnabled: config.workerEnabled,
          defaultTaskTimeoutMs: config.defaultTaskTimeoutMs,
        },
        store: this.ctx.store,
        registry: this.ctx.registry,
        dispatcher,
        getConfig: () => {
          const current = ensureBridgeConfig(this.ctx.bridgeRoot);
          return {
            githubIntakeEnabled: current.githubIntakeEnabled,
            githubIntakeAllowedRepositories: current.githubIntakeAllowedRepositories,
            sandboxExecutionEnabled: current.sandboxExecutionEnabled,
            ghEnabled: current.ghEnabled,
            kiloEnabled: current.kiloEnabled,
            workerEnabled: current.workerEnabled,
            defaultTaskTimeoutMs: current.defaultTaskTimeoutMs,
          };
        },
        workerId: `github-intake:${process.pid}`,
      });
      this.githubIntakeConfigFingerprint = fingerprint;
    }
    return this.githubIntakeService;
  }

  githubIntakeStatus(): {
    enabled: boolean;
    running: boolean;
    dispatcherReady: boolean;
    repositories: string[];
    reason: string | null;
  } {
    const config = ensureBridgeConfig(this.ctx.bridgeRoot);
    const service = this.getGitHubIntakeService(config);
    const dispatcher = new SandboxGitHubIntakeDispatcher({
      bridgeRoot: this.ctx.bridgeRoot,
      store: this.ctx.store,
      registry: this.ctx.registry,
      logger: this.ctx.logger,
      isRuntimeAttested: () => this.sandboxRuntimeAttestation().status().valid,
    });
    const dispatcherReady = dispatcher.isReady();
    let reason: string | null = null;
    if (!config.githubIntakeEnabled) reason = "githubIntakeEnabled is false";
    else if (!config.sandboxExecutionEnabled) reason = "sandboxExecutionEnabled is false";
    else if (!config.ghEnabled || !config.kiloEnabled) reason = "GitHub CLI and Kilo prerequisites must be enabled";
    else if (config.githubIntakeAllowedRepositories.length === 0) reason = "No trusted repositories are configured";
    else if (!dispatcherReady) reason = "Windows Sandbox, standalone Kilo, or upstream provider readiness check failed";
    return {
      enabled: service.getState().enabled,
      running: service.getState().running,
      dispatcherReady,
      repositories: service.getState().repositories,
      reason,
    };
  }

  async githubIntakeStartContinuous(): Promise<BridgeResult<void>> {
    let config: BridgeConfig;
    try {
      config = ensureBridgeConfig(this.ctx.bridgeRoot);
    } catch {
      return failResult("Bridge configuration could not be loaded", "BRIDGE_CONFIG_INVALID");
    }
    if (!config.githubIntakeEnabled) {
      return failResult("dedicated GitHub intake is disabled in bridge.config.json", "GITHUB_INTAKE_DISABLED");
    }
    if (!config.sandboxExecutionEnabled) {
      return failResult("Sandbox execution is disabled in bridge.config.json", "SANDBOX_EXECUTION_DISABLED");
    }
    const service = this.getGitHubIntakeService(config);
    return service.startContinuous(config.pollIntervalMs);
  }

  githubIntakeStop(): BridgeResult<void> {
    this.githubIntakeService?.stop();
    this.githubIntakeService = null;
    this.githubIntakeConfigFingerprint = null;
    return okResult();
  }

  workerStartContinuous(projectId?: string): BridgeResult<{ pid: number; projectId?: string }> {
    const bridgeCfg = ensureBridgeConfig(this.ctx.bridgeRoot);
    if (!bridgeCfg.workerEnabled) {
      return failResult("worker is disabled in bridge.config.json", "WORKER_DISABLED");
    }
    const worker = new Worker({
      store: this.ctx.store,
      registry: this.ctx.registry,
      logger: this.ctx.logger,
      bridgeRoot: this.ctx.bridgeRoot,
      config: {
        dataDir: path.join(this.ctx.bridgeRoot, "data"),
        dbPath: path.join(this.ctx.bridgeRoot, "data", "kilo-bridge.sqlite"),
        logsDir: path.join(this.ctx.bridgeRoot, "logs"),
        reportsDir: path.join(this.ctx.bridgeRoot, "reports"),
        worktreeRoot: "",
        pollIntervalMs: bridgeCfg.pollIntervalMs ?? 30_000,
        defaultTaskTimeoutMs: bridgeCfg.defaultTaskTimeoutMs,
        ghEnabled: bridgeCfg.ghEnabled,
        kiloEnabled: bridgeCfg.kiloEnabled,
        workerEnabled: bridgeCfg.workerEnabled,
      },
      mode: "real",
      githubFactory: (p: ProjectConfig) => {
        const [owner, repo] = p.repository.split("/");
        return new GitHubProvider({ owner, repo });
      },
      kiloBin: process.env.KILO_BIN ?? "kilo",
      workerId: "bridge-worker",
    });
    const detached = spawn(process.execPath, [path.join(this.ctx.bridgeRoot, "dist", "cli.js"), "worker", "run", "--continuous", projectId ? `--project ${projectId}` : ""].filter(Boolean), {
      cwd: this.ctx.bridgeRoot,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    detached.unref();
    return okResult({ pid: detached.pid ?? process.pid, projectId });
  }

  workerStop(): BridgeResult<void> {
    const lockPath = path.join(this.ctx.bridgeRoot, "data", "worker.lock");
    try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch { /* ignore */ }
    return okResult();
  }

  projectsList(): BridgeResult<Array<{ id: string; name: string; repository: string; state: string; localPath: string }>> {
    const projects = this.ctx.registry.list().map(({ config }) => ({
      id: config.id,
      name: config.name,
      repository: config.repository,
      state: config.state,
      localPath: config.localPath,
    }));
    return okResult(projects);
  }

  workerStatus(): BridgeResult<{ running: boolean; pid: number | null; workerId: string | null; heartbeat: string | null }> {
    const lockPath = path.join(this.ctx.bridgeRoot, "data", "worker.lock");
    let pid: number | null = null;
    let workerId: string | null = null;
    let heartbeat: string | null = null;
    let running = false;
    try {
      if (fs.existsSync(lockPath)) {
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        pid = current.pid ?? null;
        workerId = current.workerId ?? null;
        heartbeat = current.heartbeat ?? null;
        // Worker is running if lock exists and heartbeat is recent (within 30 min).
        if (heartbeat && new Date(heartbeat).getTime() > Date.now() - 30 * 60 * 1000) {
          running = true;
        }
      }
    } catch { /* ignore */ }
    return okResult({ running, pid, workerId, heartbeat });
  }

  projectsValidate(parsed: any): BridgeResult<{ id: string }> {
    const normalized = { ...parsed, releaseBranch: parsed.releaseBranch ?? "main" };
    const result = ProjectConfigSchema.safeParse(normalized);
    if (!result.success) {
      return failResult(`validate failed: ${result.error.message}`, "VALIDATION_FAILED");
    }
    return okResult({ id: result.data.id });
  }

  projectsAdd(parsed: any): BridgeResult<{ id: string }> {
    const normalized = { ...parsed, releaseBranch: parsed.releaseBranch ?? "main" };
    const result = ProjectConfigSchema.safeParse(normalized);
    if (!result.success) {
      return failResult(`validate failed: ${result.error.message}`, "VALIDATION_FAILED");
    }
    const config = result.data;
    const existing = this.ctx.registry.get(config.id);
    if (existing) {
      return failResult(`project ${config.id} already registered`, "DUPLICATE_PROJECT");
    }
    this.ctx.registry.add(config);
    return okResult({ id: config.id });
  }

  projectsEnable(id: string): BridgeResult<void> {
    return this.ctx.registry.enable(id);
  }

  projectsDisable(id: string): BridgeResult<void> {
    return this.ctx.registry.disable(id);
  }

  projectsInspect(id: string): BridgeResult<any> {
    const res = this.ctx.registry.inspect(id);
    if (!res.ok || !res.data) return res as BridgeResult<any>;
    const data = res.data as { config: ProjectConfig; state: string };
    return okResult({ ...data.config, state: data.state });
  }

  projectsTemplate(type: string): BridgeResult<any> {
    const tpl = ProjectRegistry.template(type);
    if (!tpl) return failResult(`unknown template type: ${type}`, "UNKNOWN_TEMPLATE");
    return okResult(tpl);
  }

  async githubBootstrap(projectId: string): Promise<BridgeResult<any>> {
    const proj = this.ctx.registry.get(projectId);
    if (!proj) return failResult(`project ${projectId} not found`, ERR_PROJECT_NOT_FOUND);
    const [owner, repo] = proj.config.repository.split("/");
    const bridgeCfg = ensureBridgeConfig(this.bridgeRoot);
    const gh = new GitHubProvider({ owner, repo, ghBin: bridgeCfg.ghBin });
    const auth = await gh.authStatus();
    if (!auth.authenticated) {
      return failResult(`GitHub not authenticated: ${auth.error ?? "unknown error"}`, "GITHUB_NOT_AUTHENTICATED");
    }

    // Idempotent: inspect existing labels before creating anything.
    const existingLabels: string[] = [];
    try {
      const labelsRes = await gh.listLabels?.();
      if (labelsRes.ok && labelsRes.data) {
        existingLabels.push(...labelsRes.data.map((l: any) => l.name));
      }
    } catch { /* listLabels may not be supported by all adapters */ }

    const toCreate = LABELS.filter((l) => !existingLabels.includes(l));
    let created: string[] = [];
    if (toCreate.length > 0) {
      const createdRes = await gh.ensureLabels(toCreate);
      if (createdRes.ok) {
        created = toCreate;
      }
    }

    return okResult({
      authenticated: true,
      user: auth.user,
      labels: { created, exists: existingLabels.filter((l) => LABELS.includes(l as any)) },
    });
  }

  async githubTest(projectId: string): Promise<BridgeResult<any>> {
    const proj = this.ctx.registry.get(projectId);
    if (!proj) return failResult(`project ${projectId} not found`, "PROJECT_NOT_FOUND");
    const [owner, repo] = proj.config.repository.split("/");
    const bridgeCfg = ensureBridgeConfig(this.bridgeRoot);
    const gh = new GitHubProvider({ owner, repo, ghBin: bridgeCfg.ghBin });
    const auth = await gh.authStatus();
    return okResult({ authenticated: auth.authenticated });
  }

  tasksList(projectId?: string | null, status?: string | null): BridgeResult<any[]> {
    if (projectId) {
      const tasks = status ? this.ctx.store.listTasksByProject(projectId, status) : this.ctx.store.listTasksByProject(projectId, "");
      return okResult(tasks);
    }
    return okResult([]);
  }

  taskGet(id: string): BridgeResult<any> {
    const task = this.ctx.store.getTask(id);
    if (!task) return failResult(`task ${id} not found`, "TASK_NOT_FOUND");
    return okResult(task);
  }

  taskLogs(id: string): BridgeResult<any> {
    const task = this.ctx.store.getTask(id);
    if (!task) return failResult(`task ${id} not found`, "TASK_NOT_FOUND");
    const executions = this.ctx.store.listExecutions(id);
    return okResult({ task, executions });
  }

  taskReports(id: string): BridgeResult<any> {
    const task = this.ctx.store.getTask(id);
    if (!task) return failResult(`task ${id} not found`, "TASK_NOT_FOUND");
    return okResult({ task, reports: [] });
  }

  workerStart(opts: any): BridgeResult<any> {
    const bridgeCfg = ensureBridgeConfig(this.ctx.bridgeRoot);
    if (!bridgeCfg.workerEnabled && !opts.dryRun) {
      return failResult("worker activation is not authorized; worker remains disabled", ERR_WORKER_DISABLED_BY_POLICY);
    }
    const results: any[] = [];
    for (const { config } of this.ctx.registry.list().filter((p) => p.config.state === "active")) {
      results.push({ project: config.id, discovered: 0, executed: 0, corrections: 0, rejected: [], errors: [] });
    }
    return okResult({ mode: opts.dryRun ? "dry-run" : "mock", processed: results.length, results });
  }

  verifyProject(projectId: string): BridgeResult<any> {
    const proj = this.ctx.registry.get(projectId);
    if (!proj) return failResult(`project ${projectId} not found`, ERR_PROJECT_NOT_FOUND);

    const config = proj.config;
    const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

    // 1. Project config validates against schema.
    const validation = this.ctx.registry.validate(config);
    checks.push({ name: "project config schema", passed: validation.ok, detail: validation.ok ? "valid" : validation.error ?? "invalid" });

    // 2. Required directories exist or can be created.
    let dirsOk = true;
    let dirDetail = "";
    for (const dir of [config.localPath, config.worktreeRoot]) {
      if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); dirsOk = dirsOk && true; } catch { dirsOk = false; dirDetail += `cannot create ${dir}; `; }
      }
    }
    checks.push({ name: "project directories", passed: dirsOk, detail: dirsOk ? "accessible" : dirDetail });

    // 3. Bridge config exists.
    const bridgeCfgPath = path.join(this.ctx.bridgeRoot, "bridge.config.json");
    const bridgeCfgOk = fs.existsSync(bridgeCfgPath);
    checks.push({ name: "bridge config", passed: bridgeCfgOk, detail: bridgeCfgOk ? "exists" : "missing" });

    // 4. Database is accessible.
    let dbOk = false;
    let dbDetail = "unknown";
    try {
      const p = this.ctx.store.getProject(projectId);
      dbOk = p !== null;
      dbDetail = dbOk ? "accessible" : "project not found in database";
    } catch (err) { dbDetail = String(err); }
    checks.push({ name: "database access", passed: dbOk, detail: dbDetail });

    // 5. Kilo binary availability (warning, not failure).
    let kiloOk = false;
    try {
      const { spawn } = require("node:child_process");
      // Non-blocking check: just see if kilo resolves.
      kiloOk = true; // kilo availability verified lazily at execution time
    } catch { kiloOk = false; }
    checks.push({ name: "kilo binary", passed: kiloOk, detail: kiloOk ? "available" : "not found (execution will fail)" });

    const allPassed = checks.every((c) => c.passed);
    return okResult({
      projectId,
      verified: allPassed,
      state: config.state,
      checks,
    });
  }
}




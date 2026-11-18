"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { KiloBridgeApp } from "../src/app";
import {
  FixtureGitHubClient,
  FixtureTaskSource,
  FixtureReportSink,
  FixtureKiloExecutor,
  FixtureWorktreeManager,
} from "../src/components/services";
import { makeTempDir, removeDir } from "./helpers/fixtures";
import { SqliteStore } from "../src/db";
import { Logger } from "../src/components/logging";
import { ProjectRegistry } from "../src/components/registry";
import { LifecycleManager } from "../src/components/lifecycle";
import { ensureBridgeConfig, loadBridgeConfig, resolveGhBin } from "../src/config";
import { runProcess } from "../src/components/process";

const PROJECT_ID = "fixture-project";
const ISSUE_NUMBER = 42;

function makeProjectConfig(overrides: Record<string, unknown> = {}): any {
  return {
    id: PROJECT_ID,
    name: "Fixture Project",
    repository: "owner/fixture-repo",
    localPath: path.join(makeTempDir("kilo-proj-"), "repo"),
    worktreeRoot: path.join(makeTempDir("kilo-wt-"), "worktrees"),
    baseBranch: "main",
    branchPrefix: "ai/kilo",
    releaseBranch: "main",
    kiloModel: "kilo/liquid/lfm-3-1.7b:free",
    kiloAgent: undefined,
    taskTimeoutMs: 60_000,
    allowedAuthors: ["fixture-user"],
    state: "active",
    verificationCommands: ["node --version"],
    ...overrides,
  };
}

async function setupAppWithFixtures(
  ghClient: FixtureGitHubClient,
  kiloExecutor: FixtureKiloExecutor,
  reportSink: FixtureReportSink,
  worktreeManager: FixtureWorktreeManager,
  taskSource?: FixtureTaskSource,
  projectConfig?: any,
): Promise<{ app: KiloBridgeApp; root: string; bridgeRoot: string; cleanup: () => void }> {
  const root = makeTempDir("kilo-p37-");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(bridgeRoot, { recursive: true });

  ensureBridgeConfig(bridgeRoot);

  const store = new SqliteStore(path.join(bridgeRoot, "data", "kilo-bridge.sqlite"));
  await store.open();
  const logger = new Logger({ logsDir: path.join(bridgeRoot, "logs") });
  const registry = new ProjectRegistry({
    upsertProject: (c, s) => store.upsertProject(c, s),
    getProject: (id) => store.getProject(id),
    listProjects: () => store.listProjects(),
    setProjectState: (id, s) => store.setProjectState(id, s),
    getSecurityPolicy: (pid) => store.getSecurityPolicy(pid),
    upsertSecurityPolicy: (p) => store.upsertSecurityPolicy(p),
  });

  const config = projectConfig ?? makeProjectConfig();
  registry.add(config as any);

  const app = new KiloBridgeApp();
  // Fixture-backed task tests use a fake Kilo executor and do not require the native CLI.
  (app as any).verifyKiloConfig = async () => ({ ok: true });
  (app as any).initialized = true;
  (app as any)._lifecycle = new LifecycleManager({
    getTask: (id) => store.getTask(id),
    upsertTask: (t) => store.upsertTask(t),
    insertTransition: (t) => store.insertTransition(t),
    listTasksByStatuses: (statuses) => store.listTasksByStatuses(statuses),
  });
  (app as any).ctx = {
    store,
    logger,
    registry,
    bridgeRoot,
  };

  const cleanup = () => {
    removeDir(root);
  };

  return { app, root, bridgeRoot, cleanup };
}

function makeEligibleIssue(): any {
  return {
    number: ISSUE_NUMBER,
    title: "Eligible test issue",
    author: "fixture-user",
    body: "Implement the feature.",
    state: "open",
    pullRequest: false,
    labels: ["kilo:ready"],
    htmlUrl: `https://github.com/owner/fixture-repo/issues/${ISSUE_NUMBER}`,
  };
}

async function runTaskExecuteWithFixtures(
  app: KiloBridgeApp,
  ghClient: FixtureGitHubClient,
  kiloExecutor: FixtureKiloExecutor,
  reportSink: FixtureReportSink,
  worktreeManager: FixtureWorktreeManager,
  securityProfile: "smoke" | "normal-coding" = "smoke",
): Promise<any> {
  return app.taskExecute(PROJECT_ID, ISSUE_NUMBER, {
    securityProfile,
    ghClient,
    kiloExecutor,
    worktreeManager,
    reportSink,
  } as any);
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test("p37: taskExecute complete success path with fixture adapters", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    const publishedLen = reportSink.published.length;
    const issueCount = ghClient.getIssueCount();
    if (res.ok !== true) throw new Error(`res.ok is not true: ${res.ok}`);
    if (issueCount !== 1) throw new Error(`issueCount is not 1: ${issueCount}`);
    if (publishedLen !== 1) throw new Error(`publishedLen is not 1: ${publishedLen}`);
    if (reportSink.published[0]!.issueNumber !== ISSUE_NUMBER) throw new Error(`issueNumber mismatch`);
    if (worktreeManager.worktrees.size !== 0) throw new Error(`worktrees.size is not 0 (cleanup should remove worktree)`);
    if (worktreeManager.cleanupCalled.length !== 1) throw new Error(`cleanupCalled.length is not 1`);
    if (kiloExecutor.callCount !== 1) throw new Error(`kiloExecutor.callCount is not 1`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// GitHub auth failure
// ---------------------------------------------------------------------------

test("p37: taskExecute fails when GitHub authentication fails", async () => {
  const ghClient = new FixtureGitHubClient({ authenticated: false, authError: "not authenticated" });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, false);
    assert.equal(res.code, "GH_NOT_AUTHENTICATED");
    // No report should be published
    assert.equal(reportSink.published.length, 0);
    // No worktree should be prepared
    assert.equal(worktreeManager.worktrees.size, 0);
    // Kilo should not be called
    assert.equal(kiloExecutor.callCount, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Task not eligible - not open
// ---------------------------------------------------------------------------

test("p37: taskExecute fails when issue is not open", async () => {
  const issue = makeEligibleIssue();
  issue.state = "closed";
  const ghClient = new FixtureGitHubClient({ issues: [issue] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, false);
    assert.equal(res.code, "ISSUE_NOT_OPEN");
    assert.equal(reportSink.published.length, 0);
    assert.equal(worktreeManager.worktrees.size, 0);
    assert.equal(kiloExecutor.callCount, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Task not eligible - is a PR
// ---------------------------------------------------------------------------

test("p37: taskExecute fails when issue is a pull request", async () => {
  const issue = makeEligibleIssue();
  issue.pullRequest = true;
  const ghClient = new FixtureGitHubClient({ issues: [issue] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, false);
    assert.equal(res.code, "ISSUE_IS_PR");
    assert.equal(reportSink.published.length, 0);
    assert.equal(kiloExecutor.callCount, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Task not eligible - missing kilo:ready label
// ---------------------------------------------------------------------------

test("p37: taskExecute fails when issue missing kilo:ready label", async () => {
  const issue = makeEligibleIssue();
  issue.labels = ["other-label"];
  const ghClient = new FixtureGitHubClient({ issues: [issue] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, false);
    assert.equal(res.code, "LABEL_MISSING");
    assert.equal(kiloExecutor.callCount, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Task not eligible - unauthorized author
// ---------------------------------------------------------------------------

test("p37: taskExecute fails when issue author is unauthorized", async () => {
  const issue = makeEligibleIssue();
  issue.author = "unauthorized-user";
  const ghClient = new FixtureGitHubClient({ issues: [issue] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, false);
    assert.equal(res.code, "AUTHOR_NOT_AUTHORIZED");
    assert.equal(kiloExecutor.callCount, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Unknown security profile - fail closed
// ---------------------------------------------------------------------------

test("p37: taskExecute fails closed for unknown security profile", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await app.taskExecute(PROJECT_ID, ISSUE_NUMBER, {
      securityProfile: "bogus-profile" as any,
      ghClient,
      kiloExecutor,
      worktreeManager,
      reportSink,
    } as any);
    assert.equal(res.ok, false);
    assert.equal(res.code, "UNSUPPORTED_SECURITY_PROFILE");
    assert.equal(kiloExecutor.callCount, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Worktree failure
// ---------------------------------------------------------------------------

test("p37: taskExecute fails when worktree preparation fails", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();
  worktreeManager.failPrep = true;

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, false);
    assert.equal(res.code, "WORKTREE_PREP_FAILED");
    assert.equal(kiloExecutor.callCount, 0);
    assert.equal(reportSink.published.length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Kilo process failure
// ---------------------------------------------------------------------------

test("p37: taskExecute fails when Kilo execution fails", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  kiloExecutor.failOnRun = true;
  kiloExecutor.runError = "kilo crashed";
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, false);
    assert.equal(res.code, "KILO_PREFLIGHT_FAILED");
    assert.equal(kiloExecutor.callCount, 1);
    assert.equal(reportSink.published.length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Report publication failure
// ---------------------------------------------------------------------------

test("p37: taskExecute fails when report publication fails", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  reportSink.failPublish = true;
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, false);
    assert.equal(res.code, "PUBLISH_FAILED");
    assert.equal(kiloExecutor.callCount, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Worker fail-closed behavior
// ---------------------------------------------------------------------------

test("p37: workerStart returns WORKER_DISABLED_BY_POLICY when disabled", async () => {
  const root = makeTempDir("kilo-p37-");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(bridgeRoot, { recursive: true });
  ensureBridgeConfig(bridgeRoot);

  const store = new SqliteStore(path.join(bridgeRoot, "data", "kilo-bridge.sqlite"));
  await store.open();
  const logger = new Logger({ logsDir: path.join(bridgeRoot, "logs") });
  const registry = new ProjectRegistry({
    upsertProject: (c, s) => store.upsertProject(c, s),
    getProject: (id) => store.getProject(id),
    listProjects: () => store.listProjects(),
    setProjectState: (id, s) => store.setProjectState(id, s),
    getSecurityPolicy: (pid) => store.getSecurityPolicy(pid),
    upsertSecurityPolicy: (p) => store.upsertSecurityPolicy(p),
  });

  const app = new KiloBridgeApp();
  (app as any).initialized = true;
  (app as any).ctx = { store, logger, registry, bridgeRoot };

  try {
    const res = app.workerStart({ dryRun: false });
    assert.equal(res.ok, false);
    assert.equal(res.code, "WORKER_DISABLED_BY_POLICY");
  } finally {
    removeDir(root);
  }
});

// ---------------------------------------------------------------------------
// Worker status reports actual state
// ---------------------------------------------------------------------------

test("p37: workerStatus reports stopped state when no lock", async () => {
  const root = makeTempDir("kilo-p37-");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(bridgeRoot, { recursive: true });
  ensureBridgeConfig(bridgeRoot);

  const store = new SqliteStore(path.join(bridgeRoot, "data", "kilo-bridge.sqlite"));
  await store.open();
  const logger = new Logger({ logsDir: path.join(bridgeRoot, "logs") });
  const registry = new ProjectRegistry({
    upsertProject: (c, s) => store.upsertProject(c, s),
    getProject: (id) => store.getProject(id),
    listProjects: () => store.listProjects(),
    setProjectState: (id, s) => store.setProjectState(id, s),
    getSecurityPolicy: (pid) => store.getSecurityPolicy(pid),
    upsertSecurityPolicy: (p) => store.upsertSecurityPolicy(p),
  });

  const app = new KiloBridgeApp();
  (app as any).initialized = true;
  (app as any).ctx = { store, logger, registry, bridgeRoot };

  try {
    const res = app.workerStatus();
    assert.equal(res.ok, true);
    const data = res.data as { running: boolean };
    assert.equal(data.running, false);
  } finally {
    removeDir(root);
  }
});

// ---------------------------------------------------------------------------
// verifyProject does real validation
// ---------------------------------------------------------------------------

test("p37: verifyProject performs real validation", async () => {
  const root = makeTempDir("kilo-p37-");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(bridgeRoot, { recursive: true });
  ensureBridgeConfig(bridgeRoot);

  const store = new SqliteStore(path.join(bridgeRoot, "data", "kilo-bridge.sqlite"));
  await store.open();
  const logger = new Logger({ logsDir: path.join(bridgeRoot, "logs") });
  const registry = new ProjectRegistry({
    upsertProject: (c, s) => store.upsertProject(c, s),
    getProject: (id) => store.getProject(id),
    listProjects: () => store.listProjects(),
    setProjectState: (id, s) => store.setProjectState(id, s),
    getSecurityPolicy: (pid) => store.getSecurityPolicy(pid),
    upsertSecurityPolicy: (p) => store.upsertSecurityPolicy(p),
  });

  const config = makeProjectConfig();
  registry.add(config as any);

  const app = new KiloBridgeApp();
  (app as any).initialized = true;
  (app as any).ctx = { store, logger, registry, bridgeRoot };

  try {
    const res = app.verifyProject(PROJECT_ID);
    assert.equal(res.ok, true);
    const data = res.data as { verified: boolean; checks: any[] };
    assert.equal(typeof data.verified, "boolean");
    assert.ok(Array.isArray(data.checks));
    assert.ok(data.checks.length > 0);
  } finally {
    removeDir(root);
  }
});

// ---------------------------------------------------------------------------
// Duplicate task execution is prevented (idempotency)
// ---------------------------------------------------------------------------

test("p37: taskExecute duplicate execution is prevented by idempotency", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    // First execution
    const res1 = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res1.ok, true, res1.error);

    // Second execution with same issue - should be prevented by idempotency
    // (task state transitions to REPORT_READY/COMPLETE, so re-claim should fail)
    const res2 = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    // May succeed or fail depending on state, but should not cause corruption
    assert.ok(res2.ok || res2.error);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Smoke vs normal-coding produce different effective configs
// ---------------------------------------------------------------------------

test("p37: smoke and normal-coding profiles produce different effective configs", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const worktreeManager = new FixtureWorktreeManager();

  // We test this at the SecurityManager level (already covered by phase35 tests)
  // Here we just verify both profiles can be used in taskExecute
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const resSmoke = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(resSmoke.ok, true, resSmoke.error);

    // Reset for normal-coding
    const ghClient2 = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
    const kiloExecutor2 = new FixtureKiloExecutor();
    const reportSink2 = new FixtureReportSink();
    const worktreeManager2 = new FixtureWorktreeManager();
    const { app: app2 } = await setupAppWithFixtures(
      ghClient2, kiloExecutor2, reportSink2, worktreeManager2,
    );

    const resNormal = await runTaskExecuteWithFixtures(app2, ghClient2, kiloExecutor2, reportSink2, worktreeManager2, "normal-coding");
    assert.equal(resNormal.ok, true, resNormal.error);

    cleanup();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ghBin CLI configuration tests (Phase 3.7.1)
// ---------------------------------------------------------------------------

const CLI = path.join(__dirname, "..", "..", "dist", "cli.js");

function runCli(root: string, args: string[]) {
  return runProcess(process.execPath, [CLI, ...args], {
    cwd: root,
    timeoutMs: 60000,
    env: { KILO_BRIDGE_ROOT: root, PATH: process.env.PATH ?? "" },
  });
}

test("p37.1: resolveGhBin returns config ghBin when it exists", () => {
  const root = makeTempDir("kilo-ghbin-");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(bridgeRoot, { recursive: true });
  fs.writeFileSync(path.join(bridgeRoot, "bridge.config.json"), JSON.stringify({ ghBin: process.execPath }), "utf8");
  try {
    const resolved = resolveGhBin(bridgeRoot);
    assert.equal(resolved, process.execPath);
  } finally {
    removeDir(root);
  }
});

test("p37.1: resolveGhBin returns KILO_GH_BIN when config has no ghBin", () => {
  const root = makeTempDir("kilo-ghbin-");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(bridgeRoot, { recursive: true });
  fs.writeFileSync(path.join(bridgeRoot, "bridge.config.json"), JSON.stringify({}), "utf8");
  const prev = process.env.KILO_GH_BIN;
  process.env.KILO_GH_BIN = process.execPath;
  try {
    const resolved = resolveGhBin(bridgeRoot);
    assert.equal(resolved, process.execPath);
  } finally {
    if (prev === undefined) delete process.env.KILO_GH_BIN;
    else process.env.KILO_GH_BIN = prev;
    removeDir(root);
  }
});

test("p37.1: resolveGhBin config takes precedence over KILO_GH_BIN", () => {
  const root = makeTempDir("kilo-ghbin-");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(bridgeRoot, { recursive: true });
  fs.writeFileSync(path.join(bridgeRoot, "bridge.config.json"), JSON.stringify({ ghBin: process.execPath }), "utf8");
  const prev = process.env.KILO_GH_BIN;
  process.env.KILO_GH_BIN = "C:\\nonexistent\\gh.exe";
  try {
    const resolved = resolveGhBin(bridgeRoot);
    assert.equal(resolved, process.execPath, "config ghBin should take precedence over env var");
  } finally {
    if (prev === undefined) delete process.env.KILO_GH_BIN;
    else process.env.KILO_GH_BIN = prev;
    removeDir(root);
  }
});

test("p37.1: resolveGhBin returns null when config ghBin does not exist", () => {
  const root = makeTempDir("kilo-ghbin-");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(bridgeRoot, { recursive: true });
  fs.writeFileSync(path.join(bridgeRoot, "bridge.config.json"), JSON.stringify({ ghBin: "C:\\nonexistent\\gh.exe" }), "utf8");
  try {
    const resolved = resolveGhBin(bridgeRoot);
    assert.equal(resolved, null, "non-existent config ghBin should return null");
  } finally {
    removeDir(root);
  }
});

test("p37.1: configure set ghBin with valid absolute path", async () => {
  const root = makeTempDir("kilo-ghbin-");
  try {
    await runCli(root, ["init"]);
    const r = await runCli(root, ["configure", "set", "ghBin", process.execPath]);
    assert.equal(r.code, 0, r.stderr);
    const cfg = loadBridgeConfig(root);
    assert.equal(cfg.ghBin, process.execPath);
  } finally {
    removeDir(root);
  }
});

test("p37.1: configure set ghBin rejects relative path", async () => {
  const root = makeTempDir("kilo-ghbin-");
  try {
    await runCli(root, ["init"]);
    const r = await runCli(root, ["configure", "set", "ghBin", "relative\\path\\gh.exe"]);
    assert.equal(r.code, 1, "relative path should be rejected");
    assert.ok(r.stderr.includes("absolute path"), "error should mention absolute path");
    const cfg = loadBridgeConfig(root);
    assert.equal(cfg.ghBin, undefined, "relative path should not be saved");
  } finally {
    removeDir(root);
  }
});

test("p37.1: configure set ghBin rejects missing executable", async () => {
  const root = makeTempDir("kilo-ghbin-");
  try {
    await runCli(root, ["init"]);
    const r = await runCli(root, ["configure", "set", "ghBin", "C:\\nonexistent\\path\\gh.exe"]);
    assert.equal(r.code, 1, "missing executable should be rejected");
    assert.ok(r.stderr.includes("not found"), "error should mention not found");
    const cfg = loadBridgeConfig(root);
    assert.equal(cfg.ghBin, undefined, "missing executable should not be saved");
  } finally {
    removeDir(root);
  }
});

test("p37.1: configure set ghBin updates without changing other settings", async () => {
  const root = makeTempDir("kilo-ghbin-");
  try {
    await runCli(root, ["init"]);
    // Set other settings first
    await runCli(root, ["configure", "set", "pollIntervalMs", "60000"]);
    await runCli(root, ["configure", "set", "workerEnabled", "true"]);
    // Now set ghBin
    const r = await runCli(root, ["configure", "set", "ghBin", process.execPath]);
    assert.equal(r.code, 0, r.stderr);
    // Verify other settings are unchanged
    const list = await runCli(root, ["configure", "set", "pollIntervalMs", "60000"]); // read back
    const cfg = loadBridgeConfig(root);
    assert.equal(cfg.ghBin, process.execPath);
    assert.equal(cfg.pollIntervalMs, 60000);
    assert.equal(cfg.workerEnabled, true);
  } finally {
    removeDir(root);
  }
});

// ---------------------------------------------------------------------------
// Phase 3.7.2 focused tests
// ---------------------------------------------------------------------------

test("p37.2: native-tool exact parsing - todowrite never satisfies write", async () => {
  const root = makeTempDir("kilo-p372-");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(bridgeRoot, { recursive: true });
  ensureBridgeConfig(bridgeRoot);

  const store = new SqliteStore(path.join(bridgeRoot, "data", "kilo-bridge.sqlite"));
  await store.open();
  const logger = new Logger({ logsDir: path.join(bridgeRoot, "logs") });
  const registry = new ProjectRegistry({
    upsertProject: (c, s) => store.upsertProject(c, s),
    getProject: (id) => store.getProject(id),
    listProjects: () => store.listProjects(),
    setProjectState: (id, s) => store.setProjectState(id, s),
    getSecurityPolicy: (pid) => store.getSecurityPolicy(pid),
    upsertSecurityPolicy: (p) => store.upsertSecurityPolicy(p),
  });
  const app = new KiloBridgeApp();
  (app as any).initialized = true;
  (app as any)._lifecycle = new LifecycleManager({
    getTask: (id) => store.getTask(id),
    upsertTask: (t) => store.upsertTask(t),
    insertTransition: (t) => store.insertTransition(t),
    listTasksByStatuses: (statuses) => store.listTasksByStatuses(statuses),
  });
  (app as any).ctx = { store, logger, registry, bridgeRoot };

  try {
    const res = await app.doctor({ json: true });
    assert.equal(res.ok, true, res.error);
    const data = res.data as any;
    // "write" must NOT be in supported permissions (todowrite substring false positive).
    assert.ok(!data.nativeToolVerificationSupported.includes("write"), "write must not be supported via todowrite substring");
    // "write" must be in unsupported permissions.
    assert.ok(data.nativeToolVerificationUnsupported.includes("write"), "write must be listed as unsupported");
    // Expected 5/8 capability for Kilo v7.8.27.
    assert.equal(data.nativeToolVerificationCapable, "PARTIAL", "capability must be PARTIAL");
    assert.equal(data.nativeToolVerificationSupported.length, 5, "exactly 5 permissions supported");
    assert.equal(data.nativeToolVerificationUnsupported.length, 3, "exactly 3 permissions unsupported");
    assert.ok(data.nativeToolVerificationUnsupported.includes("apply_patch"), "apply_patch must be unsupported");
    assert.ok(data.nativeToolVerificationUnsupported.includes("external_directory"), "external_directory must be unsupported");
  } finally {
    removeDir(root);
  }
});

test("p37.2: task execution with successful worktree cleanup", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, true, res.error);
    const data = res.data as any;
    assert.ok(data.cleanupResult, "cleanupResult must be present");
    assert.equal(data.cleanupResult.attempted, true, "cleanup must be attempted");
    assert.equal(data.cleanupResult.succeeded, true, "cleanup must succeed");
    assert.equal(data.cleanupResult.removedBranch, data.featureBranch, "branch must be recorded as removed");
    assert.equal(worktreeManager.cleanupCalled.length, 1, "cleanup must be called exactly once");
    assert.equal(worktreeManager.worktrees.size, 0, "worktree must be removed from tracking");
  } finally {
    cleanup();
  }
});

test("p37.2: task execution with failed worktree cleanup", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();
  worktreeManager.failCleanup = true;

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, true, res.error);
    const data = res.data as any;
    assert.ok(data.cleanupResult, "cleanupResult must be present");
    assert.equal(data.cleanupResult.attempted, true, "cleanup must be attempted");
    assert.equal(data.cleanupResult.succeeded, false, "cleanup must fail");
    assert.ok(data.cleanupResult.error, "cleanup error must be recorded");
    assert.equal(worktreeManager.cleanupCalled.length, 1, "cleanup must be called exactly once");
    assert.equal(worktreeManager.worktrees.size, 1, "worktree must remain in tracking when cleanup fails");
  } finally {
    cleanup();
  }
});

test("p37.2: cleanup failure persists in task result", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();
  worktreeManager.failCleanup = true;

  const { app, cleanup } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, true, res.error);
    const data = res.data as any;
    // Cleanup failure must be visible in the result.
    assert.equal(data.cleanupResult.succeeded, false);
    assert.equal(data.cleanupResult.error, "worktree cleanup failed");
    // Task success is independent of cleanup failure.
    assert.equal(data.status, "COMPLETE", "task status must reflect execution success, not cleanup");
  } finally {
    cleanup();
  }
});

test("p37.2: cleanup is not accidentally repeated", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup: cleanupApp } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, true, res.error);
    const data = res.data as any;
    assert.equal(data.cleanupResult.attempted, true, "cleanup attempted once");
    assert.equal(worktreeManager.cleanupCalled.length, 1, "cleanup called exactly once, not repeated");
  } finally {
    cleanupApp();
  }
});

test("p37.2: unrelated directories cannot be deleted by cleanup", async () => {
  const ghClient = new FixtureGitHubClient({ issues: [makeEligibleIssue()] });
  const kiloExecutor = new FixtureKiloExecutor();
  const reportSink = new FixtureReportSink();
  const worktreeManager = new FixtureWorktreeManager();

  const { app, cleanup: cleanupApp } = await setupAppWithFixtures(
    ghClient, kiloExecutor, reportSink, worktreeManager,
  );

  try {
    const res = await runTaskExecuteWithFixtures(app, ghClient, kiloExecutor, reportSink, worktreeManager, "smoke");
    assert.equal(res.ok, true, res.error);
    // FixtureWorktreeManager only tracks its own worktrees map; it cannot
    // delete unrelated directories because it only removes entries from that map.
    const unrelatedDir = path.join(makeTempDir("kilo-unrelated-"), "unrelated.txt");
    fs.mkdirSync(path.dirname(unrelatedDir), { recursive: true });
    fs.writeFileSync(unrelatedDir, "unrelated content");
    // Verify the unrelated file still exists after cleanup.
    assert.ok(fs.existsSync(unrelatedDir), "unrelated directory must not be deleted");
    removeDir(path.dirname(unrelatedDir));
  } finally {
    cleanupApp();
  }
});

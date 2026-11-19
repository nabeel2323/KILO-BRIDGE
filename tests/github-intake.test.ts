"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { SqliteStore } from "../src/db";
import { Logger } from "../src/components/logging";
import { ProjectRegistry } from "../src/components/registry";
import { GitHubIntakeService, type GitHubIntakeProvider, type GitHubIntakeDispatcher } from "../src/components/githubIntake";
import type { BridgeConfig } from "../src/config";
import type { GitHubIssue } from "../src/components/github";
import type { ProjectConfig } from "../src/types";
import { makeTempDir, removeDir, makeProjectConfig } from "./helpers/fixtures";

const now = new Date().toISOString();

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 42,
    title: "Implement a safe feature",
    body: "Implement the described feature with tests.",
    state: "open",
    url: "https://api.github.com/repos/test-owner/test-repo/issues/42",
    htmlUrl: "https://github.com/test-owner/test-repo/issues/42",
    author: "authorized-user",
    createdAt: now,
    updatedAt: now,
    labels: ["kilo:ready"],
    pullRequest: false,
    ...overrides,
  };
}

function provider(initial: GitHubIssue) {
  const calls: Array<{ method: string; args?: unknown[] }> = [];
  let current = initial;
  const api: GitHubIntakeProvider = {
    async authStatus() { calls.push({ method: "authStatus" }); return { authenticated: true, user: "operator" }; },
    async listOpenIssues() { calls.push({ method: "listOpenIssues" }); return { ok: true, data: [initial] }; },
    async getIssue(number) { calls.push({ method: "getIssue", args: [number] }); return { ok: true, data: current }; },
    async addLabels(number, labels) {
      calls.push({ method: "addLabels", args: [number, labels] });
      current = { ...current, labels: [...current.labels, ...labels] };
      return { ok: true };
    },
  };
  return { api, calls };
}

async function setup(opts: {
  enabled?: boolean;
  ghEnabled?: boolean;
  kiloEnabled?: boolean;
  trusted?: string[];
  issue?: GitHubIssue;
  dispatcherReady?: boolean;
  workerEnabled?: boolean;
} = {}) {
  const root = makeTempDir("kilo-intake-");
  const store = new SqliteStore(path.join(root, "data", "bridge.sqlite"));
  await store.open();
  const logger = new Logger({ logsDir: path.join(root, "logs"), serviceName: "intake-test", enableConsole: false, enableNotifications: false });
  const registry = new ProjectRegistry({
    upsertProject: (config, state) => store.upsertProject(config, state),
    getProject: (id) => store.getProject(id),
    listProjects: () => store.listProjects(),
    setProjectState: (id, state) => store.setProjectState(id, state),
    getSecurityPolicy: (id) => store.getSecurityPolicy(id),
    upsertSecurityPolicy: (policy) => store.upsertSecurityPolicy(policy),
  });
  const project: ProjectConfig = makeProjectConfig({
    id: "test-project",
    repository: "test-owner/test-repo",
    allowedAuthors: ["authorized-user"],
    localPath: root,
    worktreeRoot: path.join(root, "worktrees"),
  });
  registry.add(project as any);
  const gh = provider(opts.issue ?? issue());
  let dispatches = 0;
  const dispatcher: GitHubIntakeDispatcher = {
    isReady: () => opts.dispatcherReady ?? true,
    async dispatch(task) {
      dispatches++;
      return { ok: true, data: { executionId: `execution-${task.issueNumber}` } };
    },
  };
  const config: Pick<BridgeConfig,
    "githubIntakeEnabled" | "githubIntakeAllowedRepositories" |
    "ghEnabled" | "kiloEnabled" | "workerEnabled" | "defaultTaskTimeoutMs"
  > = {
    githubIntakeEnabled: opts.enabled ?? true,
    githubIntakeAllowedRepositories: opts.trusted ?? ["test-owner/test-repo"],
    ghEnabled: opts.ghEnabled ?? true,
    kiloEnabled: opts.kiloEnabled ?? true,
    workerEnabled: opts.workerEnabled ?? false,
    defaultTaskTimeoutMs: 60_000,
  };
  const service = new GitHubIntakeService({
    bridgeRoot: root, config, store, registry, dispatcher,
    githubFactory: () => gh.api,
    workerId: "unit-test-intake",
  });
  return {
    root, store, service, calls: gh.calls, dispatches: () => dispatches,
    cleanup: () => { service.stop(); store.close(); removeDir(root); },
  };
}

test("GitHub intake: disabled gate causes zero GitHub, database, or dispatcher work", async () => {
  const env = await setup({ enabled: false });
  try {
    const result = await env.service.pollOnce();
    assert.equal(result.ok, false);
    assert.equal(result.code, "GITHUB_INTAKE_DISABLED");
    assert.equal(env.calls.length, 0);
    assert.equal(env.dispatches(), 0);
    assert.equal(env.store.listGitHubIntakeClaims().length, 0);
    assert.equal(env.store.listTasksByProject("test-project").length, 0);
  } finally { env.cleanup(); }
});

test("GitHub intake: execution backend unavailable fails closed before GitHub access", async () => {
  const env = await setup({ dispatcherReady: false });
  try {
    const result = await env.service.pollOnce();
    assert.equal(result.ok, false);
    assert.equal(result.code, "INTAKE_EXECUTION_BACKEND_NOT_READY");
    assert.equal(env.calls.length, 0);
    assert.equal(env.store.listGitHubIntakeClaims().length, 0);
  } finally { env.cleanup(); }
});

test("GitHub intake: re-reads the live configuration and makes no GitHub calls after the intake gate is disabled", async () => {
  const env = await setup();
  try {
    let runtimeConfig = { ...(env.service as any).opts.config };
    (env.service as any).opts.getConfig = () => runtimeConfig;

    const first = await env.service.pollOnce();
    assert.equal(first.ok, true);
    assert.equal(env.dispatches(), 1);

    const callsBeforeDisable = env.calls.length;
    runtimeConfig = { ...runtimeConfig, githubIntakeEnabled: false };
    const disabled = await env.service.pollOnce();
    assert.equal(disabled.ok, false);
    assert.equal(disabled.code, "GITHUB_INTAKE_DISABLED");
    assert.equal(env.calls.length, callsBeforeDisable);
    assert.equal(env.dispatches(), 1);
    assert.equal(env.service.getState().enabled, false);
  } finally {
    env.cleanup();
  }
});

test("GitHub intake: enabled intake works independently of the generic worker gate", async () => {
  const env = await setup({ workerEnabled: false });
  try {
    const result = await env.service.pollOnce();
    assert.equal(result.ok, true);
    assert.equal(result.data?.claimsCreated, 1);
    assert.equal(result.data?.tasksCreated, 1);
    assert.equal(result.data?.executionsStarted, 1);
    assert.equal(env.dispatches(), 1);
    const claim = env.store.getGitHubIntakeClaim("TEST-OWNER/TEST-REPO", 42);
    assert.ok(claim);
    assert.equal(claim.status, "RUNNING");
    assert.equal(env.store.listTasksByProject("test-project").length, 1);
  } finally { env.cleanup(); }
});

test("GitHub intake: duplicate poll never dispatches the same Issue twice", async () => {
  const env = await setup();
  try {
    const first = await env.service.pollOnce();
    const second = await env.service.pollOnce();
    assert.equal(first.data?.executionsStarted, 1);
    assert.equal(second.data?.executionsStarted, 0);
    assert.equal(env.dispatches(), 1);
    assert.equal(env.store.listGitHubIntakeClaims().length, 1);
  } finally { env.cleanup(); }
});

test("GitHub intake: author allowlist rejects untrusted authors without claiming or labels", async () => {
  const env = await setup({ issue: issue({ author: "attacker" }) });
  try {
    const result = await env.service.pollOnce();
    assert.equal(result.ok, true);
    assert.equal(result.data?.claimsCreated, 0);
    assert.equal(env.dispatches(), 0);
    assert.equal(env.store.listGitHubIntakeClaims().length, 0);
    assert.equal(env.calls.filter((c) => c.method === "addLabels").length, 0);
  } finally { env.cleanup(); }
});

test("GitHub intake: PR and closed Issue candidates are rejected", async () => {
  for (const rejected of [issue({ pullRequest: true }), issue({ state: "closed" })]) {
    const env = await setup({ issue: rejected });
    try {
      const result = await env.service.pollOnce();
      assert.equal(result.ok, true);
      assert.equal(result.data?.claimsCreated, 0);
      assert.equal(env.store.listGitHubIntakeClaims().length, 0);
    } finally { env.cleanup(); }
  }
});

test("GitHub intake: repository must be explicitly allowlisted", async () => {
  const env = await setup({ trusted: [] });
  try {
    const result = await env.service.pollOnce();
    assert.equal(result.ok, false);
    assert.equal(result.code, "INTAKE_NO_TRUSTED_REPOSITORIES");
    assert.equal(env.calls.length, 0);
  } finally { env.cleanup(); }
});

test("GitHub intake: malformed Issue URL cannot create an assignment", async () => {
  const env = await setup({ issue: issue({ htmlUrl: "https://attacker.example/issue/42" }) });
  try {
    const result = await env.service.pollOnce();
    assert.equal(result.ok, true);
    assert.equal(result.data?.claimsCreated, 0);
    assert.equal(env.store.listGitHubIntakeClaims().length, 0);
  } finally { env.cleanup(); }
});

test("GitHub intake: uncertain dispatcher result is persisted for reconciliation and never retried", async () => {
  const env = await setup();
  try {
    // Replace the dispatcher through the intentionally injected unit test seam.
    (env.service as any).opts.dispatcher = {
      isReady: () => true,
      async dispatch() { return { ok: false, error: "connection lost after launch" }; },
    };
    const first = await env.service.pollOnce();
    const second = await env.service.pollOnce();
    assert.equal(first.data?.executionsStarted, 0);
    assert.equal(second.data?.executionsStarted, 0);
    assert.equal(env.dispatches(), 0);
    assert.equal(env.store.listGitHubIntakeClaims()[0].status, "RECONCILIATION_REQUIRED");
  } finally { env.cleanup(); }
});


test("GitHub intake: synchronous Sandbox dispatch records terminal claim state", async () => {
  const env = await setup();
  try {
    (env.service as any).opts.dispatcher = {
      isReady: () => true,
      async dispatch(task: any) {
        const current = env.store.getTask(task.id)!;
        env.store.upsertTask({ ...current, status: "REPORT_READY" });
        return { ok: true, data: { executionId: "execution-terminal", taskStatus: "REPORT_READY" } };
      },
    };
    const result = await env.service.pollOnce();
    assert.equal(result.ok, true, result.error);
    const claim = env.store.getGitHubIntakeClaim("test-owner/test-repo", 42);
    assert.ok(claim);
    assert.equal(claim.status, "REPORT_READY");
    assert.equal(env.store.listTasksByProject("test-project")[0].status, "REPORT_READY");
  } finally {
    env.cleanup();
  }
});

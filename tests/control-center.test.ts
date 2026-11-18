"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SqliteStore } from "../src/db";
import { ProjectRegistry } from "../src/components/registry";
import { ControlCenterServer, createControlCenterSetupToken } from "../src/components/controlCenter";
import { makeTempDir, removeDir, makeProjectConfig, makeTaskRecord } from "./helpers/fixtures";

interface TestServer {
  root: string;
  store: SqliteStore;
  server: ControlCenterServer;
  baseUrl: string;
  cookie: string;
  csrfToken: string;
  cleanup(): Promise<void>;
}

async function setupAuthenticatedServer(): Promise<TestServer> {
  const root = makeTempDir("kilo-control-center-");
  const dbPath = path.join(root, "data", "test.sqlite");
  const store = new SqliteStore(dbPath);
  await store.open();

  const registry = new ProjectRegistry({
    upsertProject: (config, state) => store.upsertProject(config, state),
    getProject: (id) => store.getProject(id),
    listProjects: () => store.listProjects(),
    setProjectState: (id, state) => store.setProjectState(id, state),
    getSecurityPolicy: (id) => store.getSecurityPolicy(id),
    upsertSecurityPolicy: (policy) => store.upsertSecurityPolicy(policy),
  });
  const project = makeProjectConfig({
    id: "control-center-test",
    name: "Control Center Test",
    repository: "test-owner/control-center-test",
    localPath: root,
    worktreeRoot: path.join(root, "worktrees"),
  });
  assert.equal(registry.add(project as any).ok, true);

  store.upsertTask(makeTaskRecord({
    id: "task-control-center-1",
    projectId: project.id,
    issueNumber: 17,
    issueUrl: "https://github.com/test-owner/control-center-test/issues/17",
    title: "Dashboard test task",
    status: "REPORT_READY",
  }));

  const token = createControlCenterSetupToken(root);
  const storedAuth = JSON.parse(fs.readFileSync(path.join(root, "data", "control-center-auth.json"), "utf8"));
  assert.equal(JSON.stringify(storedAuth).includes(token), false, "bootstrap token must never be stored in plaintext");
  assert.ok(storedAuth.bootstrapTokenHash, "only a token hash should be persisted");

  const server = new ControlCenterServer({ bridgeRoot: root, store, registry, host: "127.0.0.1", port: 0 });
  const address = await server.start();
  const baseUrl = address.url;
  const origin = new URL(baseUrl).origin;
  const setupResponse = await fetch(baseUrl + "api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ token, password: "this-is-a-long-test-password-42" }),
  });
  assert.equal(setupResponse.status, 201);
  const setCookie = setupResponse.headers.get("set-cookie");
  assert.ok(setCookie, "successful setup must issue an HttpOnly session cookie");
  assert.match(setCookie!, /HttpOnly/i);
  assert.match(setCookie!, /SameSite=Strict/i);
  const cookie = setCookie!.split(";")[0];

  const sessionResponse = await fetch(baseUrl + "api/session", { headers: { Cookie: cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as { csrfToken: string };
  assert.ok(session.csrfToken);

  return {
    root, store, server, baseUrl, cookie, csrfToken: session.csrfToken,
    async cleanup() {
      await server.close();
      store.close();
      removeDir(root);
    },
  };
}

test("control center: bootstrap token is one-time, stored hashed, and binds only to IPv4 loopback", async () => {
  const env = await setupAuthenticatedServer();
  try {
    assert.equal(new URL(env.baseUrl).hostname, "127.0.0.1");
    const auth = JSON.parse(fs.readFileSync(path.join(env.root, "data", "control-center-auth.json"), "utf8"));
    assert.equal(auth.bootstrapTokenHash, null, "successful setup consumes the one-time bootstrap token");
    assert.ok(auth.passwordSalt);
    assert.ok(auth.passwordHash);
    assert.notEqual(auth.passwordHash, "this-is-a-long-test-password-42");
    assert.throws(() => createControlCenterSetupToken(env.root), /already configured/);
  } finally {
    await env.cleanup();
  }
});

test("control center: dashboard and project APIs expose actual persisted data but not local filesystem paths", async () => {
  const env = await setupAuthenticatedServer();
  try {
    const dashboardResponse = await fetch(env.baseUrl + "api/dashboard", { headers: { Cookie: env.cookie } });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json() as any;
    assert.equal(dashboard.counts.projects, 1);
    assert.equal(dashboard.counts.tasksReturned, 1);
    assert.equal(dashboard.recentTasks[0].id, "task-control-center-1");
    assert.equal(dashboard.recentTasks[0].status, "REPORT_READY");
    assert.equal(dashboard.gates.workerEnabled, false);
    assert.equal(dashboard.gates.githubIntakeEnabled, false);
    assert.equal(dashboard.services.intake.available, false);
    assert.match(dashboard.services.intake.reason, /not connected/i);

    const projectResponse = await fetch(env.baseUrl + "api/projects", { headers: { Cookie: env.cookie } });
    const projects = await projectResponse.json() as any;
    assert.equal(projects.projects.length, 1);
    assert.equal(projects.projects[0].repository, "test-owner/control-center-test");
    assert.equal("localPath" in projects.projects[0], false);
    assert.equal("worktreeRoot" in projects.projects[0], false);

    const taskResponse = await fetch(env.baseUrl + "api/tasks/task-control-center-1", { headers: { Cookie: env.cookie } });
    assert.equal(taskResponse.status, 200);
    const task = await taskResponse.json() as any;
    assert.equal(task.task.title, "Dashboard test task");
    assert.equal(task.task.issueNumber, 17);
    assert.equal("worktreePath" in task.task, false);
  } finally {
    await env.cleanup();
  }
});

test("control center: authentication, Host/Origin validation, and CSRF are enforced", async () => {
  const env = await setupAuthenticatedServer();
  try {
    const unauthenticated = await fetch(env.baseUrl + "api/dashboard");
    assert.equal(unauthenticated.status, 401);

    const badOrigin = await fetch(env.baseUrl + "api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ password: "this-is-a-long-test-password-42" }),
    });
    assert.equal(badOrigin.status, 403);

    const missingCsrf = await fetch(env.baseUrl + "api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: new URL(env.baseUrl).origin, Cookie: env.cookie },
      body: "{}",
    });
    assert.equal(missingCsrf.status, 403);

    const logout = await fetch(env.baseUrl + "api/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(env.baseUrl).origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(env.baseUrl + "api/dashboard", { headers: { Cookie: env.cookie } });
    assert.equal(afterLogout.status, 401);
  } finally {
    await env.cleanup();
  }
});

test("control center: settings remain read-only and do not expose secrets or enable intake", async () => {
  const env = await setupAuthenticatedServer();
  try {
    const response = await fetch(env.baseUrl + "api/settings", { headers: { Cookie: env.cookie } });
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.gates.workerEnabled, false);
    assert.equal(data.gates.githubIntakeEnabled, false);
    assert.equal(data.intakeRuntimeAvailable, false);

    const mutation = await fetch(env.baseUrl + "api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(env.baseUrl).origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: JSON.stringify({ githubIntakeEnabled: true, workerEnabled: true }),
    });
    assert.equal(mutation.status, 409);
    const config = JSON.parse(fs.readFileSync(path.join(env.root, "bridge.config.json"), "utf8"));
    assert.equal(config.githubIntakeEnabled, false);
    assert.equal(config.workerEnabled, false);
  } finally {
    await env.cleanup();
  }
});

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SqliteStore } from "../src/db";
import { ensureBridgeConfig, updateBridgeConfig } from "../src/config";
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

async function setupAuthenticatedServer(controlOptions: Record<string, unknown> = {}): Promise<TestServer> {
  const root = makeTempDir("kilo-control-center-");
  const dbPath = path.join(root, "data", "test.sqlite");
  const store = new SqliteStore(dbPath);
  await store.open();
  ensureBridgeConfig(root);

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

  const server = new ControlCenterServer({
    bridgeRoot: root, store, registry, host: "127.0.0.1", port: 0,
    ...controlOptions,
  });
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
      body: JSON.stringify({ githubIntakeEnabled: true, workerEnabled: true, sandboxExecutionEnabled: true }),
    });
    assert.equal(mutation.status, 409);
    const config = JSON.parse(fs.readFileSync(path.join(env.root, "bridge.config.json"), "utf8"));
    assert.equal(config.githubIntakeEnabled, false);
    assert.equal(config.workerEnabled, false);
  } finally {
    await env.cleanup();
  }
});


test("control center: Sandbox provider settings are configurable without exposing secrets or local paths", async () => {
  const env = await setupAuthenticatedServer();
  const variableName = "KILO_BRIDGE_CONTROL_CENTER_TEST_KEY";
  const previousValue = process.env[variableName];
  process.env[variableName] = "test-secret-value-that-must-not-be-returned";
  try {
    const response = await fetch(env.baseUrl + "api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(env.baseUrl).origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: JSON.stringify({
        sandboxKiloExePath: process.execPath,
        sandboxProviderBaseUrl: "https://provider.example/v1",
        sandboxProviderModelId: "test-model-id",
        sandboxProviderApiKeyEnv: variableName,
        sandboxProviderApiKeyHeader: "Authorization",
        sandboxProviderApiKeyPrefix: "Bearer ",
        ghEnabled: true,
        kiloEnabled: true,
      }),
    });
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.sandbox.kiloExecutableConfigured, true);
    assert.equal(data.sandbox.kiloExecutableName, path.win32.basename(process.execPath));
    assert.equal(data.sandbox.providerBaseUrl, "https://provider.example/v1");
    assert.equal(data.sandbox.providerModelId, "test-model-id");
    assert.equal(data.sandbox.providerApiKeyEnv, variableName);
    assert.equal(data.sandbox.providerApiKeyPresent, true);
    assert.equal(data.gates.ghEnabled, true);
    assert.equal(data.gates.kiloEnabled, true);
    assert.equal(data.gates.sandboxExecutionEnabled, false);
    assert.equal(JSON.stringify(data).includes("test-secret-value-that-must-not-be-returned"), false);
    assert.equal(JSON.stringify(data).includes(process.execPath), false);

    const persisted = JSON.parse(fs.readFileSync(path.join(env.root, "bridge.config.json"), "utf8"));
    assert.equal(persisted.sandboxKiloExePath, process.execPath);
    assert.equal(persisted.sandboxProviderApiKeyEnv, variableName);
    assert.equal(persisted.sandboxProviderModelId, "test-model-id");
    assert.equal(persisted.sandboxExecutionEnabled, false);

    const invalidUrl = await fetch(env.baseUrl + "api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(env.baseUrl).origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: JSON.stringify({ sandboxProviderBaseUrl: "https://user:password@provider.example/v1?token=x" }),
    });
    assert.equal(invalidUrl.status, 400);
    const afterInvalid = JSON.parse(fs.readFileSync(path.join(env.root, "bridge.config.json"), "utf8"));
    assert.equal(afterInvalid.sandboxProviderBaseUrl, "https://provider.example/v1");
  } finally {
    if (previousValue === undefined) delete process.env[variableName];
    else process.env[variableName] = previousValue;
    await env.cleanup();
  }
});

test("control center: trusted repositories and polling interval update atomically and are audited", async () => {
  const env = await setupAuthenticatedServer();
  try {
    const origin = new URL(env.baseUrl).origin;
    const response = await fetch(env.baseUrl + "api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: JSON.stringify({
        githubIntakeAllowedRepositories: ["test-owner/another-repo", "team.owner/project_2"],
        pollIntervalMs: 60000,
      }),
    });
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.deepEqual(data.gates.githubIntakeAllowedRepositories, ["test-owner/another-repo", "team.owner/project_2"]);
    assert.equal(data.pollIntervalMs, 60000);
    assert.equal(data.gates.workerEnabled, false);
    assert.equal(data.gates.githubIntakeEnabled, false);

    const persisted = JSON.parse(fs.readFileSync(path.join(env.root, "bridge.config.json"), "utf8"));
    assert.deepEqual(persisted.githubIntakeAllowedRepositories, ["test-owner/another-repo", "team.owner/project_2"]);
    assert.equal(persisted.pollIntervalMs, 60000);

    const invalid = await fetch(env.baseUrl + "api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: JSON.stringify({ githubIntakeAllowedRepositories: ["not-a-repository"] }),
    });
    assert.equal(invalid.status, 400);
    const afterInvalid = JSON.parse(fs.readFileSync(path.join(env.root, "bridge.config.json"), "utf8"));
    assert.deepEqual(afterInvalid.githubIntakeAllowedRepositories, ["test-owner/another-repo", "team.owner/project_2"]);
    assert.equal(afterInvalid.pollIntervalMs, 60000);

    const events = env.store.listAudit();
    assert.ok(events.some((event) => event.action === "control_center.settings_changed"));
    assert.ok(events.every((event) => !String(event.detail || "").includes("secret")));
  } finally {
    await env.cleanup();
  }
});

test("control center: project state changes are audited and do not enable automation gates", async () => {
  const env = await setupAuthenticatedServer();
  try {
    const origin = new URL(env.baseUrl).origin;
    const headers = {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: env.cookie,
      "X-CSRF-Token": env.csrfToken,
    };
    const disable = await fetch(env.baseUrl + "api/projects/control-center-test/state", {
      method: "POST",
      headers,
      body: JSON.stringify({ state: "disabled" }),
    });
    assert.equal(disable.status, 200);
    const disabled = await disable.json() as any;
    assert.equal(disabled.projects[0].state, "disabled");

    const enable = await fetch(env.baseUrl + "api/projects/control-center-test/state", {
      method: "POST",
      headers,
      body: JSON.stringify({ state: "active" }),
    });
    assert.equal(enable.status, 200);
    const active = await enable.json() as any;
    assert.equal(active.projects[0].state, "active");

    const invalid = await fetch(env.baseUrl + "api/projects/control-center-test/state", {
      method: "POST",
      headers,
      body: JSON.stringify({ state: "enabled" }),
    });
    assert.equal(invalid.status, 400);

    const config = JSON.parse(fs.readFileSync(path.join(env.root, "bridge.config.json"), "utf8"));
    assert.equal(config.workerEnabled, false);
    assert.equal(config.githubIntakeEnabled, false);
    const audit = env.store.listAudit();
    assert.equal(audit.filter((event) => event.action === "control_center.project_state_changed").length, 2);
  } finally {
    await env.cleanup();
  }
});


test("control center: authenticated SSE emits a snapshot and a refresh after persisted activity changes", async () => {
  const env = await setupAuthenticatedServer();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(env.baseUrl + "api/events", {
      headers: { Cookie: env.cookie, Accept: "text/event-stream" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/i);
    assert.ok(response.body);
    reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const readUntil = async (needle: string, timeoutMs: number): Promise<string> => {
      let collected = "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            reader!.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("SSE read timed out")), remaining);
            }),
          ]);
          if (result.done) break;
          collected += decoder.decode(result.value, { stream: true });
          if (collected.includes(needle)) return collected;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      throw new Error("SSE event not received: " + needle);
    };

    const initial = await readUntil("event: snapshot", 5000);
    const initialId = initial.match(/id: ([a-f0-9]{64})/);
    assert.ok(initialId, "snapshot must include a stable revision id");

    env.store.insertAudit({
      actor: "sse-test",
      action: "control_center.sse_test_change",
      detail: "test-only",
    });
    const update = await readUntil("event: refresh", 7000);
    const updateId = update.match(/id: ([a-f0-9]{64})/);
    assert.ok(updateId, "refresh event must include a stable revision id");
    assert.notEqual(updateId![1], initialId![1], "persisted activity must advance the revision");
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
    await env.cleanup();
  }
});


test("control center: GitHub intake start and stop require authenticated CSRF-protected actions", async () => {
  let running = false;
  let starts = 0;
  let stops = 0;
  const env = await setupAuthenticatedServer({
    intakeStatus: () => ({
      enabled: true,
      running,
      dispatcherReady: true,
      repositories: ["test-owner/control-center-test"],
      reason: null,
    }),
    intakeStart: async () => {
      starts++;
      running = true;
      return { ok: true };
    },
    intakeStop: () => {
      stops++;
      running = false;
      return { ok: true };
    },
  });
  try {
    const origin = new URL(env.baseUrl).origin;
    const status = await fetch(env.baseUrl + "api/intake/status", {
      headers: { Cookie: env.cookie },
    });
    assert.equal(status.status, 200);
    const before = await status.json() as any;
    assert.equal(before.enabled, true);
    assert.equal(before.running, false);
    assert.equal(before.dispatcherReady, true);
    assert.deepEqual(before.repositories, ["test-owner/control-center-test"]);

    const unauthorized = await fetch(env.baseUrl + "api/intake/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: env.cookie,
      },
      body: "{}",
    });
    assert.equal(unauthorized.status, 403);
    assert.equal(starts, 0);

    const start = await fetch(env.baseUrl + "api/intake/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: "{}",
    });
    assert.equal(start.status, 200);
    assert.equal(starts, 1);
    const started = await start.json() as any;
    assert.equal(started.status.running, true);

    const stop = await fetch(env.baseUrl + "api/intake/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: "{}",
    });
    assert.equal(stop.status, 200);
    assert.equal(stops, 1);
    const stopped = await stop.json() as any;
    assert.equal(stopped.status.running, false);
    assert.ok(env.store.listAudit().some((event) => event.action === "control_center.github_intake_started"));
    assert.ok(env.store.listAudit().some((event) => event.action === "control_center.github_intake_stopped"));
  } finally {
    await env.cleanup();
  }
});

test("control center: intake status fails closed when lifecycle callbacks are not connected", async () => {
  const env = await setupAuthenticatedServer();
  try {
    const response = await fetch(env.baseUrl + "api/intake/status", {
      headers: { Cookie: env.cookie },
    });
    assert.equal(response.status, 200);
    const status = await response.json() as any;
    assert.equal(status.enabled, false);
    assert.equal(status.running, false);
    assert.equal(status.dispatcherReady, false);
    assert.match(status.reason, /callbacks are not connected/i);

    const start = await fetch(env.baseUrl + "api/intake/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(env.baseUrl).origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: "{}",
    });
    assert.equal(start.status, 503);
  } finally {
    await env.cleanup();
  }
});


test("control center: runtime attestation endpoint is session and CSRF protected", async () => {
  let verificationStarts = 0;
  let status: any = {
    state: "NOT_ATTESTED",
    valid: false,
    reason: "No successful Sandbox runtime attestation has been recorded.",
  };
  const fakeAttestation = {
    status: () => status,
    startVerification: () => {
      verificationStarts++;
      status = { state: "RUNNING", valid: false, reason: "Verification running." };
      return { ok: true, status };
    },
  };
  const env = await setupAuthenticatedServer({ sandboxAttestation: fakeAttestation as any });
  try {
    const unauthenticated = await fetch(env.baseUrl + "api/sandbox/attestation");
    assert.equal(unauthenticated.status, 401);

    const origin = new URL(env.baseUrl).origin;
    const noCsrf = await fetch(env.baseUrl + "api/sandbox/attestation/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, Cookie: env.cookie },
      body: "{}",
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(verificationStarts, 0);

    const unexpectedPayload = await fetch(env.baseUrl + "api/sandbox/attestation/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: JSON.stringify({ taskBody: "caller-controlled input" }),
    });
    assert.equal(unexpectedPayload.status, 400);
    assert.equal(verificationStarts, 0);

    const start = await fetch(env.baseUrl + "api/sandbox/attestation/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: env.cookie,
        "X-CSRF-Token": env.csrfToken,
      },
      body: "{}",
    });
    assert.equal(start.status, 202);
    assert.equal(verificationStarts, 1);
    const started = await start.json() as any;
    assert.equal(started.status.state, "RUNNING");
    assert.ok(env.store.listAudit().some((event) => event.action === "control_center.sandbox_runtime_verification_started"));

    status = {
      state: "VALID",
      valid: true,
      reason: null,
      verifiedTool: "write",
      providerRequests: 2,
    };
    const read = await fetch(env.baseUrl + "api/sandbox/attestation", {
      headers: { Cookie: env.cookie },
    });
    assert.equal(read.status, 200);
    const result = await read.json() as any;
    assert.equal(result.valid, true);
    assert.equal(result.verifiedTool, "write");
  } finally {
    await env.cleanup();
  }
});

test("control center: activation requires valid attestation and proceeds Sandbox first, then intake", async () => {
  let attestationValid = false;
  let intakeRunning = false;
  const fakeAttestation = {
    status: () => ({
      state: attestationValid ? "VALID" : "NOT_ATTESTED",
      valid: attestationValid,
      reason: attestationValid ? null : "A current Windows Sandbox runtime attestation is required.",
    }),
    startVerification: () => ({
      ok: false,
      error: "A real Windows Sandbox guest is not available in this test.",
      code: "SANDBOX_NOT_READY",
      status: { state: "NOT_ATTESTED", valid: false, reason: "not ready" },
    }),
  };
  const env = await setupAuthenticatedServer({
    sandboxAttestation: fakeAttestation as any,
    intakeStatus: () => ({
      enabled: false,
      running: intakeRunning,
      dispatcherReady: true,
      repositories: ["test-owner/control-center-test"],
      reason: null,
    }),
  });
  try {
    updateBridgeConfig(env.root, (current) => ({
      ...current,
      ghEnabled: true,
      kiloEnabled: true,
      githubIntakeAllowedRepositories: ["test-owner/control-center-test"],
      workerEnabled: false,
      githubIntakeEnabled: false,
      sandboxExecutionEnabled: false,
    }));

    const origin = new URL(env.baseUrl).origin;
    const headers = {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: env.cookie,
      "X-CSRF-Token": env.csrfToken,
    };
    const post = async (body: Record<string, unknown>) => fetch(env.baseUrl + "api/settings", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const blocked = await post({ sandboxExecutionEnabled: true });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as any).code, "SANDBOX_ATTESTATION_REQUIRED");
    assert.equal(ensureBridgeConfig(env.root).sandboxExecutionEnabled, false);

    attestationValid = true;
    const bundledRuntimeChange = await post({
      sandboxExecutionEnabled: true,
      sandboxProviderModelId: "changed-model",
    });
    assert.equal(bundledRuntimeChange.status, 409);
    assert.equal((await bundledRuntimeChange.json() as any).code, "RUNTIME_SETTINGS_REQUIRE_GATES_OFF");
    assert.equal(ensureBridgeConfig(env.root).sandboxExecutionEnabled, false);
    assert.notEqual(ensureBridgeConfig(env.root).sandboxProviderModelId, "changed-model");

    const sandbox = await post({ sandboxExecutionEnabled: true });
    assert.equal(sandbox.status, 200);
    assert.equal(ensureBridgeConfig(env.root).sandboxExecutionEnabled, true);
    assert.equal(ensureBridgeConfig(env.root).githubIntakeEnabled, false);

    const runtimeChangeWhileEnabled = await post({ sandboxProviderModelId: "changed-model" });
    assert.equal(runtimeChangeWhileEnabled.status, 409);
    assert.equal((await runtimeChangeWhileEnabled.json() as any).code, "RUNTIME_SETTINGS_REQUIRE_GATES_OFF");
    assert.notEqual(ensureBridgeConfig(env.root).sandboxProviderModelId, "changed-model");

    const sameRequest = await post({ sandboxExecutionEnabled: true, githubIntakeEnabled: true });
    assert.equal(sameRequest.status, 409);
    assert.equal((await sameRequest.json() as any).code, "SANDBOX_GATE_MUST_ALREADY_BE_ENABLED");

    const intake = await post({ githubIntakeEnabled: true });
    assert.equal(intake.status, 200);
    assert.equal(ensureBridgeConfig(env.root).githubIntakeEnabled, true);

    const reverseOrderBypass = await post({ sandboxExecutionEnabled: false, githubIntakeEnabled: true });
    assert.equal(reverseOrderBypass.status, 409);
    assert.equal((await reverseOrderBypass.json() as any).code, "SANDBOX_GATE_MUST_ALREADY_BE_ENABLED");
    assert.equal(ensureBridgeConfig(env.root).sandboxExecutionEnabled, true);
    assert.equal(ensureBridgeConfig(env.root).githubIntakeEnabled, true);

    const genericWorker = await post({ workerEnabled: true });
    assert.equal(genericWorker.status, 409);
    assert.equal(ensureBridgeConfig(env.root).workerEnabled, false);

    const disableSandboxFirst = await post({ sandboxExecutionEnabled: false });
    assert.equal(disableSandboxFirst.status, 409);

    const disableBoth = await post({ githubIntakeEnabled: false, sandboxExecutionEnabled: false });
    assert.equal(disableBoth.status, 200);
    assert.equal(ensureBridgeConfig(env.root).githubIntakeEnabled, false);
    assert.equal(ensureBridgeConfig(env.root).sandboxExecutionEnabled, false);
    assert.equal(ensureBridgeConfig(env.root).workerEnabled, false);
  } finally {
    await env.cleanup();
  }
});

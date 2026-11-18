"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { KiloBridgeApp } from "../src/app";
import { SqliteStore } from "../src/db";
import { Logger } from "../src/components/logging";
import { ProjectRegistry } from "../src/components/registry";
import {
  detectIsolationCapabilities,
  hasOsLevelIsolation,
  selectIsolationBackend,
} from "../src/components/isolation";
import {
  REQUIRED_NATIVE_TOOL_PERMISSIONS,
  SUPPORTED_NATIVE_TOOL_PERMISSIONS,
  UNSUPPORTED_NATIVE_TOOL_PERMISSIONS,
} from "../src/types";
import { LifecycleManager } from "../src/components/lifecycle";
import { ensureBridgeConfig } from "../src/config";
import { makeTempDir, removeDir } from "./helpers/fixtures";

function makeDeps(store: SqliteStore) {
  return {
    upsertProject: (c: unknown, s: string) => store.upsertProject(c as any, s),
    getProject: (id: string) => store.getProject(id),
    listProjects: () => store.listProjects(),
    setProjectState: (id: string, s: string) => store.setProjectState(id, s),
    getSecurityPolicy: (pid: string) => store.getSecurityPolicy(pid),
    upsertSecurityPolicy: (p: unknown) => store.upsertSecurityPolicy(p as any),
  };
}

async function setupApp(): Promise<{ app: KiloBridgeApp; root: string; cleanup: () => void }> {
  const root = makeTempDir("kilo-p39-");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(bridgeRoot, { recursive: true });
  ensureBridgeConfig(bridgeRoot);

  const store = new SqliteStore(path.join(bridgeRoot, "data", "kilo-bridge.sqlite"));
  await store.open();
  const logger = new Logger({ logsDir: path.join(bridgeRoot, "logs") });
  const registry = new ProjectRegistry(makeDeps(store));

  const app = new KiloBridgeApp();
  (app as any).initialized = true;
  (app as any)._lifecycle = new LifecycleManager({
    getTask: (id: string) => store.getTask(id),
    upsertTask: (t: unknown) => store.upsertTask(t as any),
    insertTransition: (t: unknown) => store.insertTransition(t as any),
    listTasksByStatuses: (statuses: string[]) => store.listTasksByStatuses(statuses),
  });
  (app as any).ctx = { store, logger, registry, bridgeRoot };

  const cleanup = () => removeDir(root);
  return { app, root, cleanup };
}

async function doctorData(app: KiloBridgeApp): Promise<any> {
  const res = await app.doctor({ json: true });
  assert.equal(res.ok, true, res.error);
  return res.data as any;
}

// ---------------------------------------------------------------------------
// Doctor granular security states
// ---------------------------------------------------------------------------

test("phase39: doctor returns nativeToolConfigVerificationState PASS", async () => {
  const { app, cleanup } = await setupApp();
  try {
    const data = await doctorData(app);
    assert.equal(data.nativeToolConfigVerificationState, "PASS");
  } finally {
    cleanup();
  }
});

test("phase39: doctor returns nativeToolPermissionSupportState PARTIAL", async () => {
  const { app, cleanup } = await setupApp();
  try {
    const data = await doctorData(app);
    assert.equal(data.nativeToolPermissionSupportState, "PARTIAL");
  } finally {
    cleanup();
  }
});

test("phase39: doctor returns nativeToolRuntimeVerificationState NOT TESTED", async () => {
  const { app, cleanup } = await setupApp();
  try {
    const data = await doctorData(app);
    assert.equal(data.nativeToolRuntimeVerificationState, "NOT TESTED");
  } finally {
    cleanup();
  }
});

test("phase39: doctor returns isolationState granular values", async () => {
  const { app, cleanup } = await setupApp();
  try {
    const data = await doctorData(app);
    assert.deepEqual(data.isolationState, {
      filesystem: "PARTIAL",
      process: "NOT IMPLEMENTED",
      network: "NOT IMPLEMENTED",
    });
  } finally {
    cleanup();
  }
});

test("phase39: doctor returns productionExecutionReadiness BLOCKED", async () => {
  const { app, cleanup } = await setupApp();
  try {
    const data = await doctorData(app);
    assert.equal(data.productionExecutionReadiness, "BLOCKED");
  } finally {
    cleanup();
  }
});

test("phase39: doctor returns executionIsolationLevel WORKTREE_ONLY", async () => {
  const { app, cleanup } = await setupApp();
  try {
    const data = await doctorData(app);
    assert.equal(data.executionIsolationLevel, "WORKTREE_ONLY");
    assert.equal(selectIsolationBackend(), "WORKTREE_ONLY");
    assert.equal(typeof hasOsLevelIsolation(), "boolean");
  } finally {
    cleanup();
  }
});

test("phase39: detectIsolationCapabilities reports WINDOWS_SANDBOX available", async () => {
  const { app, cleanup } = await setupApp();
  try {
    const caps = detectIsolationCapabilities();
    const sandbox = caps.find((c) => c.backend === "WINDOWS_SANDBOX");
    assert.ok(sandbox, "WINDOWS_SANDBOX capability entry must exist");
    assert.equal(sandbox.available, true);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Native tool permission lists (types.ts)
// ---------------------------------------------------------------------------

test("phase39: SUPPORTED_NATIVE_TOOL_PERMISSIONS excludes write, apply_patch, external_directory", async () => {
  const { app, cleanup } = await setupApp();
  try {
    await doctorData(app);
    assert.equal(SUPPORTED_NATIVE_TOOL_PERMISSIONS.includes("write"), false);
    assert.equal(SUPPORTED_NATIVE_TOOL_PERMISSIONS.includes("apply_patch"), false);
    assert.equal(SUPPORTED_NATIVE_TOOL_PERMISSIONS.includes("external_directory"), false);
  } finally {
    cleanup();
  }
});

test("phase39: UNSUPPORTED_NATIVE_TOOL_PERMISSIONS includes write, apply_patch, external_directory", async () => {
  const { app, cleanup } = await setupApp();
  try {
    await doctorData(app);
    assert.equal(UNSUPPORTED_NATIVE_TOOL_PERMISSIONS.includes("write"), true);
    assert.equal(UNSUPPORTED_NATIVE_TOOL_PERMISSIONS.includes("apply_patch"), true);
    assert.equal(UNSUPPORTED_NATIVE_TOOL_PERMISSIONS.includes("external_directory"), true);
  } finally {
    cleanup();
  }
});

test("phase39: REQUIRED_NATIVE_TOOL_PERMISSIONS has exactly 8 entries", async () => {
  const { app, cleanup } = await setupApp();
  try {
    await doctorData(app);
    assert.equal(REQUIRED_NATIVE_TOOL_PERMISSIONS.length, 8);
  } finally {
    cleanup();
  }
});

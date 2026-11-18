"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BridgeConfigSchema } from "../src/config";
import {
  normalizeSandboxArtifactPath,
  validateSandboxTaskManifest,
  WindowsSandboxTaskRunner,
} from "../src/components/windowsSandboxTaskRunner";
import { makeTempDir, removeDir } from "./helpers/fixtures";

const EXECUTION_ID = "9ac7d7a0-1d09-4fc3-ae14-55d934ab8b4b";

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const stages = [
    "guest-bootstrap-started",
    "mapped-folders-accessible",
    "node-runtime-found",
    "kilo-launcher-found",
    "kilo-config-found",
    "provider-script-found",
    "provider-started",
    "provider-health",
    "kilo-started",
    "kilo-completed",
    "result-file-written",
  ].map((stage) => ({ stage, ok: true }));

  return {
    protocolVersion: 1,
    executionId: EXECUTION_ID,
    finalStatus: "COMPLETED",
    kiloExitCode: 0,
    kiloVersion: "7.8.27",
    stages,
    toolEvidence: [
      { name: "read", eventType: "tool_call", timestamp: new Date().toISOString() },
      { name: "edit", eventType: "tool_result", timestamp: new Date().toISOString() },
    ],
    artifacts: [
      { path: "src/example.ts", action: "modified", sha256: "a".repeat(64), size: 128 },
      { path: "src/new-file.ts", action: "added", sha256: "b".repeat(64), size: 32 },
      { path: "src/removed.ts", action: "deleted" },
    ],
    error: null,
    ...overrides,
  };
}

test("sandbox runner: accepts safe relative artifact paths and rejects path escape or sensitive locations", () => {
  assert.equal(normalizeSandboxArtifactPath("src/components/example.ts"), "src/components/example.ts");
  assert.equal(normalizeSandboxArtifactPath("docs/architecture.md"), "docs/architecture.md");
  assert.equal(normalizeSandboxArtifactPath("../outside.txt"), null);
  assert.equal(normalizeSandboxArtifactPath("src/../../outside.txt"), null);
  assert.equal(normalizeSandboxArtifactPath("C:/outside.txt"), null);
  assert.equal(normalizeSandboxArtifactPath("/outside.txt"), null);
  assert.equal(normalizeSandboxArtifactPath("src/.env"), null);
  assert.equal(normalizeSandboxArtifactPath("config/credentials.json"), null);
  assert.equal(normalizeSandboxArtifactPath("keys/server.pem"), null);
  assert.equal(normalizeSandboxArtifactPath("node_modules/pkg/index.js"), null);
  assert.equal(normalizeSandboxArtifactPath(".git/config"), null);
  assert.equal(normalizeSandboxArtifactPath("src/CON.txt"), null);
});

test("sandbox runner: validates a completed guest manifest with native tool evidence and artifact digests", () => {
  const result = validateSandboxTaskManifest(validManifest(), EXECUTION_ID);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.manifest?.executionId, EXECUTION_ID);
});

test("sandbox runner: rejects mismatched execution identity, failed stages, and incomplete native tool evidence", () => {
  const wrongId = validateSandboxTaskManifest(
    validManifest({ executionId: "00000000-0000-4000-8000-000000000000" }),
    EXECUTION_ID
  );
  assert.equal(wrongId.ok, false);
  assert.ok(wrongId.errors.some((error) => /execution id mismatch/.test(error)));

  const failedStages = (validManifest().stages as Array<Record<string, unknown>>).map((stage) =>
    stage.stage === "provider-health" ? { ...stage, ok: false } : stage
  );
  const stageResult = validateSandboxTaskManifest(validManifest({ stages: failedStages }), EXECUTION_ID);
  assert.equal(stageResult.ok, false);
  assert.ok(stageResult.errors.some((error) => /provider-health/.test(error)));

  const noEvidence = validateSandboxTaskManifest(validManifest({ toolEvidence: [] }), EXECUTION_ID);
  assert.equal(noEvidence.ok, false);
  assert.ok(noEvidence.errors.some((error) => /tool evidence missing/.test(error)));
});

test("sandbox runner: rejects unsafe, duplicated, or unhashed guest artifacts", () => {
  const unsafe = validManifest({
    artifacts: [{ path: "../outside.txt", action: "added", sha256: "a".repeat(64), size: 10 }],
  });
  const unsafeResult = validateSandboxTaskManifest(unsafe, EXECUTION_ID);
  assert.equal(unsafeResult.ok, false);
  assert.ok(unsafeResult.errors.some((error) => /unsafe artifact path/.test(error)));

  const badDigest = validManifest({
    artifacts: [{ path: "src/file.ts", action: "modified", sha256: "not-a-hash", size: 10 }],
  });
  const digestResult = validateSandboxTaskManifest(badDigest, EXECUTION_ID);
  assert.equal(digestResult.ok, false);
  assert.ok(digestResult.errors.some((error) => /hash\/size invalid/.test(error)));
});

test("sandbox runner: dedicated gate defaults off and prevents any execution staging", async () => {
  const root = makeTempDir("sandbox-runner-disabled-");
  try {
    const config = BridgeConfigSchema.parse({});
    assert.equal(config.sandboxExecutionEnabled, false);
    assert.equal(config.workerEnabled, false);
    assert.equal(config.githubIntakeEnabled, false);

    const projectRoot = path.join(root, "worktrees", "project");
    const worktree = path.join(projectRoot, "task-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, "README.md"), "test", "utf8");

    const runner = new WindowsSandboxTaskRunner({
      bridgeRoot: root,
      config,
      sandboxExePath: path.join(root, "missing", "WindowsSandbox.exe"),
    });
    const readiness = runner.readiness();
    assert.equal(readiness.ready, false);
    assert.ok(readiness.reasons.some((reason) => /sandboxExecutionEnabled is false/.test(reason)));

    const result = await runner.run(
      { id: "task-disabled", title: "Disabled task", body: "Must not execute." },
      { worktreePath: worktree, worktreeRoot: projectRoot, projectId: "sandbox-test", executionId: EXECUTION_ID }
    );
    assert.equal(result.finalStatus, "BOOT_FAILED");
    assert.ok(result.error?.includes("sandboxExecutionEnabled is false"));
    assert.equal(fs.existsSync(path.join(root, "data", "sandbox-runs")), false);
    assert.equal(fs.readFileSync(path.join(worktree, "README.md"), "utf8"), "test");
  } finally {
    removeDir(root);
  }
});

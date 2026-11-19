"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { BridgeConfigSchema } from "../src/config";
import {
  buildGuestBootstrap,
  buildGuestProviderBridge,
  buildWsb,
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
    "provider-responses-accessible",
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
  assert.equal(normalizeSandboxArtifactPath("src/file.txt:secret"), null);
  assert.equal(normalizeSandboxArtifactPath("src/trailing."), null);
  assert.equal(normalizeSandboxArtifactPath("src/trailing "), null);
  assert.equal(normalizeSandboxArtifactPath(".ssh/id_ed25519"), null);
  assert.equal(normalizeSandboxArtifactPath("project/.aws/credentials"), null);
  assert.equal(normalizeSandboxArtifactPath(".kilo-bridge-task.md"), null);
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


test("sandbox runner: WSB logon command uses the guest-mapped bootstrap path and escapes host paths once", () => {
  const hostInbox = "C:\\Bridge\\Sandbox Runs\\inbox & tools";
  const hostOutbox = "C:\\Bridge\\Sandbox Runs\\outbox";
  const hostResponses = "C:\\Bridge\\Sandbox Runs\\responses";
  const hostBootstrap = hostInbox + "\\bootstrap.ps1";
  const xml = buildWsb(hostInbox, hostOutbox, hostResponses, hostBootstrap, EXECUTION_ID, 60_000);

  assert.match(
    xml,
    /-File &quot;C:\\Users\\WDAGUtilityAccount\\Desktop\\BridgeInbox\\bootstrap\\.ps1&quot;/
  );
  assert.doesNotMatch(xml, /-File &quot;C:\\Bridge\\Sandbox Runs/);
  assert.ok(xml.includes('<HostFolder>C:\\Bridge\\Sandbox Runs\\inbox &amp; tools</HostFolder>'));
  assert.doesNotMatch(xml, /&amp;amp;/);
  assert.ok(xml.includes('<HostFolder>C:\\Bridge\\Sandbox Runs\\responses</HostFolder><SandboxFolder>C:\\Users\\WDAGUtilityAccount\\Desktop\\BridgeProviderResponses</SandboxFolder><ReadOnly>true</ReadOnly>'));
  assert.throws(
    () => buildWsb(hostInbox, hostOutbox, hostResponses, hostInbox + "\\wrong.ps1", EXECUTION_ID, 60_000),
    /bootstrap\.ps1/
  );
});

test("sandbox runner: generated provider relay is valid JavaScript and exposes only the expected protocol", () => {
  const source = buildGuestProviderBridge();
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /RESPONSE_BOX=process\.argv\[3\]/);
  assert.match(source, /path\.join\(RESPONSE_BOX,/);
  assert.doesNotMatch(source, /path\.join\(OUTBOX,"provider-response-/);
  assert.match(source, /\/health/);
  assert.match(source, /\/v1\/models/);
  assert.match(source, /\/v1\/chat\/completions/);
  assert.match(source, /127\.0\.0\.1/);
  assert.doesNotMatch(source, /0\.0\.0\.0/);
});

test("sandbox runner: generated guest bootstrap parses and WSB XML preserves network isolation on Windows", {
  skip: process.platform !== "win32",
}, () => {
  const root = makeTempDir("sandbox-generated-scripts-");
  try {
    const bootstrapPath = path.join(root, "bootstrap.ps1");
    const wsbPath = path.join(root, "execution.wsb");
    const validatorPath = path.join(root, "validate-generated.ps1");
    const executionId = EXECUTION_ID;
    fs.writeFileSync(bootstrapPath, buildGuestBootstrap(), "utf8");
    fs.writeFileSync(
      wsbPath,
      buildWsb(
        "C:\\Bridge\\Sandbox Runs\\inbox & tools",
        "C:\\Bridge\\Sandbox Runs\\outbox",
        "C:\\Bridge\\Sandbox Runs\\provider-responses",
        "C:\\Bridge\\Sandbox Runs\\inbox & tools\\bootstrap.ps1",
        executionId,
        60_000
      ),
      "utf8"
    );
    fs.writeFileSync(validatorPath, String.raw`param([string]$BootstrapPath,[string]$WsbPath)
$ErrorActionPreference = "Stop"
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($BootstrapPath,[ref]$tokens,[ref]$errors) | Out-Null
if ($errors.Count -gt 0) {
  $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }
  exit 11
}
[xml]$doc = Get-Content -LiteralPath $WsbPath -Raw
if ($doc.Configuration.Networking -ne "Disable") { exit 12 }
$folders = @($doc.Configuration.MappedFolders.MappedFolder)
if ($folders.Count -ne 3) { exit 13 }
if ($folders[0].ReadOnly -ne "true" -or $folders[1].ReadOnly -ne "false" -or $folders[2].ReadOnly -ne "true") { exit 14 }
if ($doc.Configuration.LogonCommand.Command -notmatch '-File "C:\\Users\\WDAGUtilityAccount\\Desktop\\BridgeInbox\\bootstrap.ps1"') { exit 15 }
if ($doc.Configuration.LogonCommand.Command -notmatch '-ResponseBox "C:\\Users\\WDAGUtilityAccount\\Desktop\\BridgeProviderResponses"') { exit 16 }
exit 0
`, "utf8");

    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", validatorPath, bootstrapPath, wsbPath],
      { encoding: "utf8", windowsHide: true, timeout: 20_000 }
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + "\\n" + result.stderr);
  } finally {
    removeDir(root);
  }
});

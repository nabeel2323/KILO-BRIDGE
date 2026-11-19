"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { ensureBridgeConfig, updateBridgeConfig } from "../src/config";
import { SqliteStore } from "../src/db";
import { ExclusiveProcessLock } from "../src/components/processLock";
import {
  SandboxRuntimeAttestationService,
} from "../src/components/sandboxRuntimeAttestation";
import type { SandboxRuntimeIdentity } from "../src/components/windowsSandboxTaskRunner";
import type { SandboxTaskRunResult } from "../src/components/windowsSandboxTaskRunner";
import { makeTempDir, removeDir } from "./helpers/fixtures";

const MARKER = "KILO_BRIDGE_RUNTIME_ATTESTATION.txt";

function makeIdentity(overrides: Partial<SandboxRuntimeIdentity> = {}): SandboxRuntimeIdentity {
  const base = {
    kiloExecutableName: "kilo.exe",
    kiloExecutableSha256: "a".repeat(64),
    kiloVersion: "7.8.27",
    sandboxExecutableSha256: "b".repeat(64),
    sandboxVersion: "10.0.26100.1",
    providerBaseUrlSha256: "c".repeat(64),
    providerModelId: "test-model",
    apiKeyEnvironmentName: "KILO_TEST_PROVIDER_KEY",
    apiKeyPresent: true,
    apiKeyHeader: "Authorization",
    apiKeyPrefixSha256: "d".repeat(64),
    runnerContractSha256: "e".repeat(64),
    operatingSystem: "win32",
    operatingSystemRelease: "10.0.26100",
    nodeVersion: "v22.14.0",
    architecture: "x64",
  };
  const value = { ...base, ...overrides };
  return {
    ...value,
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
}

function createFakeRunner(options: {
  root: string;
  identity: () => SandboxRuntimeIdentity;
  providerRequests?: number;
  omitWriteEvidence?: boolean;
  wrongMarker?: boolean;
  cleanup?: "complete" | "failed";
  mutateConfigDuringRun?: (root: string) => void;
}): {
  readiness(): { ready: boolean; reasons: string[] };
  runtimeIdentity(): SandboxRuntimeIdentity;
  run(
    task: { id: string; title: string; body: string },
    opts: { worktreePath: string; worktreeRoot: string; projectId: string; timeoutMs?: number; executionId?: string }
  ): Promise<SandboxTaskRunResult>;
} {
  return {
    readiness: () => ({ ready: true, reasons: [] }),
    runtimeIdentity: options.identity,
    async run(task, opts) {
      const executionId = opts.executionId ?? "";
      const nonce = /nonce=([A-Za-z0-9_-]+)/.exec(task.body)?.[1] ?? "";
      const expected = [
        "KILO BRIDGE WINDOWS SANDBOX RUNTIME ATTESTATION",
        "executionId=" + executionId,
        "nonce=" + nonce,
        "",
      ].join("\n");
      const marker = options.wrongMarker ? expected + "tampered\n" : expected;
      fs.writeFileSync(path.join(opts.worktreePath, MARKER), marker, { encoding: "utf8", flag: "wx" });
      const markerBytes = Buffer.from(marker, "utf8");
      const digest = crypto.createHash("sha256").update(markerBytes).digest("hex");
      const evidenceDirectory = path.join(options.root, "data", "sandbox-evidence");
      fs.mkdirSync(evidenceDirectory, { recursive: true });
      const evidencePath = path.join(evidenceDirectory, executionId + ".json");
      fs.writeFileSync(evidencePath, JSON.stringify({
        executionId,
        finalStatus: "COMPLETED",
        stages: [{ stage: "kilo-completed", ok: true }],
        toolEvidence: [{ name: "write", eventType: "tool_call" }],
        artifacts: [{ path: MARKER, action: "added", sha256: digest, size: markerBytes.length }],
      }), "utf8");

      options.mutateConfigDuringRun?.(options.root);
      const providerRequests = options.providerRequests ?? 2;
      const toolEvidence = options.omitWriteEvidence
        ? [{ name: "read", eventType: "tool_call" }]
        : [{ name: "write", eventType: "tool_call" }];
      return {
        executionId,
        finalStatus: "COMPLETED",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 20,
        kiloExitCode: 0,
        kiloVersion: "7.8.27",
        model: "bridge-relay/bridge-model",
        agent: "build",
        providerRequests,
        toolEvidence,
        artifacts: [{ path: MARKER, action: "added", sha256: digest, size: markerBytes.length }],
        importedFiles: [MARKER],
        error: null,
        cleanup: options.cleanup ?? "complete",
        evidencePath,
      };
    },
  };
}

async function createService(options: {
  root: string;
  store: SqliteStore;
  identity: () => SandboxRuntimeIdentity;
  providerRequests?: number;
  omitWriteEvidence?: boolean;
  wrongMarker?: boolean;
  cleanup?: "complete" | "failed";
  isIntakeRunning?: () => boolean;
  mutateConfigDuringRun?: (root: string) => void;
}) {
  const runner = createFakeRunner(options);
  return new SandboxRuntimeAttestationService({
    bridgeRoot: options.root,
    store: options.store,
    getConfig: () => ensureBridgeConfig(options.root),
    isIntakeRunning: options.isIntakeRunning,
    runnerFactory: () => runner,
  });
}

async function waitForTerminal(service: SandboxRuntimeAttestationService) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = service.status();
    if (status.state !== "RUNNING") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Sandbox attestation test did not reach a terminal state");
}

async function openEnvironment() {
  const root = makeTempDir("sandbox-attestation-");
  ensureBridgeConfig(root);
  const store = new SqliteStore(path.join(root, "data", "test.sqlite"));
  await store.open();
  return {
    root,
    store,
    cleanup() {
      store.close();
      removeDir(root);
    },
  };
}

test("Sandbox attestation: successful disposable write creates a signed 24-hour attestation without changing execution gates", async () => {
  const env = await openEnvironment();
  try {
    const identity = makeIdentity();
    const service = await createService({ root: env.root, store: env.store, identity: () => identity });
    const start = service.startVerification();
    assert.equal(start.ok, true);
    assert.equal(start.status.state, "RUNNING");

    const status = await waitForTerminal(service);
    assert.equal(status.state, "VALID");
    assert.equal(status.valid, true);
    assert.equal(status.verifiedTool, "write");
    assert.equal(status.providerRequests, 2);
    assert.equal(status.kiloVersion, "7.8.27");
    assert.ok(status.attestedAt);
    assert.ok(status.expiresAt);
    assert.ok(Date.parse(status.expiresAt!) - Date.parse(status.attestedAt!) <= 24 * 60 * 60 * 1000 + 1000);

    const config = ensureBridgeConfig(env.root);
    assert.equal(config.workerEnabled, false);
    assert.equal(config.githubIntakeEnabled, false);
    assert.equal(config.sandboxExecutionEnabled, false);
    const signedPath = path.join(env.root, "data", "sandbox-runtime-attestation.json");
    const keyPath = path.join(env.root, "data", "sandbox-runtime-attestation.key");
    assert.ok(fs.existsSync(signedPath));
    assert.equal(fs.statSync(keyPath).size, 32);
    const signedText = fs.readFileSync(signedPath, "utf8");
    assert.equal(signedText.includes("nonce="), false);
    assert.equal(signedText.includes("KILO BRIDGE WINDOWS SANDBOX RUNTIME ATTESTATION"), false);
    assert.ok(env.store.listAudit().some((event) => event.action === "control_center.sandbox_runtime_attested"));
    assert.equal(fs.readdirSync(path.join(env.root, "data", "sandbox-runtime-verification")).length, 0);
    const repeated = service.startVerification();
    assert.equal(repeated.ok, false);
    assert.equal(repeated.code, "SANDBOX_ATTESTATION_ALREADY_VALID");
  } finally {
    env.cleanup();
  }
});

test("Sandbox attestation: failed evidence never signs an attestation and reports FAILED", async () => {
  const env = await openEnvironment();
  try {
    const service = await createService({
      root: env.root,
      store: env.store,
      identity: () => makeIdentity(),
      providerRequests: 0,
    });
    assert.equal(service.startVerification().ok, true);
    const status = await waitForTerminal(service);
    assert.equal(status.state, "FAILED");
    assert.equal(status.valid, false);
    assert.match(status.reason || "", /provider request/i);
    assert.equal(fs.existsSync(path.join(env.root, "data", "sandbox-runtime-attestation.json")), false);
    assert.equal(fs.readdirSync(path.join(env.root, "data", "sandbox-runtime-verification")).length, 0);
  } finally {
    env.cleanup();
  }
});

test("Sandbox attestation: native write evidence, exact marker content and runner cleanup are mandatory", async () => {
  for (const failure of [
    { omitWriteEvidence: true },
    { wrongMarker: true },
    { cleanup: "failed" as const },
  ]) {
    const env = await openEnvironment();
    try {
      const service = await createService({
        root: env.root,
        store: env.store,
        identity: () => makeIdentity(),
        ...failure,
      });
      assert.equal(service.startVerification().ok, true);
      const status = await waitForTerminal(service);
      assert.equal(status.state, "FAILED");
      assert.equal(status.valid, false);
      assert.equal(fs.existsSync(path.join(env.root, "data", "sandbox-runtime-attestation.json")), false);
      assert.equal(fs.readdirSync(path.join(env.root, "data", "sandbox-runtime-verification")).length, 0);
    } finally {
      env.cleanup();
    }
  }
});

test("Sandbox attestation: refuses verification while any autonomous gate is enabled or intake is running", async () => {
  const env = await openEnvironment();
  try {
    const baseline = ensureBridgeConfig(env.root);
    updateBridgeConfig(env.root, (current) => ({ ...current, sandboxExecutionEnabled: true }));
    const gateOn = new SandboxRuntimeAttestationService({
      bridgeRoot: env.root,
      store: env.store,
      getConfig: () => ensureBridgeConfig(env.root),
      runnerFactory: () => createFakeRunner({ root: env.root, identity: () => makeIdentity() }),
    });
    const blocked = gateOn.startVerification();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "AUTOMATION_MUST_BE_DISABLED");

    updateBridgeConfig(env.root, (current) => ({ ...current, sandboxExecutionEnabled: false }));
    const intakeRunning = new SandboxRuntimeAttestationService({
      bridgeRoot: env.root,
      store: env.store,
      getConfig: () => baseline,
      isIntakeRunning: () => true,
      runnerFactory: () => createFakeRunner({ root: env.root, identity: () => makeIdentity() }),
    });
    const running = intakeRunning.startVerification();
    assert.equal(running.ok, false);
    assert.equal(running.code, "INTAKE_IS_RUNNING");
  } finally {
    env.cleanup();
  }
});

test("Sandbox attestation: runtime identity changes and signed-file tampering invalidate the attestation", async () => {
  const env = await openEnvironment();
  try {
    let identity = makeIdentity();
    const service = await createService({ root: env.root, store: env.store, identity: () => identity });
    assert.equal(service.startVerification().ok, true);
    assert.equal((await waitForTerminal(service)).state, "VALID");

    identity = makeIdentity({ kiloExecutableSha256: "f".repeat(64) });
    const changed = service.status();
    assert.equal(changed.state, "NEEDS_RETEST");
    assert.equal(changed.valid, false);
    assert.match(changed.reason || "", /changed/i);

    identity = makeIdentity();
    const file = path.join(env.root, "data", "sandbox-runtime-attestation.json");
    const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
    tampered.payload.evidence.providerRequests = 0;
    fs.writeFileSync(file, JSON.stringify(tampered), "utf8");
    const invalid = service.status();
    assert.equal(invalid.state, "NEEDS_RETEST");
    assert.equal(invalid.valid, false);
    assert.match(invalid.reason || "", /integrity/i);
  } finally {
    env.cleanup();
  }
});

test("Sandbox attestation: a separate Bridge process holding the intake poll lock blocks verification", async () => {
  const env = await openEnvironment();
  const lockPath = path.join(env.root, "data", "github-intake.lock");
  const lockModulePath = path.resolve(__dirname, "../src/components/processLock.js");
  const childProgram = [
    'const { ExclusiveProcessLock } = require(process.argv[1]);',
    'const lock = new ExclusiveProcessLock(process.argv[2], "github-intake:child-process");',
    'const result = lock.acquire();',
    'if (!result.ok) { process.stderr.write(result.error || "lock failed"); process.exit(2); }',
    'process.stdout.write("LOCKED\\n");',
    'process.stdin.once("data", () => { lock.release(); process.exit(0); });',
  ].join("\\n");
  const child = spawn(process.execPath, ["-e", childProgram, lockModulePath, lockPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let childError = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { childError += chunk; });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error("intake-lock child exited before readiness (" + code + "): " + childError)));
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("LOCKED")) resolve();
      });
    });

    const service = await createService({
      root: env.root,
      store: env.store,
      identity: () => makeIdentity(),
    });
    const blocked = service.startVerification();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "INTAKE_IS_RUNNING");
    assert.equal(fs.existsSync(path.join(env.root, "data", "sandbox-runtime-verification")), false);
    assert.equal(ensureBridgeConfig(env.root).workerEnabled, false);
    assert.equal(ensureBridgeConfig(env.root).githubIntakeEnabled, false);
    assert.equal(ensureBridgeConfig(env.root).sandboxExecutionEnabled, false);

    child.stdin.write("release\n");
    const childExit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    assert.equal(childExit, 0, childError);

    const started = service.startVerification();
    assert.equal(started.ok, true);
    const status = await waitForTerminal(service);
    assert.equal(status.state, "VALID");
  } finally {
    try { child.stdin.write("release\n"); } catch { /* child may already have exited */ }
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    }
    env.cleanup();
  }
});


test("Sandbox attestation: a persistent execution gate changed during the guest run prevents signing", async () => {
  const env = await openEnvironment();
  try {
    const service = await createService({
      root: env.root,
      store: env.store,
      identity: () => makeIdentity(),
      mutateConfigDuringRun: (root) => {
        // Simulate an out-of-band manual edit that bypasses the shared config lock.
        const current = ensureBridgeConfig(root);
        fs.writeFileSync(
          path.join(root, "bridge.config.json"),
          JSON.stringify({ ...current, sandboxExecutionEnabled: true }, null, 2),
          "utf8"
        );
      },
    });
    assert.equal(service.startVerification().ok, true);
    const status = await waitForTerminal(service);
    assert.equal(status.state, "FAILED");
    assert.equal(status.valid, false);
    assert.match(status.reason || "", /execution gate changed/i);
    assert.equal(fs.existsSync(path.join(env.root, "data", "sandbox-runtime-attestation.json")), false);
    assert.equal(fs.readdirSync(path.join(env.root, "data", "sandbox-runtime-verification")).length, 0);
  } finally {
    env.cleanup();
  }
});

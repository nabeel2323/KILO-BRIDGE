"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BridgeConfigSchema, type BridgeConfig } from "../config";
import type { SqliteStore } from "../db";
import { ExclusiveProcessLock } from "./processLock";
import {
  WindowsSandboxTaskRunner,
  type SandboxRuntimeIdentity,
  type SandboxTaskRunResult,
} from "./windowsSandboxTaskRunner";

const ATTESTATION_VERSION = 1;
const ATTESTATION_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;
const MARKER_NAME = "KILO_BRIDGE_RUNTIME_ATTESTATION.txt";
const MAX_ATTESTATION_BYTES = 32 * 1024;

export type SandboxAttestationState =
  | "NOT_ATTESTED"
  | "RUNNING"
  | "VALID"
  | "EXPIRED"
  | "NEEDS_RETEST"
  | "FAILED";

export interface SandboxAttestationStatus {
  state: SandboxAttestationState;
  valid: boolean;
  reason: string | null;
  startedAt?: string;
  attestedAt?: string;
  expiresAt?: string;
  executionId?: string;
  kiloVersion?: string;
  sandboxVersion?: string;
  providerModelId?: string;
  providerApiKeyEnvironmentName?: string;
  providerApiKeyPresent?: boolean;
  providerRequests?: number;
  verifiedTool?: string;
  markerSha256?: string;
}

interface AttestationEvidence {
  providerRequests: number;
  toolName: string;
  markerSha256: string;
  markerSize: number;
  runnerEvidenceSha256: string;
}

interface AttestationPayload {
  version: number;
  executionId: string;
  attestedAt: string;
  expiresAt: string;
  runtimeIdentity: SandboxRuntimeIdentity;
  evidence: AttestationEvidence;
}

interface SignedAttestation {
  version: number;
  payload: AttestationPayload;
  signature: string;
}

interface SandboxRunner {
  readiness(): { ready: boolean; reasons: string[] };
  runtimeIdentity(): SandboxRuntimeIdentity;
  run(
    task: { id: string; title: string; body: string },
    opts: {
      worktreePath: string;
      worktreeRoot: string;
      projectId: string;
      timeoutMs?: number;
      executionId?: string;
    }
  ): Promise<SandboxTaskRunResult>;
}

export interface SandboxRuntimeAttestationOptions {
  bridgeRoot: string;
  store: SqliteStore;
  getConfig: () => BridgeConfig;
  isIntakeRunning?: () => boolean;
  runnerFactory?: (config: BridgeConfig) => SandboxRunner;
  lockFactory?: (lockPath: string, owner: string) => ExclusiveProcessLock;
}

function sha256(value: Uint8Array | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalize(object[key])
  ).join(",") + "}";
}

function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/ig, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/ig, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .slice(0, 600);
}

function isRegularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function atomicWrite(file: string, bytes: Uint8Array | string): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
  }
}

export class SandboxRuntimeAttestationService {
  private readonly bridgeRoot: string;
  private readonly dataRoot: string;
  private readonly attestationPath: string;
  private readonly keyPath: string;
  private readonly store: SqliteStore;
  private readonly getConfig: () => BridgeConfig;
  private readonly isIntakeRunning: () => boolean;
  private readonly runnerFactory: (config: BridgeConfig) => SandboxRunner;
  private readonly lock: ExclusiveProcessLock;
  private runState: { state: "RUNNING" | "FAILED"; startedAt: string; reason?: string } | null = null;

  constructor(options: SandboxRuntimeAttestationOptions) {
    this.bridgeRoot = path.resolve(options.bridgeRoot);
    this.dataRoot = path.join(this.bridgeRoot, "data");
    this.attestationPath = path.join(this.dataRoot, "sandbox-runtime-attestation.json");
    this.keyPath = path.join(this.dataRoot, "sandbox-runtime-attestation.key");
    this.store = options.store;
    this.getConfig = options.getConfig;
    this.isIntakeRunning = options.isIntakeRunning ?? (() => false);
    this.runnerFactory = options.runnerFactory ??
      ((config) => new WindowsSandboxTaskRunner({ bridgeRoot: this.bridgeRoot, config }));
    this.lock = options.lockFactory
      ? options.lockFactory(
          path.join(this.dataRoot, "sandbox-runtime-attestation.lock"),
          "sandbox-runtime-attestation:" + process.pid
        )
      : new ExclusiveProcessLock(
          path.join(this.dataRoot, "sandbox-runtime-attestation.lock"),
          "sandbox-runtime-attestation:" + process.pid
        );
  }

  status(): SandboxAttestationStatus {
    if (this.runState?.state === "RUNNING") {
      return {
        state: "RUNNING",
        valid: false,
        reason: "The one-time disposable Sandbox verification is running.",
        startedAt: this.runState.startedAt,
      };
    }
    const stored = this.readSignedAttestation();
    if (!stored.ok) {
      if (stored.missing && this.runState?.state === "FAILED") {
        return {
          state: "FAILED",
          valid: false,
          reason: this.runState.reason ?? "The most recent Sandbox runtime verification failed.",
          startedAt: this.runState.startedAt,
        };
      }
      return {
        state: stored.missing ? "NOT_ATTESTED" : "NEEDS_RETEST",
        valid: false,
        reason: stored.reason,
      };
    }

    const payload = stored.payload!;
    const metadata = this.safePayloadStatus(payload);
    if (Date.parse(payload.expiresAt) <= Date.now()) {
      return { ...metadata, state: "EXPIRED", valid: false, reason: "The Sandbox runtime attestation has expired." };
    }

    try {
      const config = this.temporaryRunnerConfig(this.getConfig());
      const runner = this.runnerFactory(config);
      const readiness = runner.readiness();
      if (!readiness.ready) {
        return {
          ...metadata,
          state: "NEEDS_RETEST",
          valid: false,
          reason: readiness.reasons.slice(0, 5).join("; ") || "Sandbox runtime is not ready.",
        };
      }
      const currentIdentity = runner.runtimeIdentity();
      if (currentIdentity.fingerprint !== payload.runtimeIdentity.fingerprint) {
        return {
          ...metadata,
          state: "NEEDS_RETEST",
          valid: false,
          reason: "A bound runtime component or provider setting changed since the last successful verification.",
        };
      }
    } catch (error) {
      return {
        ...metadata,
        state: "NEEDS_RETEST",
        valid: false,
        reason: safeReason(error),
      };
    }
    return { ...metadata, state: "VALID", valid: true, reason: null };
  }

  startVerification(): { ok: boolean; code?: string; error?: string; status: SandboxAttestationStatus } {
    if (this.runState?.state === "RUNNING" || this.lock.isHeldByThisInstance()) {
      return { ok: false, code: "SANDBOX_ATTESTATION_RUNNING", error: "A Sandbox runtime verification is already running.", status: this.status() };
    }
    let config: BridgeConfig;
    try {
      config = this.getConfig();
    } catch {
      return { ok: false, code: "SANDBOX_CONFIG_UNAVAILABLE", error: "Bridge configuration is unavailable.", status: this.status() };
    }
    if (config.workerEnabled || config.githubIntakeEnabled || config.sandboxExecutionEnabled) {
      return {
        ok: false,
        code: "AUTOMATION_MUST_BE_DISABLED",
        error: "Turn off the generic worker, GitHub intake, and Sandbox execution gates before running the one-time verification.",
        status: this.status(),
      };
    }
    if (this.isIntakeRunning()) {
      return { ok: false, code: "INTAKE_IS_RUNNING", error: "Stop GitHub intake before running runtime verification.", status: this.status() };
    }

    const acquired = this.lock.acquire();
    if (!acquired.ok) {
      return {
        ok: false,
        code: acquired.code ?? "SANDBOX_ATTESTATION_LOCKED",
        error: acquired.error ?? "Another process is running Sandbox runtime verification.",
        status: this.status(),
      };
    }

    const startedAt = new Date().toISOString();
    this.runState = { state: "RUNNING", startedAt };
    void this.executeVerification(config, startedAt).catch((error) => {
      this.runState = { state: "FAILED", startedAt, reason: safeReason(error) };
    }).finally(() => {
      this.lock.release();
    });
    return {
      ok: true,
      status: { state: "RUNNING", valid: false, reason: "The one-time disposable Sandbox verification is running.", startedAt },
    };
  }

  private temporaryRunnerConfig(config: BridgeConfig): BridgeConfig {
    // The one-time verification uses an in-memory override only. It never
    // changes bridge.config.json and refuses to run if any autonomous gate is on.
    return BridgeConfigSchema.parse({
      ...config,
      workerEnabled: false,
      githubIntakeEnabled: false,
      sandboxExecutionEnabled: true,
    });
  }

  private async executeVerification(config: BridgeConfig, startedAt: string): Promise<void> {
    const executionId = crypto.randomUUID();
    const temporaryConfig = this.temporaryRunnerConfig(config);
    const runner = this.runnerFactory(temporaryConfig);
    const readiness = runner.readiness();
    if (!readiness.ready) {
      throw new Error(readiness.reasons.slice(0, 8).join("; ") || "Windows Sandbox runtime is not ready.");
    }
    const identityBefore = runner.runtimeIdentity();

    const verificationRoot = path.join(this.dataRoot, "sandbox-runtime-verification");
    const runRoot = path.join(verificationRoot, executionId);
    const worktree = path.join(runRoot, "workspace");
    let cleanupOk = false;
    let createdVerificationRoot = false;
    let result: SandboxTaskRunResult | null = null;
    let evidenceHash = "";
    let markerHash = "";
    let markerContents = "";
    let runnerEvidencePath: string | null = null;

    try {
      fs.mkdirSync(verificationRoot, { recursive: true });
      if (fs.existsSync(runRoot)) throw new Error("Sandbox verification directory already exists");
      fs.mkdirSync(runRoot, { recursive: false, mode: 0o700 });
      createdVerificationRoot = true;
      fs.mkdirSync(worktree, { recursive: false, mode: 0o700 });

      const nonce = crypto.randomBytes(24).toString("base64url");
      markerContents = [
        "KILO BRIDGE WINDOWS SANDBOX RUNTIME ATTESTATION",
        "executionId=" + executionId,
        "nonce=" + nonce,
        "",
      ].join("\n");
      const taskBody = [
        "This is a one-time runtime attestation task in a disposable empty workspace owned by Kilo Bridge.",
        "Use Kilo's native write tool (not bash, shell, terminal, or an external process) to create exactly one file at the workspace root:",
        MARKER_NAME,
        "The file contents must match these lines exactly, including the execution identifier and nonce:",
        "KILO BRIDGE WINDOWS SANDBOX RUNTIME ATTESTATION",
        "executionId=" + executionId,
        "nonce=" + nonce,
        "Do not create or modify any other files. Do not use bash. Do not access a repository, network endpoint, path outside the workspace, credential, or environment variable.",
        "This is verification only. Do not commit, push, merge, publish, deploy, migrate, or contact GitHub.",
      ].join("\n");

      result = await runner.run(
        {
          id: "sandbox-runtime-verification-" + executionId,
          title: "Kilo Bridge one-time Sandbox runtime verification",
          body: taskBody,
        },
        {
          worktreePath: worktree,
          worktreeRoot: runRoot,
          projectId: "sandbox-runtime-verification",
          timeoutMs: Math.min(Math.max(config.defaultTaskTimeoutMs, 30_000), VERIFICATION_TIMEOUT_MS),
          executionId,
        }
      );

      if (result.executionId !== executionId) throw new Error("Sandbox runner returned a mismatched execution identifier");
      if (result.finalStatus !== "COMPLETED") throw new Error("Sandbox guest did not complete successfully: " + (result.error ?? result.finalStatus));
      if (result.kiloExitCode !== 0) throw new Error("Kilo did not return exit code zero");
      if (result.cleanup !== "complete") throw new Error("Sandbox runner cleanup was incomplete");
      if (result.providerRequests < 1) throw new Error("No upstream provider request was observed");
      const writeEvent = result.toolEvidence.find((item) =>
        item.name.trim().toLowerCase() === "write" && /tool/i.test(item.eventType)
      );
      if (!writeEvent) throw new Error("No native Kilo write-tool event was recorded");

      const markerPath = path.join(worktree, MARKER_NAME);
      if (!isRegularFile(markerPath)) throw new Error("The expected marker file was not created as a regular file");
      const markerBytes = fs.readFileSync(markerPath);
      if (markerBytes.toString("utf8") !== markerContents) throw new Error("The marker file content did not match the execution-specific challenge");
      markerHash = sha256(markerBytes);

      if (result.artifacts.length !== 1) throw new Error("The guest returned unexpected artifact count; exactly one marker file is required");
      const artifact = result.artifacts[0];
      if (artifact.path !== MARKER_NAME || artifact.action !== "added" ||
          artifact.sha256 !== markerHash || artifact.size !== markerBytes.length) {
        throw new Error("The guest artifact manifest does not match the verified marker file");
      }
      if (result.importedFiles.length !== 1 || result.importedFiles[0] !== MARKER_NAME) {
        throw new Error("The host did not import exactly the expected marker artifact");
      }
      if (!result.evidencePath || !isRegularFile(result.evidencePath)) {
        throw new Error("The runner's bounded operational evidence file is missing");
      }
      const evidenceDirectory = path.resolve(this.dataRoot, "sandbox-evidence");
      const evidenceRelative = path.relative(evidenceDirectory, path.resolve(result.evidencePath));
      if (evidenceRelative === "" || evidenceRelative.startsWith("..") || path.isAbsolute(evidenceRelative)) {
        throw new Error("The runner evidence file is outside the Bridge evidence directory");
      }
      runnerEvidencePath = path.resolve(result.evidencePath);
      evidenceHash = sha256(fs.readFileSync(runnerEvidencePath));

      const identityAfter = runner.runtimeIdentity();
      if (identityAfter.fingerprint !== identityBefore.fingerprint) {
        throw new Error("A runtime component changed during the verification; attestation is not valid");
      }
    } finally {
      if (createdVerificationRoot) {
        try {
          if (fs.existsSync(runRoot)) fs.rmSync(runRoot, { recursive: true, force: true });
          cleanupOk = !fs.existsSync(runRoot);
        } catch {
          cleanupOk = false;
        }
      } else {
        cleanupOk = true;
      }
    }

    const runnerRunRoot = path.join(this.dataRoot, "sandbox-runs", executionId);
    if (fs.existsSync(runnerRunRoot)) {
      try { fs.rmSync(runnerRunRoot, { recursive: true, force: true }); } catch { /* runner cleanup is independently checked below */ }
    }
    if (!cleanupOk) throw new Error("Disposable Sandbox verification workspace cleanup failed");
    if (fs.existsSync(runnerRunRoot)) throw new Error("Sandbox runner staging directory cleanup failed");
    if (!result || result.cleanup !== "complete") throw new Error("Sandbox execution cleanup was not confirmed");
    if (!runnerEvidencePath || !isRegularFile(runnerEvidencePath) ||
        sha256(fs.readFileSync(runnerEvidencePath)) !== evidenceHash) {
      throw new Error("Sandbox operational evidence disappeared or changed during workspace cleanup");
    }

    const attestedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ATTESTATION_TTL_MS).toISOString();
    const payload: AttestationPayload = {
      version: ATTESTATION_VERSION,
      executionId,
      attestedAt,
      expiresAt,
      runtimeIdentity: identityBefore,
      evidence: {
        providerRequests: result.providerRequests,
        toolName: "write",
        markerSha256: markerHash,
        markerSize: Buffer.byteLength(markerContents, "utf8"),
        runnerEvidenceSha256: evidenceHash,
      },
    };
    this.writeSignedAttestation(payload);
    this.store.insertAudit({
      actor: "local-operator",
      action: "control_center.sandbox_runtime_attested",
      detail: JSON.stringify({
        executionId,
        attestedAt,
        expiresAt,
        kiloVersion: identityBefore.kiloVersion,
        sandboxVersion: identityBefore.sandboxVersion,
        providerModelId: identityBefore.providerModelId,
        providerRequests: result.providerRequests,
        markerSha256: markerHash,
        verifiedTool: "write",
      }),
    });
    this.runState = null;
  }

  private readSigningKey(create: boolean): Buffer | null {
    if (fs.existsSync(this.keyPath)) {
      if (!isRegularFile(this.keyPath)) return null;
      const stat = fs.statSync(this.keyPath);
      if (stat.size !== 32) return null;
      return fs.readFileSync(this.keyPath);
    }
    if (!create) return null;
    const key = crypto.randomBytes(32);
    try {
      atomicWrite(this.keyPath, key);
      return key;
    } catch {
      return null;
    }
  }

  private writeSignedAttestation(payload: AttestationPayload): void {
    const key = this.readSigningKey(true);
    if (!key || key.length !== 32) throw new Error("Could not create or read the local attestation signing key");
    const signature = crypto.createHmac("sha256", key).update(canonicalize(payload), "utf8").digest("hex");
    const signed: SignedAttestation = { version: ATTESTATION_VERSION, payload, signature };
    atomicWrite(this.attestationPath, JSON.stringify(signed, null, 2));
  }

  private readSignedAttestation():
    | { ok: true; payload: AttestationPayload }
    | { ok: false; missing?: boolean; reason: string } {
    if (!fs.existsSync(this.attestationPath)) return { ok: false, missing: true, reason: "No successful Sandbox runtime attestation has been recorded." };
    if (!isRegularFile(this.attestationPath)) return { ok: false, reason: "The local attestation file is not a regular file." };
    try {
      const stat = fs.statSync(this.attestationPath);
      if (stat.size <= 0 || stat.size > MAX_ATTESTATION_BYTES) return { ok: false, reason: "The local attestation file is invalid or oversized." };
      const key = this.readSigningKey(false);
      if (!key || key.length !== 32) return { ok: false, reason: "The local attestation signing key is missing or invalid; retest is required." };
      const value = JSON.parse(fs.readFileSync(this.attestationPath, "utf8")) as SignedAttestation;
      if (value.version !== ATTESTATION_VERSION || !value.payload || typeof value.signature !== "string" || !/^[a-f0-9]{64}$/i.test(value.signature)) {
        return { ok: false, reason: "The local attestation format is invalid; retest is required." };
      }
      const expected = crypto.createHmac("sha256", key).update(canonicalize(value.payload), "utf8").digest();
      const actual = Buffer.from(value.signature, "hex");
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return { ok: false, reason: "The local attestation integrity check failed; retest is required." };
      }
      if (value.payload.version !== ATTESTATION_VERSION || typeof value.payload.executionId !== "string" ||
          typeof value.payload.expiresAt !== "string" || !value.payload.runtimeIdentity?.fingerprint ||
          !value.payload.evidence?.markerSha256) {
        return { ok: false, reason: "The local attestation payload is incomplete; retest is required." };
      }
      return { ok: true, payload: value.payload };
    } catch {
      return { ok: false, reason: "The local attestation could not be read safely; retest is required." };
    }
  }

  private safePayloadStatus(payload: AttestationPayload): SandboxAttestationStatus {
    return {
      state: "NEEDS_RETEST",
      valid: false,
      reason: null,
      attestedAt: payload.attestedAt,
      expiresAt: payload.expiresAt,
      executionId: payload.executionId,
      kiloVersion: payload.runtimeIdentity.kiloVersion,
      sandboxVersion: payload.runtimeIdentity.sandboxVersion,
      providerModelId: payload.runtimeIdentity.providerModelId,
      providerApiKeyEnvironmentName: payload.runtimeIdentity.apiKeyEnvironmentName || undefined,
      providerApiKeyPresent: payload.runtimeIdentity.apiKeyPresent,
      providerRequests: payload.evidence.providerRequests,
      verifiedTool: payload.evidence.toolName,
      markerSha256: payload.evidence.markerSha256,
    };
  }
}

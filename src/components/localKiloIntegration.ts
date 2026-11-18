"use strict";

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { runProcess } from "./process";
import { SecurityManager, type SecurityProfileName } from "./security";
import { KiloConfigBuilder } from "./kiloConfig";
import { BridgeResult, okResult, failResult } from "../types";

const PORT_REGEX = /(?:port|listening)[^\d]{0,40}(\d{2,5})\b/i;

const KILO_VERSION_REGEX = /kilo[^\n]{0,80}?(\d+\.\d+\.\d+)/i;

const TOOL_LINE_REGEX = /(?:tool|function|invocation)[:=]\s*([\w.]+)/i;

export type Scenario = "read" | "write" | "edit" | "search";

export const SCENARIO_TASK_SPECS: Record<Scenario, string> = {
  read: "Read the file fixtures/read.txt using the read tool and report its contents.",
  write: "Create a new file fixtures/write-output.txt with the content 'Kilo Bridge deterministic write test.' using the write tool, then confirm it was created.",
  edit: "Edit fixtures/edit-target.txt: replace 'original text to replace' with 'replacement text' using the edit tool, then confirm the edit.",
  search: "Use the grep tool to search for 'PHASE312_GREP_MARKER' in the fixtures directory, then use the glob tool to list all *.ts files in the fixtures directory. Report all results.",
};

export interface LocalProviderHandle {
  port: number;
  pid: number;
  stop(): Promise<void>;
}

export interface ToolInvocation {
  tool: string;
  args?: unknown;
  timestamp?: string;
  line?: string;
  source: "stdout" | "stderr";
}

export interface FilesystemChangeSet {
  changedFiles: string[];
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface LocalKiloRunResult {
  executionId: string;
  profile: SecurityProfileName;
  kiloVersion: string;
  model: string;
  agent: string;
  providerEndpoint: string;
  effectiveConfigPath: string;
  effectiveConfigHash: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  toolInvocations: ToolInvocation[];
  filesystemChanges: FilesystemChangeSet;
  timedOut: boolean;
  error?: string;
  finalStatus: string;
}

export interface LocalKiloIntegrationOptions {
  security?: SecurityManager;
  bridgeRoot?: string;
  kiloBin?: string;
  providerBin?: string;
  providerArgs?: string[];
  providerCwd?: string;
  providerEnv?: Record<string, string>;
  timeoutMs?: number;
}

export function startLocalProvider(
  providerBin: string,
  opts: { cwd?: string; args?: string[]; env?: Record<string, string>; portTimeoutMs?: number } = {}
): Promise<BridgeResult<LocalProviderHandle>> {
  return new Promise((resolve) => {
    const { cwd, args = [], env } = opts;
    const portTimeoutMs = opts.portTimeoutMs ?? 10_000;
    let stdout = "";
    let stderr = "";
    let port: number | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let proc: ChildProcess | null = null;

    proc = spawn(process.execPath, [providerBin, ...args, "--port", "0"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: false,
    });

    const killTree = (): void => {
      if (!proc) return;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid ?? 0)], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else {
          proc.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
    };

    const settle = (
      ok: boolean,
      handle: LocalProviderHandle | undefined,
      error?: string,
      code?: string
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!ok) killTree();
      resolve(
        ok
          ? okResult(handle!)
          : failResult(error ?? "failed to start local provider", code ?? "LOCAL_PROVIDER_START_FAILED")
      );
    };

    const announce = (candidate: number): void => {
      if (port === null && Number.isFinite(candidate) && candidate > 0) {
        port = candidate;
        settle(true, {
          port,
          pid: proc.pid ?? 0,
          stop: async (): Promise<void> => {
            killTree();
            await new Promise<void>((res) => {
              if (!proc) return res();
              proc.once("close", res);
              proc.once("error", res);
            });
          },
        });
      }
    };

    timer = setTimeout(() => {
      settle(false, undefined, "local provider did not announce a port in time", "LOCAL_PROVIDER_PORT_TIMEOUT");
    }, portTimeoutMs);

    proc.stdout!.on("data", (d) => {
      stdout += d.toString();
      if (port === null) {
        const match = PORT_REGEX.exec(stdout);
        if (match) announce(parseInt(match[1], 10));
      }
    });

    proc.stderr!.on("data", (d) => {
      stderr += d.toString();
      if (port === null) {
        const match = PORT_REGEX.exec(stderr);
        if (match) announce(parseInt(match[1], 10));
      }
    });

    proc.on("error", (err) => {
      settle(false, undefined, err.message, "LOCAL_PROVIDER_SPAWN_FAILED");
    });

    proc.on("close", (code) => {
      if (port === null && !settled) {
        settle(
          false,
          undefined,
          "local provider exited with code " + (code ?? "null") + " before announcing a port: " + stderr.trim(),
          "LOCAL_PROVIDER_EXITED"
        );
      }
    });
  });
}

export class LocalKiloIntegration {
  private readonly security: SecurityManager;
  private readonly bridgeRoot: string;
  private readonly kiloBin: string;
  private readonly providerBin: string;
  private readonly providerArgs: string[];
  private readonly providerCwd: string | undefined;
  private readonly providerEnv: Record<string, string> | undefined;
  private readonly timeoutMs: number;

  constructor(opts: LocalKiloIntegrationOptions = {}) {
    this.bridgeRoot = opts.bridgeRoot ?? process.cwd();
    this.security =
      opts.security ?? new SecurityManager("local-kilo", path.join(this.bridgeRoot, "worktrees"), this.bridgeRoot);
    this.kiloBin = opts.kiloBin ?? process.env.KILO_BIN ?? "kilo";
    this.providerBin =
      opts.providerBin ?? path.join(this.bridgeRoot, "test-fixtures", "local-provider", "server.js");
    this.providerArgs = opts.providerArgs ?? ["--port", "0"];
    this.providerCwd = opts.providerCwd;
    this.providerEnv = opts.providerEnv;
    this.timeoutMs = opts.timeoutMs ?? 6 * 60 * 60 * 1000;
  }

  async runProfile(
    worktreePath: string,
    profile: SecurityProfileName,
    opts: { model?: string; agent?: string; scenario?: Scenario; timeoutMs?: number } = {}
  ): Promise<LocalKiloRunResult> {
    const executionId = crypto.randomBytes(16).toString("hex");
    const start = process.hrtime.bigint();
    const model = opts.model ?? "local-test/local-model";
    const scenario: Scenario = opts.scenario ?? "read";
    const taskSpec = SCENARIO_TASK_SPECS[scenario];
    const agent = opts.agent ?? (profile === "smoke" ? "native-smoke-test" : "native-normal-coding-test");
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const title = `bridge-local-${scenario}`;
    const defaultChanges: FilesystemChangeSet = { changedFiles: [], added: [], modified: [], deleted: [] };
    let effectiveConfigPath = "";
    let effectiveConfigHash = "";
    let providerEndpoint = "";

    const fail = (
      exitCode: number,
      timedOut: boolean,
      stdout: string,
      stderr: string,
      toolInvocations: ToolInvocation[],
      changes: FilesystemChangeSet,
      error: string | undefined,
      finalStatus: string,
      kiloVersion: string
    ): LocalKiloRunResult => {
      const end = process.hrtime.bigint();
      return {
        executionId,
        profile,
        kiloVersion,
        model,
        agent,
        providerEndpoint,
        effectiveConfigPath,
        effectiveConfigHash,
        exitCode,
        durationMs: Number(end - start) / 1_000_000,
        timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        toolInvocations,
        filesystemChanges: changes,
        error: timedOut ? "local kilo run timed out" : error,
        finalStatus,
      };
    };

    const profileRes = this.security.validateSecurityProfile(profile);
    if (!profileRes.ok) {
      return fail(0, false, "", "", [], defaultChanges, profileRes.error ?? "unsupported security profile", "REJECTED", "");
    }

    let provider: LocalProviderHandle | null = null;
    try {
      const providerRes = await startLocalProvider(this.providerBin, {
        cwd: this.providerCwd,
        args: this.providerArgs,
        env: this.providerEnv,
      });
      if (!providerRes.ok || !providerRes.data) {
        const before = this.collectFileSnapshot(worktreePath);
        const after = this.collectFileSnapshot(worktreePath);
        return fail(
          0,
          false,
          "",
          "",
          [],
          this.diffFileSnapshots(before, after),
          providerRes.error ?? "failed to start local provider",
          "PROVIDER_FAILED",
          ""
        );
      }
      provider = providerRes.data;

      const configBuilder = new KiloConfigBuilder({ bridgeRoot: this.bridgeRoot });
      const configRes = configBuilder.buildEffectiveConfig({ profile, providerPort: provider.port });
      effectiveConfigPath = configRes.configPath;
      effectiveConfigHash = configRes.configHash;
      providerEndpoint = configRes.providerEndpoint;

      const before = this.collectFileSnapshot(worktreePath);

      const kiloArgs = ["run", "--format", "json", "--auto", "--pure", "--dir", worktreePath, "--title", title, taskSpec, "--model", model, "--agent", agent];
      const runResult = await runProcess(this.kiloBin, kiloArgs, {
        cwd: worktreePath,
        timeoutMs,
        env: { ...process.env, KILO_CONFIG: effectiveConfigPath, KILO_NO_DAEMON: "1" },
      });

      const exitCode = runResult.code;
      const timedOut = runResult.timedOut;
      const stdout = runResult.stdout;
      const stderr = runResult.stderr;
      const error = runResult.timedOut ? undefined : exitCode !== 0 ? `kilo exited with code ${exitCode}` : undefined;
      const toolInvocations: ToolInvocation[] = [];

      this.parseToolInvocations(stdout, "stdout", toolInvocations);
      this.parseToolInvocations(stderr, "stderr", toolInvocations);

      const kiloVersion = this.extractKiloVersion(stdout, stderr);
      const after = this.collectFileSnapshot(worktreePath);
      const changes = this.diffFileSnapshots(before, after);

      const finalStatus = timedOut ? "TIMEOUT" : exitCode !== 0 || error ? "FAILED" : "COMPLETED";

      return fail(exitCode, timedOut, stdout, stderr, toolInvocations, changes, error, finalStatus, kiloVersion);
    } finally {
      if (provider) {
        try {
          await provider.stop();
        } catch {
          // ignore provider teardown errors
        }
      }
    }
  }

  private extractKiloVersion(stdout: string, stderr: string): string {
    const match = KILO_VERSION_REGEX.exec(stdout + "\n" + stderr);
    return match ? match[1] : "";
  }

  private parseToolInvocations(text: string, source: "stdout" | "stderr", out: ToolInvocation[]): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        for (const key of ["tool", "name", "function"]) {
          const value = obj[key];
          if (typeof value === "string") {
            out.push({
              tool: value,
              args: obj.args ?? obj.parameters,
              timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
              line: trimmed,
              source,
            });
            break;
          }
        }
        continue;
      }
      const match = TOOL_LINE_REGEX.exec(trimmed);
      if (match) {
        out.push({ tool: match[1], line: trimmed, source });
      }
    }
  }

  private collectFileSnapshot(root: string): Map<string, string> {
    const files = new Map<string, string>();
    const excluded = new Set([".git", "node_modules", ".kilo"]);
    try {
      const entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) continue;
        const parts = entry.path.split(/[\\/]/);
        if (parts.some((p) => excluded.has(p))) continue;
        const fullPath = path.join(root, entry.path);
        try {
          const hash = crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
          files.set(path.relative(root, fullPath), hash);
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // root may not exist yet
    }
    return files;
  }

  private diffFileSnapshots(before: Map<string, string>, after: Map<string, string>): FilesystemChangeSet {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [rel, hash] of after) {
      if (!before.has(rel)) added.push(rel);
      else if (before.get(rel) !== hash) modified.push(rel);
    }
    for (const rel of before.keys()) {
      if (!after.has(rel)) deleted.push(rel);
    }
    return {
      changedFiles: [...added, ...modified, ...deleted].sort(),
      added: added.sort(),
      modified: modified.sort(),
      deleted: deleted.sort(),
    };
  }
}

export const localKiloIntegration = new LocalKiloIntegration();





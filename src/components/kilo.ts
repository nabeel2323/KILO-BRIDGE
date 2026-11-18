"use strict";

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveSpawn,
  resolveKiloBin,
  buildSpawnDiagnostic,
  normalizeExitCode,
  SpawnResolution,
} from "./process";
import { BridgeResult, okResult, failResult, KiloEvent } from "../types";

export function spawnKilo(
  kiloBin: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; useAutomationConfig?: boolean; kiloConfigPath?: string }
): ReturnType<typeof spawn> {
  let resolution: SpawnResolution;
  if (os.platform() === "win32" && kiloBin === "kilo") {
    const resolved = resolveKiloBin();
    resolution = resolveSpawn(resolved.resolvedPath, args, { withLauncher: true });
  } else {
    resolution = resolveSpawn(kiloBin, args, { withLauncher: true });
  }
  const { cmd, args: resolvedArgs, launcher, resolvedPath } = resolution;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Use the provided KILO_CONFIG path if given; otherwise fall back to the
  // Bridge automation-only config. This ensures the effective permission
  // profile (smoke vs normal-coding) is actually applied to the Kilo subprocess,
  // rather than always falling through to automation config.
  const kiloConfigPath = opts.kiloConfigPath || (opts.useAutomationConfig ? path.join(process.cwd(), "config", "kilo-automation.jsonc") : undefined);
  if (kiloConfigPath) {
    env["KILO_CONFIG"] = kiloConfigPath;
    // Prevent stale daemon configuration from invalidating permission
    // verification for the automation subprocess.
    env["KILO_NO_DAEMON"] = "1";
  }
  const proc = spawn(cmd, resolvedArgs, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env ? { ...env, ...opts.env } : env,
    windowsHide: false,
  });
  proc.on("error", (err) => {
    Object.defineProperty(proc, "spawnDiagnostic", {
      value: buildSpawnDiagnostic(resolvedPath ?? cmd, launcher, "spawn", err),
      writable: false,
      configurable: true,
    });
  });
  return proc;
}

export interface KiloAdapterOptions {
  kiloBin?: string;
  worktreePath: string;
  taskTitle: string;
  taskSpec: string;
  model?: string;
  agent?: string;
  timeoutMs?: number;
  auto?: boolean;
  format?: string;
  kiloConfigPath?: string;
}

export interface KiloRunResult {
  exitCode: number | null;
  durationMs: number;
  sessionId?: string;
  model?: string;
  agent?: string;
  kiloVersion?: string;
  finalResponse?: string;
  events: KiloEvent[];
  eventLogPath: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export class KiloCliAdapter {
  private readonly kiloBin: string;
  readonly options: KiloAdapterOptions;
  private kiloVersion: string | null = null;
  private helpText: string | null = null;

  constructor(options: KiloAdapterOptions) {
    this.kiloBin = options.kiloBin ?? process.env.KILO_BIN ?? "kilo";
    this.options = options;
  }

  async detectExecutable(): Promise<BridgeResult<string>> {
    const res = await this.runCmd(["--version"], {});
    if (res.code === 127) {
      return failResult(
        `Kilo CLI executable not found: ${this.kiloBin}. Install @kilocode/cli and ensure 'kilo' is on PATH.`,
        "KILO_NOT_FOUND"
      );
    }
    if (res.code !== 0) {
      return failResult(`Kilo --version failed: ${res.stderr.trim()}`, "KILO_VERSION_FAILED");
    }
    this.kiloVersion = res.stdout.trim();
    return okResult(this.kiloVersion);
  }

  async readHelp(): Promise<BridgeResult<string>> {
    const res = await this.runCmd(["run", "--help"], {});
    if (res.code !== 0) {
      return failResult(`kilo run --help failed: ${res.stderr.trim()}`, "KILO_HELP_FAILED");
    }
    this.helpText = res.stdout + res.stderr;
    return okResult(this.helpText);
  }

  hasOption(option: string): boolean {
    return Boolean(this.helpText && this.helpText.includes(option));
  }

  async validateAuth(): Promise<BridgeResult<void>> {
    return okResult();
  }

  async preflight(): Promise<BridgeResult<{ authenticated: boolean; version: string; model: string | undefined; agent: string | undefined }>> {
    // 1. Detect executable + version.
    const ver = await this.detectExecutable();
    if (!ver.ok) return failResult(ver.error ?? "kilo detection failed", ver.code ?? "KILO_DETECTION_FAILED");

    // 2. Read help and validate required options.
    const help = await this.readHelp();
    if (!help.ok) return failResult(help.error ?? "kilo help failed", "KILO_HELP_FAILED");
    for (const opt of ["--auto", "--format", "--dir", "--title"]) {
      if (!this.hasOption(opt)) {
        return failResult(`kilo run --help missing required option ${opt}`, "KILO_OPTIONS_MISSING");
      }
    }

    // 3. Auth: `kilo auth list` must report credentials.
    const authRes = await this.runCmd(["auth", "list"], {});
    if (authRes.code !== 0 || /0 credentials|no credentials/i.test(authRes.stdout + authRes.stderr)) {
      return failResult(`Kilo has no credentials: ${(authRes.stderr || authRes.stdout).trim()}`, "KILO_AUTH_FAILED");
    }

    // 4. Model availability (if specified).
    if (this.options.model) {
      const modelRes = await this.runCmd(["models"], {});
      if (modelRes.code !== 0 || !modelRes.stdout.includes(this.options.model)) {
        return failResult(`Kilo model unavailable: ${this.options.model}`, "KILO_MODEL_UNAVAILABLE");
      }
    }

    // 5. Agent availability (if specified).
    if (this.options.agent) {
      const agentRes = await this.runCmd(["agent", "list"], {});
      if (agentRes.code !== 0 || !agentRes.stdout.includes(this.options.agent)) {
        return failResult(`Kilo agent unavailable: ${this.options.agent}`, "KILO_AGENT_UNAVAILABLE");
      }
    }

    // 6. Config check.
      const cfgRes = await this.runCmd(["config", "check"], {});
    if (cfgRes.code !== 0) {
      return failResult(`Kilo config check failed: ${cfgRes.stderr.trim()}`, "KILO_CONFIG_FAILED");
    }

    return okResult({
      authenticated: true,
      version: this.kiloVersion ?? ver.data ?? "",
      model: this.options.model,
      agent: this.options.agent,
    });
  }

  async run(): Promise<KiloRunResult> {
    const start = process.hrtime.bigint();
    const events: KiloEvent[] = [];
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exitCode: number | null = null;
    let error: string | undefined;
    let sessionId: string | undefined;
    let finalResponse: string | undefined;

    const worktree = this.options.worktreePath;
    if (!fs.existsSync(worktree)) fs.mkdirSync(worktree, { recursive: true });

    const args = this.buildArgs();
    const timeoutMs = this.options.timeoutMs ?? 6 * 60 * 60 * 1000;

    let proc: ReturnType<typeof spawn> | null = null;
    let timer: NodeJS.Timeout | null = null;

    const runPromise = new Promise<KiloRunResult>((resolve) => {
      proc = spawnKilo(this.kiloBin, args, {
        cwd: worktree,
        useAutomationConfig: true,
        kiloConfigPath: this.options.kiloConfigPath,
        env: { ...process.env, KILO_AUTO: this.options.auto ? "1" : undefined },
      });

      proc.stdout!.on("data", (d) => {
        const text = d.toString();
        stdout += text;
        this.parseEvents(text, events);
      });
      proc.stderr!.on("data", (d) => {
        stderr += d.toString();
      });

      const killTree = () => {
        if (!proc) return;
        try {
          if (os.platform() === "win32") {
            spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore", windowsHide: true });
          } else {
            proc.kill("SIGKILL");
          }
        } catch { /* ignore */ }
      };

      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        exitCode = code ?? null;
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1_000_000;
        resolve({
          exitCode,
          durationMs,
          sessionId: ((events.find((e) => e.session_id)?.session_id as string | undefined) ?? undefined),
          model: this.options.model,
          agent: this.options.agent,
          kiloVersion: this.kiloVersion ?? undefined,
          finalResponse,
          events,
          eventLogPath: "",
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut,
          error: timedOut ? "execution timed out" : undefined,
        });
      });

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        error = err.message;
        resolve({
          exitCode: null,
          durationMs: Number(process.hrtime.bigint() - start) / 1_000_000,
          sessionId: ((events.find((e) => e.session_id)?.session_id as string | undefined) ?? undefined),
          model: this.options.model,
          agent: this.options.agent,
          kiloVersion: this.kiloVersion ?? undefined,
          finalResponse,
          events,
          eventLogPath: "",
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut: false,
          error,
        });
      });
    });

    const result = await runPromise;

    // Persist event log (redacted).
    const logDir = path.join(worktree, ".kilo-bridge");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const eventLogPath = path.join(logDir, `kilo-events-${Date.now()}.json`);
    const redactedEvents = events.map((e) => this.redactEvent(e));
    fs.writeFileSync(eventLogPath, JSON.stringify(redactedEvents, null, 2), "utf8");

    const finalResp = this.extractFinalResponse(events, stdout);

    return {
      ...result,
      eventLogPath,
      finalResponse: finalResp ?? result.finalResponse,
    };
  }

  private buildArgs(): string[] {
    const args: string[] = ["run"];
    if (this.options.auto) args.push("--auto");
    args.push("--format", this.options.format ?? "json");
    args.push("--dir", this.options.worktreePath);
    args.push("--title", this.options.taskTitle);
    // Task specification as a single final positional argument (no shell interpolation).
    args.push(this.options.taskSpec);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.agent) args.push("--agent", this.options.agent);
    return args;
  }

  private parseEvents(text: string, events: KiloEvent[]): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (ev && typeof ev === "object") {
          const event = ev as KiloEvent;
          // Never store reasoning/internal chain-of-thought.
          if (event.type && /reasoning|internal|chain.of.thought|cot/i.test(event.type)) continue;
          const part = (event.properties as { part?: { type?: string } } | undefined)?.part;
          if (part && part.type === "reasoning") continue;
          events.push(event);
        }
      } catch {
        // Non-JSON lines are operational logs; ignore.
      }
    }
  }

  private extractFinalResponse(events: KiloEvent[], stdout: string): string | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const data = ev.data;
      if (data && typeof data === "object") {
        const obj = data as Record<string, unknown>;
        for (const key of ["response", "text", "content", "finalResponse", "result"]) {
          if (typeof obj[key] === "string" && obj[key].trim().length > 0) {
            return obj[key];
          }
        }
      }
      const part = (ev.properties as { part?: { type?: string; text?: string } } | undefined)?.part;
      if (part && typeof part.text === "string" && part.text.trim().length > 0) {
        return part.text;
      }
      if (typeof ev.text === "string" && ev.text.trim().length > 0) return ev.text;
    }
    return undefined;
  }

  private redactEvent(ev: KiloEvent): KiloEvent {
    return JSON.parse(JSON.stringify(ev, (_key, value) => {
      if (typeof value === "string") return this.redactString(value);
      return value;
    })) as KiloEvent;
  }

  private redactValue(v: unknown): unknown {
    if (typeof v === "string") return this.redactString(v);
    if (Array.isArray(v)) return v.map((x) => this.redactValue(x));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const keyLower = k.toLowerCase();
        if (/key|token|secret|password|passwd|auth|credential/.test(keyLower)) {
          o[k] = "[REDACTED]";
        } else {
          o[k] = this.redactValue(val);
        }
      }
      return o;
    }
    return v;
  }

  private redactString(s: string): string {
    return s
      .replace(/ghp_[A-Za-z0-9]{36}/g, "[REDACTED_TOKEN]")
      .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]")
      .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]");
  }

  private runCmd(args: string[], opts: { cwd?: string; input?: string; useAutomationConfig?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawnKilo(this.kiloBin, args, {
        cwd: opts.cwd ?? process.cwd(),
        useAutomationConfig: opts.useAutomationConfig ?? true,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout!.on("data", (d) => (stdout += d.toString()));
      proc.stderr!.on("data", (d) => (stderr += d.toString()));
      if (opts.input) {
        try { proc.stdin!.write(opts.input); proc.stdin!.end(); } catch { /* ignore */ }
      } else {
        try { proc.stdin!.end(); } catch { /* ignore */ }
      }
      proc.on("close", (code) => resolve({ code: normalizeExitCode(code ?? 1, stderr), stdout, stderr }));
      proc.on("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
    });
  }
}

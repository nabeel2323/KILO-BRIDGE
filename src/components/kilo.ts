"use strict";

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BridgeResult, KiloEvent } from "../types";
import { okResult, failResult } from "../types";

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
  cwd?: string;
  mock?: boolean; // Stage C: use a mock executable
  mockCommand?: string;
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
  private readonly options: KiloAdapterOptions;
  private kiloVersion: string | null = null;
  private helpText: string | null = null;

  constructor(options: KiloAdapterOptions) {
    this.kiloBin = options.kiloBin ?? process.env.KILO_BIN ?? "kilo";
    this.options = options;
  }

  // ------------------------------------------------------------------
  // Detection & validation
  // ------------------------------------------------------------------

  async detectExecutable(): Promise<BridgeResult<string>> {
    const res = await this.runCmd([this.kiloBin, "--version"], {});
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
    const res = await this.runCmd([this.kiloBin, "run", "--help"], {});
    if (res.code !== 0) {
      return failResult(`kilo run --help failed: ${res.stderr.trim()}`, "KILO_HELP_FAILED");
    }
    this.helpText = res.stdout;
    return okResult(this.helpText);
  }

  hasOption(option: string): boolean {
    return Boolean(this.helpText && this.helpText.includes(option));
  }

  async validateAuth(): Promise<BridgeResult<void>> {
    // Kilo auth validation is best-effort; kilo run will surface auth errors.
    // Attempt a lightweight probe that does not execute tasks.
    const res = await this.runCmd([this.kiloBin, "run", "--help"], {});
    if (res.code !== 0 && /auth|login|token/i.test(res.stderr)) {
      return failResult(`Kilo authentication issue: ${res.stderr.trim()}`, "KILO_AUTH_FAILED");
    }
    return okResult();
  }

  // ------------------------------------------------------------------
  // Execution
  // ------------------------------------------------------------------

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
    if (!fs.existsSync(worktree)) {
      fs.mkdirSync(worktree, { recursive: true });
    }

    const args = this.buildArgs();
    const timeoutMs = this.options.timeoutMs ?? 6 * 60 * 60 * 1000;

    let proc: ReturnType<typeof spawn> | null = null;
    let timer: NodeJS.Timeout | null = null;

    const runPromise = new Promise<KiloRunResult>((resolve) => {
      proc = spawn(this.kiloBin, args, {
        cwd: worktree,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, KILO_AUTO: this.options.auto ? "1" : undefined },
        windowsHide: false,
      });

      proc.stdout!.on("data", (d) => {
        const text = d.toString();
        stdout += text;
        this.parseEvents(text, events);
      });
      proc.stderr!.on("data", (d) => {
        const text = d.toString();
        stderr += text;
      });

      const killTree = () => {
        if (!proc) return;
        try {
          if (os.platform() === "win32") {
            spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore" });
          } else {
            proc.kill("SIGKILL");
          }
        } catch {
          // ignore
        }
      };

      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        exitCode = code ?? null;
        if (timedOut && exitCode === null) exitCode = null;
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1_000_000;
        resolve({
          exitCode,
          durationMs,
          sessionId,
          model: this.options.model,
          agent: this.options.agent,
          kiloVersion: this.kiloVersion ?? undefined,
          finalResponse,
          events,
          eventLogPath: "", // set after writing
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
          sessionId,
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

    // Preserve event log.
    const logDir = path.join(worktree, ".kilo-bridge");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const eventLogPath = path.join(logDir, `kilo-events-${Date.now()}.json`);
    const redactedEvents = events.map((e) => this.redactEvent(e));
    fs.writeFileSync(eventLogPath, JSON.stringify(redactedEvents, null, 2), "utf8");

    // Extract final response from last assistant-like event.
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
    if (this.options.format) args.push("--format", this.options.format);
    else args.push("--format", "json");
    args.push("--dir", this.options.worktreePath);
    args.push("--title", this.options.taskTitle);
    // Task specification as a separate argument (no shell interpolation).
    args.push(this.options.taskSpec);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.agent) args.push("--agent", this.options.agent);
    return args;
  }

  private parseEvents(text: string, events: KiloEvent[]): void {
    // Kilo may emit newline-delimited JSON events. Parse each line.
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (ev && typeof ev === "object") {
          events.push(ev as KiloEvent);
          if (ev.session_id) {
            // captured externally via result mutation handled by caller
          }
          if (ev.type && /final|response|result/i.test(ev.type) && ev.data) {
            // candidate final response
          }
        }
      } catch {
        // Not JSON; ignore non-JSON lines (operational logs only).
      }
    }
  }

  private extractFinalResponse(events: KiloEvent[], stdout: string): string | undefined {
    // Prefer the last event with a textual final response.
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
      if (typeof ev.text === "string" && ev.text.trim().length > 0) return ev.text;
    }
    return undefined;
  }

  private redactEvent(ev: KiloEvent): KiloEvent {
    const out: KiloEvent = { ...ev };
    if (out.data && typeof out.data === "object") {
      out.data = this.redactValue(out.data);
    }
    return out;
  }

  private redactValue(v: unknown): unknown {
    if (typeof v === "string") {
      return this.redactString(v);
    }
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
      .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]")
      .replace(/[A-Za-z0-9+/]{40,}=*/g, "[REDACTED]");
  }

  private runCmd(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(this.kiloBin, args, {
        cwd: opts.cwd ?? this.options.worktreePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        windowsHide: false,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout!.on("data", (d) => (stdout += d.toString()));
      proc.stderr!.on("data", (d) => (stderr += d.toString()));
      if (opts.input) {
        try { proc.stdin.write(opts.input); proc.stdin.end(); } catch { /* ignore */ }
      }
      proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      proc.on("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
    });
  }
}

"use strict";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BridgeResult, KiloEvent } from "../types";
import { okResult, failResult } from "../types";
import { runProcess } from "./process";
import { redactSecrets } from "./security";

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

export interface KiloPreflightResult {
  version: string;
  options: string[];
  authenticated: boolean;
  model?: string;
  agent?: string;
}

// Required `kilo run` options, validated against the INSTALLED CLI's help
// output (spec §6: never assume an option works from an example).
const REQUIRED_RUN_OPTIONS = ["--auto", "--format", "--dir", "--title"];

export class KiloCliAdapter {
  private readonly kiloBin: string;
  private readonly options: KiloAdapterOptions;
  private kiloVersion: string | null = null;
  private helpText: string | null = null;

  constructor(options: KiloAdapterOptions) {
    this.kiloBin = options.kiloBin ?? process.env.KILO_BIN ?? "kilo";
    this.options = options;
  }

  private probe(args: string[], timeoutMs = 60_000) {
    // Probes run in an existing directory; the worktree may not exist yet.
    return runProcess(this.kiloBin, args, { cwd: os.tmpdir(), timeoutMs });
  }

  // ------------------------------------------------------------------
  // Detection & validation
  // ------------------------------------------------------------------

  async detectExecutable(): Promise<BridgeResult<string>> {
    const res = await this.probe(["--version"]);
    if (res.code === 127) {
      return failResult(
        `Kilo CLI executable not found: ${this.kiloBin}. Install @kilocode/cli and ensure 'kilo' is on PATH.`,
        "KILO_NOT_FOUND"
      );
    }
    if (res.code !== 0) {
      return failResult(`kilo --version failed: ${res.stderr.trim()}`, "KILO_VERSION_FAILED");
    }
    this.kiloVersion = res.stdout.trim();
    return okResult(this.kiloVersion);
  }

  async readHelp(): Promise<BridgeResult<string>> {
    const res = await this.probe(["run", "--help"]);
    if (res.code !== 0) {
      return failResult(`kilo run --help failed: ${res.stderr.trim()}`, "KILO_HELP_FAILED");
    }
    // Kilo prints its help banner to stderr; capture both streams.
    this.helpText = res.stdout + "\n" + res.stderr;
    return okResult(this.helpText);
  }

  hasOption(option: string): boolean {
    return Boolean(this.helpText && this.helpText.includes(option));
  }

  async validateAuth(): Promise<BridgeResult<void>> {
    const res = await this.probe(["auth", "list"]);
    const output = res.stdout + "\n" + res.stderr;
    if (res.code !== 0) {
      return failResult(`kilo auth list failed: ${output.trim()}`, "KILO_AUTH_FAILED");
    }
    if (/0 credentials|no credentials|not logged in|no providers/i.test(output)) {
      return failResult("Kilo CLI has no configured credentials. Run 'kilo auth login'.", "KILO_AUTH_FAILED");
    }
    return okResult();
  }

  async validateModel(model: string): Promise<BridgeResult<void>> {
    const res = await this.probe(["models"], 120_000);
    if (res.code !== 0) {
      return failResult(`kilo models failed: ${res.stderr.trim()}`, "KILO_MODELS_FAILED");
    }
    if (!res.stdout.includes(model)) {
      return failResult(`configured model not available: ${model}`, "KILO_MODEL_UNAVAILABLE");
    }
    return okResult();
  }

  async validateAgent(agent: string): Promise<BridgeResult<void>> {
    const res = await this.probe(["agent", "list"], 120_000);
    if (res.code !== 0) {
      return failResult(`kilo agent list failed: ${res.stderr.trim()}`, "KILO_AGENTS_FAILED");
    }
    if (!res.stdout.includes(agent)) {
      return failResult(`configured agent not available: ${agent}`, "KILO_AGENT_UNAVAILABLE");
    }
    return okResult();
  }

  // Full preflight: detect, help-option validation, auth, model/agent.
  async preflight(): Promise<BridgeResult<KiloPreflightResult>> {
    const version = await this.detectExecutable();
    if (!version.ok) return failResult(version.error!, version.code);
    const help = await this.readHelp();
    if (!help.ok) return failResult(help.error!, help.code);
    const missing = REQUIRED_RUN_OPTIONS.filter((o) => !this.hasOption(o));
    if (missing.length > 0) {
      return failResult(`installed Kilo CLI lacks required options: ${missing.join(", ")}`, "KILO_OPTIONS_MISSING");
    }
    const auth = await this.validateAuth();
    if (!auth.ok) return failResult(auth.error!, auth.code);
    if (this.options.model) {
      const m = await this.validateModel(this.options.model);
      if (!m.ok) return failResult(m.error!, m.code);
    }
    if (this.options.agent) {
      const a = await this.validateAgent(this.options.agent);
      if (!a.ok) return failResult(a.error!, a.code);
    }
    return okResult({
      version: version.data!,
      options: REQUIRED_RUN_OPTIONS,
      authenticated: true,
      model: this.options.model,
      agent: this.options.agent,
    });
  }

  // ------------------------------------------------------------------
  // Execution
  // ------------------------------------------------------------------

  async run(): Promise<KiloRunResult> {
    const worktree = this.options.worktreePath;
    if (!fs.existsSync(worktree)) {
      fs.mkdirSync(worktree, { recursive: true });
    }

    const args = this.buildArgs();
    const timeoutMs = this.options.timeoutMs ?? 6 * 60 * 60 * 1000;

    const res = await runProcess(this.kiloBin, args, {
      cwd: worktree,
      timeoutMs,
    });

    const events = this.parseEvents(res.stdout);
    const sessionId = this.extractSessionId(events);
    const finalResponse = this.extractFinalResponse(events);

    // Preserve the original event log (operational events only, redacted).
    const logDir = path.join(worktree, ".kilo-bridge");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const eventLogPath = path.join(logDir, `kilo-events-${Date.now()}.json`);
    const operational = events.filter((e) => !this.isReasoningEvent(e)).map((e) => this.redactEvent(e));
    fs.writeFileSync(eventLogPath, JSON.stringify(operational, null, 2), "utf8");

    return {
      exitCode: res.code === 127 ? null : res.code,
      durationMs: res.durationMs,
      sessionId,
      model: this.options.model,
      agent: this.options.agent,
      kiloVersion: this.kiloVersion ?? undefined,
      finalResponse,
      events: operational,
      eventLogPath,
      stdout: redactSecrets(res.stdout),
      stderr: redactSecrets(res.stderr),
      timedOut: res.timedOut,
      error: res.timedOut
        ? "execution timed out"
        : res.code === 127
          ? `kilo executable not found: ${this.kiloBin}`
          : undefined,
    };
  }

  // All options BEFORE the variadic positional message (yargs consumes
  // everything after the first positional as message content).
  private buildArgs(): string[] {
    const args: string[] = ["run"];
    if (this.options.auto) args.push("--auto");
    args.push("--format", this.options.format ?? "json");
    args.push("--dir", this.options.worktreePath);
    args.push("--title", this.options.taskTitle);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.agent) args.push("--agent", this.options.agent);
    // Task specification as a single positional argument — never interpolated
    // into a shell command (spec §1).
    args.push(this.options.taskSpec);
    return args;
  }

  private parseEvents(stdout: string): KiloEvent[] {
    const events: KiloEvent[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (ev && typeof ev === "object") events.push(ev as KiloEvent);
      } catch {
        // Non-JSON operational output is not an event.
      }
    }
    return events;
  }

  private extractSessionId(events: KiloEvent[]): string | undefined {
    for (const ev of events) {
      const anyEv = ev as any;
      const candidates = [
        anyEv.session_id,
        anyEv.sessionID,
        anyEv.data?.session_id,
        anyEv.properties?.sessionID,
        anyEv.properties?.info?.id,
        anyEv.properties?.part?.sessionID,
      ];
      for (const c of candidates) {
        if (typeof c === "string" && c.length > 0) return c;
      }
    }
    return undefined;
  }

  // Extract the agent's final response: the last assistant text part.
  // Reasoning/thinking parts are never stored (spec §6).
  private extractFinalResponse(events: KiloEvent[]): string | undefined {
    let last: string | undefined;
    for (const ev of events) {
      if (this.isReasoningEvent(ev)) continue;
      const anyEv = ev as any;
      const part = anyEv.properties?.part ?? anyEv.part;
      if (part && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        last = part.text;
        continue;
      }
      const data = anyEv.data;
      if (data && typeof data === "object") {
        for (const key of ["finalResponse", "response", "result", "text", "content"]) {
          if (typeof data[key] === "string" && data[key].trim()) last = data[key];
        }
      }
      if (typeof anyEv.text === "string" && anyEv.text.trim()) last = anyEv.text;
    }
    return last;
  }

  private isReasoningEvent(ev: KiloEvent): boolean {
    const anyEv = ev as any;
    const partType = anyEv.properties?.part?.type ?? anyEv.part?.type ?? anyEv.type;
    return typeof partType === "string" && /reasoning|thinking|chain.of.thought/i.test(partType);
  }

  private redactEvent(ev: KiloEvent): KiloEvent {
    return JSON.parse(redactSecrets(JSON.stringify(ev))) as KiloEvent;
  }
}
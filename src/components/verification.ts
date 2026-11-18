"use strict";

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { VerificationRecord, VerificationCommand } from "../types";

export { type VerificationCommand } from "../types";

export const PROHIBITED_COMMANDS = [
  "db:migrate", "db:seed", "db:reset", "infra:up", "infra:down",
];

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
    } else if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export interface VerificationResult {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  startTime: string;
  endTime: string | null;
  exitCode: number | null;
  durationMs: number | null;
  passed: boolean | null;
  stdout: string;
  stderr: string;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface VerificationEngineOptions {
  worktreePath: string;
  resultsDir: string;
  commandTimeoutMs?: number;
  cwd?: string;
}

export class VerificationEngine {
  private readonly worktreePath: string;
  private readonly resultsDir: string;
  private readonly commandTimeoutMs: number;
  private readonly cwd: string;

  constructor(opts: VerificationEngineOptions) {
    this.worktreePath = opts.worktreePath;
    this.resultsDir = opts.resultsDir;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 0;
    this.cwd = opts.cwd ?? process.cwd();
  }

  static scsPlatformProfile(worktreePath: string): VerificationCommand[] {
    return [
      { name: "lint", command: "pnpm", args: ["lint"], required: true, conditional: false, cwd: worktreePath },
      { name: "typecheck", command: "pnpm", args: ["typecheck"], required: true, conditional: false, cwd: worktreePath },
      { name: "test:unit", command: "pnpm", args: ["test:unit"], required: true, conditional: false, cwd: worktreePath },
      { name: "build", command: "pnpm", args: ["build"], required: true, conditional: false, cwd: worktreePath },
      { name: "format:check", command: "pnpm", args: ["format:check"], required: false, advisory: true, conditional: false, cwd: worktreePath },
      {
        name: "test:coverage",
        command: "pnpm",
        args: ["--filter", "@scs/api", "test:coverage"],
        required: false,
        conditional: true,
        conditionFiles: ["apps/api/**", "packages/**"],
        cwd: worktreePath,
      },
    ];
  }

  static commandsFromProject(config: { verificationCommands?: string[]; advisoryCommands?: string[]; conditionalVerification?: string[] }, cwd: string): VerificationCommand[] {
    const cmds: VerificationCommand[] = [];
    for (const c of (config.verificationCommands ?? [])) {
      cmds.push({ name: c, ...tokenizeCommand(c) && { command: tokenizeCommand(c)[0], args: tokenizeCommand(c).slice(1) }, required: true, conditional: false, cwd });
    }
    for (const c of (config.advisoryCommands ?? [])) {
      const tokens = tokenizeCommand(c);
      cmds.push({ name: c, command: tokens[0], args: tokens.slice(1), required: false, advisory: true, conditional: false, cwd });
    }
    for (const c of (config.conditionalVerification ?? [])) {
      const tokens = tokenizeCommand(c);
      cmds.push({ name: c, command: tokens[0], args: tokens.slice(1), required: false, conditional: true, cwd });
    }
    return cmds;
  }

  static isProhibited(command: string): boolean {
    const lower = command.toLowerCase();
    return PROHIBITED_COMMANDS.some((p) => lower.includes(p));
  }

  selectCommands(commands: VerificationCommand[], changedFiles: string[]): VerificationCommand[] {
    return commands.filter((cmd) => {
      if (!cmd.conditional) return true;
      if (!cmd.conditionFiles || cmd.conditionFiles.length === 0) return true;
      return changedFiles.some((f) => cmd.conditionFiles!.some((pat) => this.matchesGlob(f, pat)));
    });
  }

  private matchesGlob(file: string, pattern: string): boolean {
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "\u0000DOUBLESTAR\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\u0000DOUBLESTAR\u0000/g, ".*") +
        "$"
    );
    return regex.test(file);
  }

  async runCommand(cmd: VerificationCommand): Promise<VerificationResult> {
    const id = cryptoRandomId();
    const startTime = new Date().toISOString();
    const start = process.hrtime.bigint();
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;

    const fullCommand = [cmd.command, ...cmd.args].join(" ");

    if (VerificationEngine.isProhibited(fullCommand)) {
      return {
        id, name: cmd.name, command: cmd.command, args: cmd.args, cwd: cmd.cwd,
        startTime, endTime: startTime, exitCode: -1, durationMs: 0, passed: false,
        stdout: "", stderr: "command is prohibited in autonomous execution",
      };
    }

    try {
      const res = await this.spawnCmd(cmd.command, cmd.args, { cwd: cmd.cwd, timeoutMs: this.commandTimeoutMs });
      stdout = res.stdout;
      stderr = res.stderr;
      exitCode = res.code ?? null;
      if (res.timedOut) {
        stderr = (stderr ? stderr + "\n" : "") + "command timed out";
      }
    } catch (err) {
      stderr = String(err);
      exitCode = null;
    }

    const endTime = new Date().toISOString();
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const passed = exitCode === 0;

    let stdoutPath: string | undefined;
    let stderrPath: string | undefined;
    if (!fs.existsSync(this.resultsDir)) fs.mkdirSync(this.resultsDir, { recursive: true });
    stdoutPath = path.join(this.resultsDir, `${id}.stdout.txt`);
    stderrPath = path.join(this.resultsDir, `${id}.stderr.txt`);
    fs.writeFileSync(stdoutPath, stdout, "utf8");
    fs.writeFileSync(stderrPath, stderr, "utf8");

    return {
      id, name: cmd.name, command: cmd.command, args: cmd.args, cwd: cmd.cwd,
      startTime, endTime, exitCode, durationMs, passed,
      stdout, stderr, stdoutPath, stderrPath,
    };
  }

  async runSuite(commands: VerificationCommand[], changedFiles: string[]): Promise<VerificationResult[]> {
    const selected = this.selectCommands(commands, changedFiles);
    const results: VerificationResult[] = [];
    for (const cmd of selected) {
      results.push(await this.runCommand(cmd));
    }
    return results;
  }

  toRecord(executionId: string, result: VerificationResult): Omit<VerificationRecord, "id"> {
    return {
      executionId,
      name: result.name,
      command: result.command,
      args: result.args,
      cwd: result.cwd,
      startTime: result.startTime,
      endTime: result.endTime ?? undefined,
      exitCode: result.exitCode ?? undefined,
      durationMs: result.durationMs ?? undefined,
      stdoutPath: result.stdoutPath,
      stderrPath: result.stderrPath,
      passed: result.passed === true ? true : result.passed === false ? false : undefined,
    };
  }

  allRequiredPassed(results: Array<{ name?: string | undefined; command?: string | undefined; passed?: boolean | null | undefined }>, commands: VerificationCommand[]): boolean {
    const requiredNames = new Set(commands.filter((c) => c.required).map((c) => c.name));
    for (const r of results) {
      const nm = r.name ?? r.command;
      if (nm !== undefined && requiredNames.has(nm) && r.passed !== true) return false;
    }
    for (const name of requiredNames) {
      if (!results.some((r) => (r.name ?? r.command) === name && r.passed === true)) return false;
    }
    return true;
  }

  private spawnCmd(command: string, args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const start = process.hrtime.bigint();
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      const proc = spawn(command, args, {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        windowsHide: false,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      try { proc.stdin.end(); } catch { /* ignore */ }
      const killTree = () => {
        try {
          if (os.platform() === "win32") {
            spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore", windowsHide: true });
          } else {
            proc.kill("SIGKILL");
          }
        } catch { /* ignore */ }
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => { timedOut = true; killTree(); }, opts.timeoutMs);
      }
      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr, timedOut });
      });
      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }
}

function cryptoRandomId(): string {
  return require("node:crypto").randomUUID();
}

"use strict";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { VerificationRecord, ProjectConfig } from "../types";
import { runProcess } from "./process";

export interface VerificationCommand {
  name: string;
  command: string;
  args: string[];
  required: boolean;
  conditional: boolean;
  conditionFiles?: string[]; // run when these files changed
  cwd: string;
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
  cwd?: string;
  commandTimeoutMs?: number;
}

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per command

// Tokenize a configured command string into argv (whitespace split, double
// quotes honored). Only trusted project configuration is tokenized — never
// issue/comment content (spec §5: no shell interpretation of GitHub content).
export function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    tokens.push(m[1] ?? m[2]);
  }
  return tokens;
}

export class VerificationEngine {
  private readonly worktreePath: string;
  private readonly resultsDir: string;
  private readonly cwd: string;
  private readonly commandTimeoutMs: number;

  constructor(opts: VerificationEngineOptions) {
    this.worktreePath = opts.worktreePath;
    this.resultsDir = opts.resultsDir;
    this.cwd = opts.cwd ?? process.cwd();
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  }

  // Build the verification suite from explicit project configuration.
  // required = verificationCommands, advisory = advisoryCommands,
  // conditional = conditionalVerification (runs only when relevant files change).
  static commandsFromProject(config: ProjectConfig, worktreePath: string): VerificationCommand[] {
    const out: VerificationCommand[] = [];
    const push = (raw: string, kind: "required" | "advisory" | "conditional") => {
      const tokens = tokenizeCommand(raw);
      if (tokens.length === 0) return;
      out.push({
        name: raw,
        command: tokens[0],
        args: tokens.slice(1),
        required: kind === "required",
        conditional: kind === "conditional",
        conditionFiles: kind === "conditional" ? ["apps/api/**", "packages/**"] : undefined,
        cwd: worktreePath,
      });
    };
    for (const c of config.verificationCommands ?? []) push(c, "required");
    for (const c of config.advisoryCommands ?? []) push(c, "advisory");
    for (const c of config.conditionalVerification ?? []) push(c, "conditional");
    return out;
  }

  // Build the default SCS Platform verification profile.
  static scsPlatformProfile(worktreePath: string): VerificationCommand[] {
    return [
      { name: "lint", command: "pnpm", args: ["lint"], required: true, conditional: false, cwd: worktreePath },
      { name: "typecheck", command: "pnpm", args: ["typecheck"], required: true, conditional: false, cwd: worktreePath },
      { name: "test:unit", command: "pnpm", args: ["test:unit"], required: true, conditional: false, cwd: worktreePath },
      { name: "build", command: "pnpm", args: ["build"], required: true, conditional: false, cwd: worktreePath },
      { name: "format:check", command: "pnpm", args: ["format:check"], required: false, conditional: false, cwd: worktreePath },
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

  // Filter commands: run required always, conditional only if relevant files changed.
  selectCommands(commands: VerificationCommand[], changedFiles: string[]): VerificationCommand[] {
    return commands.filter((cmd) => {
      if (!cmd.conditional) return true;
      if (!cmd.conditionFiles || cmd.conditionFiles.length === 0) return true;
      return changedFiles.some((f) => cmd.conditionFiles!.some((pat) => this.matchesGlob(f, pat)));
    });
  }

  private matchesGlob(file: string, pattern: string): boolean {
    // Simple glob support: ** matches any depth, * matches within a segment.
    // ** is placeholder-protected so the single-* pass cannot corrupt it.
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\u0000/g, ".*") +
        "$"
    );
    return regex.test(file);
  }

  // Prohibited commands that must never run in autonomous execution.
  static isProhibited(command: string): boolean {
    const lower = command.toLowerCase();
    const prohibited = [
      "db:migrate", "db:seed", "db:reset", "infra:up", "infra:down",
    ];
    return prohibited.some((p) => lower.includes(p));
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

    const res = await runProcess(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      timeoutMs: this.commandTimeoutMs,
    });
    stdout = res.stdout;
    stderr = res.stderr;
    exitCode = res.code;
    if (res.timedOut) {
      stderr += (stderr ? "\n" : "") + `verification command timed out after ${this.commandTimeoutMs}ms`;
    }

    const endTime = new Date().toISOString();
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const passed = exitCode === 0;

    // Capture output files.
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

  async runSuite(
    commands: VerificationCommand[],
    changedFiles: string[]
  ): Promise<VerificationResult[]> {
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

  allRequiredPassed(results: VerificationResult[], commands: VerificationCommand[]): boolean {
    const requiredNames = new Set(commands.filter((c) => c.required).map((c) => c.name));
    for (const r of results) {
      if (requiredNames.has(r.name) && r.passed !== true) return false;
    }
    // Ensure every required command actually ran.
    for (const name of requiredNames) {
      if (!results.some((r) => r.name === name && r.passed === true)) return false;
    }
    return true;
  }

}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}

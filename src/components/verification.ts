"use strict";

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  BridgeResult,
  okResult,
  failResult,
  VerificationRecord,
} from "../types";

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
}

export class VerificationEngine {
  private readonly worktreePath: string;
  private readonly resultsDir: string;
  private readonly cwd: string;

  constructor(opts: VerificationEngineOptions) {
    this.worktreePath = opts.worktreePath;
    this.resultsDir = opts.resultsDir;
    this.cwd = opts.cwd ?? process.cwd();
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
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*") +
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

    try {
      const res = await this.spawnCmd(cmd.command, cmd.args, { cwd: cmd.cwd });
      stdout = res.stdout;
      stderr = res.stderr;
      exitCode = res.code;
    } catch (err) {
      stderr = String(err);
      exitCode = null;
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

  private spawnCmd(command: string, args: string[], opts: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
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
      proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      proc.on("error", (err) => reject(err));
    });
  }
}

function cryptoRandomId(): string {
  return require("node:crypto").randomUUID();
}

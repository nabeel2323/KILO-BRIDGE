"use strict";

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SPAWN_FAILED_CODE = 127;

// ---------------------------------------------------------------------------
// Launcher types
// ---------------------------------------------------------------------------

export type SpawnLauncher = "direct" | "cmd" | "powershell" | "posix-sh";

export interface SpawnResolution {
  cmd: string;
  args: string[];
  launcher: SpawnLauncher;
  resolvedPath: string | null;
}

export interface KiloBinResolution {
  resolvedPath: string;
  launcher: SpawnLauncher;
}

// ---------------------------------------------------------------------------
// Diagnostic error info
// ---------------------------------------------------------------------------

export type SpawnFailureStage = "resolve" | "spawn" | "close";

export interface SpawnFailureDiagnostic {
  executable: string | null;
  invocationMechanism: SpawnLauncher | null;
  failureStage: SpawnFailureStage | null;
  error: string;
}

export function buildSpawnDiagnostic(
  executable: string | null,
  mechanism: SpawnLauncher | null,
  stage: SpawnFailureStage,
  error: unknown,
): SpawnFailureDiagnostic {
  return {
    executable,
    invocationMechanism: mechanism,
    failureStage: stage,
    error: error instanceof Error ? error.message : String(error),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWin32(): boolean {
  return os.platform() === "win32";
}

function hasPosixShShebang(filePath: string): boolean {
  try {
    const data = fs.readFileSync(filePath, "utf8");
    const firstLine = data.split(/\r?\n/)[0];
    return /^#!\s*\/?bin\/sh\b/.test(firstLine ?? "");
  } catch {
    return false;
  }
}

function classifyLauncher(cmd: string): SpawnLauncher {
  const ext = path.extname(cmd).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") return "cmd";
  if (ext === ".ps1") return "powershell";
  if (!ext && isWin32()) {
    return hasPosixShShebang(cmd) ? "posix-sh" : "cmd";
  }
  return "direct";
}

function listOnPath(name: string): string[] {
  if (!isWin32()) return [];
  try {
    const result = spawnSync("where.exe", [name], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findShellOnPath(): string | null {
  for (const name of ["bash.exe", "sh.exe"]) {
    const found = listOnPath(name);
    if (found[0]) return found[0];
  }
  return null;
}

function resolveInlineJsEntry(scriptPath: string): string | null {
  try {
    const data = fs.readFileSync(scriptPath, "utf8");
    const m = data.match(/(?:^|\s)node\b[^\n\r]*?(\S+\.js)/i);
    if (!m) return null;
    const candidate = path.resolve(path.dirname(scriptPath), m[1]);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Kilo binary resolution
// ---------------------------------------------------------------------------

export function resolveKiloBin(): KiloBinResolution {
  const envBin = process.env.KILO_BIN;
  if (envBin) {
    return { resolvedPath: envBin, launcher: classifyLauncher(envBin) };
  }

  if (isWin32()) {
    const matches = listOnPath("kilo");
    const ordered = [
      ...matches.filter((m) => /\.cmd$/i.test(m)),
      ...matches.filter((m) => /\.bat$/i.test(m)),
      ...matches.filter((m) => /\.ps1$/i.test(m)),
      ...matches.filter((m) => !path.extname(m)),
      ...matches,
    ];
    for (const cand of ordered) {
      try {
        if (!fs.existsSync(cand)) continue;
        const ext = path.extname(cand).toLowerCase();
        if (ext === ".ps1") return { resolvedPath: cand, launcher: "powershell" };
        if (!ext || ext === ".cmd" || ext === ".bat")
          return { resolvedPath: cand, launcher: "cmd" };
        if (hasPosixShShebang(cand)) return { resolvedPath: cand, launcher: "posix-sh" };
        return { resolvedPath: cand, launcher: "direct" };
      } catch {
        continue;
      }
    }
  }

  return { resolvedPath: "kilo", launcher: "direct" };
}

// ---------------------------------------------------------------------------
// Spawn resolution
// ---------------------------------------------------------------------------

function resolvePosixSh(scriptPath: string, args: string[]): SpawnResolution {
  const dir = path.dirname(scriptPath);
  const base = path.basename(scriptPath);
  const jsCandidates = [`${scriptPath}.js`, path.join(dir, `${base}.js`)];
  for (const js of jsCandidates) {
    try {
      if (fs.existsSync(js)) {
        return {
          cmd: process.execPath,
          args: [js, ...args],
          launcher: "posix-sh",
          resolvedPath: scriptPath,
        };
      }
    } catch {
      // ignore
    }
  }

  const inlineJs = resolveInlineJsEntry(scriptPath);
  if (inlineJs) {
    return {
      cmd: process.execPath,
      args: [inlineJs, ...args],
      launcher: "posix-sh",
      resolvedPath: scriptPath,
    };
  }

  const shell = findShellOnPath();
  if (shell) {
    return {
      cmd: shell,
      args: [scriptPath, ...args],
      launcher: "posix-sh",
      resolvedPath: scriptPath,
    };
  }

  return {
    cmd: "cmd",
    args: ["/c", scriptPath, ...args],
    launcher: "cmd",
    resolvedPath: scriptPath,
  };
}

function resolveSpawnInternal(cmd: string, args: string[]): SpawnResolution {
  if (!isWin32()) {
    return { cmd, args, launcher: "direct", resolvedPath: null };
  }

  const ext = path.extname(cmd).toLowerCase();

  if (ext === ".ps1") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cmd, ...args],
      launcher: "powershell",
      resolvedPath: cmd,
    };
  }

  if (ext === ".js") {
    return {
      cmd: process.execPath,
      args: [cmd, ...args],
      launcher: "direct",
      resolvedPath: cmd,
    };
  }

  if (!ext && fs.existsSync(cmd) && hasPosixShShebang(cmd)) {
    return resolvePosixSh(cmd, args);
  }

  if (!ext || ext === ".cmd" || ext === ".bat") {
    return {
      cmd: "cmd",
      args: ["/c", cmd, ...args],
      launcher: "cmd",
      resolvedPath: cmd,
    };
  }

  return { cmd, args, launcher: "direct", resolvedPath: null };
}

export function resolveSpawn(cmd: string, args: string[]): [string, string[]];
export function resolveSpawn(
  cmd: string,
  args: string[],
  options: { withLauncher: true },
): SpawnResolution;
export function resolveSpawn(
  cmd: string,
  args: string[],
  options?: { withLauncher?: boolean },
): [string, string[]] | SpawnResolution {
  const resolution = resolveSpawnInternal(cmd, args);
  return options?.withLauncher ? resolution : [resolution.cmd, resolution.args];
}

// ---------------------------------------------------------------------------
// runProcess
// ---------------------------------------------------------------------------

export interface RunProcessOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  windowsHide?: boolean;
}

export interface RunProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  diagnostic?: SpawnFailureDiagnostic;
}

export function normalizeExitCode(code: number | null, stderr: string): number {
  if (code === null || code === 127) return 127;
  const s = stderr.toLowerCase();
  if (/not recognized|is not recognized|could not be found|no such file|not an internal/i.test(s)) {
    return 127;
  }
  return code;
}

export function runProcess(
  cmd: string,
  args: string[],
  opts: RunProcessOptions = {}
): Promise<RunProcessResult> {
  const {
    cwd,
    input,
    timeoutMs,
    env,
    windowsHide = false,
  } = opts;

  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    let proc: ReturnType<typeof spawn> | null = null;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    let stdout = "";
    let stderr = "";

    let resolution: SpawnResolution;
    if (isWin32() && cmd.toLowerCase() === "kilo") {
      resolution = resolveSpawnInternal(resolveKiloBin().resolvedPath, args);
    } else {
      resolution = resolveSpawnInternal(cmd, args);
    }

    proc = spawn(resolution.cmd, resolution.args, {
      cwd,
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide,
    });

    proc.stdout!.on("data", (d) => (stdout += d.toString()));
    proc.stderr!.on("data", (d) => (stderr += d.toString()));

    if (input !== undefined && proc.stdin) {
      try {
        proc.stdin.write(input);
        proc.stdin.end();
      } catch {
        // ignore
      }
    }

    const killTree = () => {
      if (!proc) return;
      try {
        if (os.platform() === "win32") {
          spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
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

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
    }

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      resolve({
        code: normalizeExitCode(code, stderr),
        stdout,
        stderr,
        timedOut,
        durationMs,
      });
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: SPAWN_FAILED_CODE,
        stdout,
        stderr: err.message,
        timedOut: false,
        durationMs: Number(process.hrtime.bigint() - start) / 1_000_000,
        diagnostic: buildSpawnDiagnostic(
          resolution.resolvedPath ?? cmd,
          resolution.launcher,
          "spawn",
          err,
        ),
      });
    });
  });
}



"use strict";

import os from "node:os";
import spawn from "cross-spawn";

// ---------------------------------------------------------------------------
// Shared child-process runner.
// - cross-spawn: resolves .cmd/.bat shims (pnpm, kilo, gh) safely on Windows
//   without shell interpolation of argument content.
// - Explicit argument arrays only. Task content is never interpolated.
// - Captures stdout/stderr, enforces timeouts, kills the whole process tree.
// ---------------------------------------------------------------------------

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunProcessOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export const SPAWN_FAILED_CODE = 127;
export const TIMEOUT_CODE = 124;

export function killProcessTree(pid: number): void {
  try {
    if (os.platform() === "win32") {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        // best-effort; process may already be gone
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // best-effort
  }
}

export function runProcess(
  cmd: string,
  args: string[],
  opts: RunProcessOptions = {}
): Promise<ProcessResult> {
  const start = process.hrtime.bigint();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      resolve({ code, stdout, stderr, timedOut, durationMs });
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (proc.pid) killProcessTree(proc.pid);
          // If close never fires after kill, resolve defensively.
          setTimeout(() => finish(TIMEOUT_CODE), 5000).unref();
        }, opts.timeoutMs)
      : null;
    if (timer) timer.unref();

    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

    if (opts.input !== undefined) {
      try {
        proc.stdin?.write(opts.input);
      } catch {
        // ignore; close below still runs
      }
    }
    try {
      proc.stdin?.end();
    } catch {
      // ignore
    }

    proc.on("close", (code) => {
      finish(code ?? (timedOut ? TIMEOUT_CODE : 1));
    });
    proc.on("error", (err) => {
      stderr += (stderr ? "\n" : "") + err.message;
      finish(SPAWN_FAILED_CODE);
    });
  });
}
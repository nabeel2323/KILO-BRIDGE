"use strict";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  logsDir: string;
  serviceName?: string;
  enableConsole?: boolean;
  enableNotifications?: boolean;
}

export class Logger {
  private readonly logsDir: string;
  private readonly serviceName: string;
  private readonly enableConsole: boolean;
  private readonly enableNotifications: boolean;

  constructor(opts: LoggerOptions) {
    this.logsDir = opts.logsDir;
    this.serviceName = opts.serviceName ?? "kilo-bridge";
    this.enableConsole = opts.enableConsole ?? true;
    this.enableNotifications = opts.enableNotifications ?? true;
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  private logFile(level: LogLevel): string {
    return path.join(this.logsDir, `${this.serviceName}-${level}.log`);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, level, service: this.serviceName, message, meta }) + "\n";
    try {
      fs.appendFileSync(this.logFile(level), line, "utf8");
    } catch {
      // logging must never crash the app
    }
    if (this.enableConsole) {
      const prefix = `[${ts}] [${level.toUpperCase()}]`;
      // eslint-disable-next-line no-console
      console.log(`${prefix} ${message}` + (meta ? ` ${JSON.stringify(meta)}` : ""));
    }
  }

  debug(message: string, meta?: unknown): void { this.write("debug", message, meta); }
  info(message: string, meta?: unknown): void { this.write("info", message, meta); }
  warn(message: string, meta?: unknown): void { this.write("warn", message, meta); }
  error(message: string, meta?: unknown): void { this.write("error", message, meta); }

  // Windows notification (best-effort, non-fatal).
  notify(title: string, body: string): void {
    if (!this.enableNotifications) return;
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `$n = New-Object System.Windows.Forms.NotifyIcon`,
      `$n.Icon = [System.Drawing.SystemIcons]::Information`,
      `$n.BalloonTipTitle = ${this.psString(title)}`,
      `$n.BalloonTipText = ${this.psString(body)}`,
      `$n.Visible = $true`,
      `$n.ShowBalloonTip(5000)`,
      "Start-Sleep -Seconds 6",
      "$n.Dispose()",
    ].join(";");
    const proc = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      stdio: "ignore",
      windowsHide: false,
    });
    proc.unref();
  }

  private psString(s: string): string {
    return "'" + s.replace(/'/g, "''") + "'";
  }

  readRecent(level: LogLevel, lines: number = 50): string[] {
    const file = this.logFile(level);
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-lines);
  }
}

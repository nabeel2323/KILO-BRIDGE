"use strict";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { okResult, failResult, type BridgeResult } from "../types";

interface LockFileRecord {
  pid: number;
  owner: string;
  token: string;
  acquiredAt: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but cannot be signalled by this account.
    return code !== "ESRCH";
  }
}

/**
 * Cross-process exclusive lock backed by atomic CREATE_NEW semantics.
 *
 * A malformed lock is treated as occupied and is never auto-deleted. A stale
 * lock is removed only after confirming its recorded PID is not alive and the
 * token has not changed since the first read.
 */
export class ExclusiveProcessLock {
  private readonly lockPath: string;
  private readonly owner: string;
  private readonly processAlive: (pid: number) => boolean;
  private token: string | null = null;

  constructor(lockPath: string, owner: string, processAlive = isProcessAlive) {
    this.lockPath = path.resolve(lockPath);
    this.owner = owner;
    this.processAlive = processAlive;
  }

  acquire(): BridgeResult<void> {
    const dir = path.dirname(this.lockPath);
    fs.mkdirSync(dir, { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
      const record: LockFileRecord = {
        pid: process.pid,
        owner: this.owner,
        token: crypto.randomUUID(),
        acquiredAt: new Date().toISOString(),
      };
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify(record), "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        this.token = record.token;
        return okResult();
      } catch (error) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* best effort */ }
          try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          return failResult(`could not create process lock: ${String(error)}`, "LOCK_CREATE_FAILED");
        }
      }

      let current: LockFileRecord;
      try {
        current = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as LockFileRecord;
      } catch {
        return failResult("lock file exists but is unreadable; refusing unsafe takeover", "LOCK_UNCERTAIN");
      }
      if (!current || typeof current.token !== "string" || !Number.isSafeInteger(current.pid) || current.pid <= 0) {
        return failResult("lock file metadata is invalid; refusing unsafe takeover", "LOCK_UNCERTAIN");
      }
      if (this.processAlive(current.pid)) {
        return failResult(
          `lock is held by ${String(current.owner || "another process")} (pid ${current.pid})`,
          "LOCK_HELD"
        );
      }

      // Re-read the file immediately before deletion to avoid removing a newer owner.
      try {
        const latest = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as LockFileRecord;
        if (latest.token !== current.token) continue;
        fs.unlinkSync(this.lockPath);
      } catch {
        continue;
      }
    }

    return failResult("could not acquire process lock after stale-lock reconciliation", "LOCK_RACE");
  }

  release(): void {
    if (!this.token) return;
    try {
      const current = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as LockFileRecord;
      if (current.token === this.token) fs.unlinkSync(this.lockPath);
    } catch {
      // Do not remove a lock that cannot be proven to belong to this instance.
    } finally {
      this.token = null;
    }
  }

  isHeldByThisInstance(): boolean {
    return this.token !== null;
  }
}

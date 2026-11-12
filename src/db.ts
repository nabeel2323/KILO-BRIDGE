"use strict";

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import type {
  ProjectConfig,
  TaskRecord,
  TaskTransition,
  ExecutionRecord,
  VerificationRecord,
  ReportRecord,
  SecurityPolicy,
  TaskStatus,
  ReportStatus,
} from "./types";
import { okResult, failResult, type BridgeResult } from "./types";

type Row = Record<string, unknown>;

let WASM_PATH: string | null = null;

function resolveWasmPath(): string {
  if (WASM_PATH) return WASM_PATH;
  const candidates = [
    path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(__dirname, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      WASM_PATH = c;
      return c;
    }
  }
  throw new Error("sql.js wasm binary not found. Ensure sql.js is installed.");
}

export interface DbConnection {
  db: SqlJsDatabase;
  close(): void;
  export(): Uint8Array;
}

function readAll(db: SqlJsDatabase, sql: string, params?: unknown[]): Row[] {
  const results = db.exec(sql, params as any);
  if (results.length === 0) return [];
  const { columns, values } = results[0];
  return values.map((row) =>
    Object.fromEntries(columns.map((c, i) => [c, row[i]]))
  );
}

function readOne(db: SqlJsDatabase, sql: string, params?: unknown[]): Row | null {
  const rows = readAll(db, sql, params);
  return rows.length ? rows[0] : null;
}

export class SqliteStore {
  private dbPath: string;
  private db: SqlJsDatabase | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async open(): Promise<DbConnection> {
    const SQL = await initSqlJs({ locateFile: () => resolveWasmPath() });
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let buf: Uint8Array | null = null;
    if (fs.existsSync(this.dbPath)) {
      buf = fs.readFileSync(this.dbPath);
    }
    const db = new SQL.Database(buf);
    this.db = db;
    this.applyMigrations(db);
    this.persist();
    return {
      db,
      close: () => this.close(),
      export: () => this.export(),
    };
  }

  close(): void {
    if (this.db) {
      try {
        fs.writeFileSync(this.dbPath, this.export());
      } catch {
        // best-effort persist
      }
      this.db.close();
      this.db = null;
    }
  }

  // Persist the in-memory database to disk. Called after every mutation so
  // leases, transitions and executions survive crashes (spec: persistent lease).
  persist(): void {
    if (!this.db) return;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.dbPath + ".tmp";
    fs.writeFileSync(tmp, this.export());
    fs.renameSync(tmp, this.dbPath);
  }

  private mutate(sql: string, params?: unknown[]): void {
    const db = this.requireDb();
    db.run(sql, params as any);
    this.persist();
  }

  private export(): Uint8Array {
    if (!this.db) throw new Error("database not open");
    return this.db.export();
  }

  private applyMigrations(db: SqlJsDatabase): void {
    const version = this.getUserVersion(db);
    if (version < 1) this.migration1(db);
    if (version < 2) this.migration2(db);
    if (version < 3) this.migration3(db);
    this.setUserVersion(db, 3);
  }

  private getUserVersion(db: SqlJsDatabase): number {
    const res = db.exec("PRAGMA user_version");
    return Number(res[0]?.values?.[0]?.[0] ?? 0);
  }

  private setUserVersion(db: SqlJsDatabase, v: number): void {
    db.exec(`PRAGMA user_version = ${v}`);
  }

  private migration1(db: SqlJsDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        issue_url TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        base_sha TEXT,
        feature_branch TEXT,
        worktree_path TEXT,
        execution_id TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        idempotency_key TEXT NOT NULL,
        lease_holder TEXT,
        lease_expires_at TEXT,
        last_comment_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_transitions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT,
        actor TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        exit_code INTEGER,
        duration_ms INTEGER,
        kilo_version TEXT,
        kilo_session_id TEXT,
        kilo_model TEXT,
        kilo_agent TEXT,
        event_log_path TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        cwd TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        exit_code INTEGER,
        duration_ms INTEGER,
        stdout_path TEXT,
        stderr_path TEXT,
        passed INTEGER
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        status TEXT NOT NULL,
        report_path TEXT NOT NULL,
        issue_comment_id INTEGER,
        posted_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_policies (
        project_id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_transitions_task ON task_transitions(task_id);
      CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id);
      CREATE INDEX IF NOT EXISTS idx_verifications_exec ON verifications(execution_id);
    `);
  }

  private migration2(db: SqlJsDatabase): void {
    try { db.exec("ALTER TABLE tasks ADD COLUMN publish_approved_at TEXT"); } catch { /* ignore */ }
    try { db.exec("ALTER TABLE tasks ADD COLUMN published_pr_url TEXT"); } catch { /* ignore */ }
  }

  private migration3(db: SqlJsDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        actor TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id);
    `);
  }

  // ---------- projects ----------
  upsertProject(config: ProjectConfig, state: string): void {
    const now = new Date().toISOString();
    this.mutate(
      `INSERT INTO projects (id, config, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config=excluded.config, state=excluded.state, updated_at=excluded.updated_at`,
      [config.id, JSON.stringify(config), state, now, now]
    );
  }

  getProject(id: string): { config: ProjectConfig; state: string } | null {
    const db = this.requireDb();
    const row = readOne(db, `SELECT config, state FROM projects WHERE id = ?`, [id]);
    if (!row) return null;
    const config = JSON.parse(String(row.config)) as ProjectConfig;
    return { config, state: String(row.state) };
  }

  listProjects(): Array<{ config: ProjectConfig; state: string }> {
    const db = this.requireDb();
    const rows = readAll(db, `SELECT config, state FROM projects ORDER BY created_at`);
    return rows.map((r) => ({
      config: JSON.parse(String(r.config)) as ProjectConfig,
      state: String(r.state),
    }));
  }

  setProjectState(id: string, state: string): void {
    const now = new Date().toISOString();
    this.mutate(`UPDATE projects SET state = ?, updated_at = ? WHERE id = ?`, [state, now, id]);
  }

  // ---------- tasks ----------
  upsertTask(task: TaskRecord): void {
    const now = new Date().toISOString();
    this.mutate(
      `INSERT INTO tasks (id, project_id, issue_number, issue_url, title, author, body, status,
        base_sha, feature_branch, worktree_path, execution_id, attempt, idempotency_key,
        lease_holder, lease_expires_at, last_comment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status, base_sha=excluded.base_sha,
         feature_branch=excluded.feature_branch, worktree_path=excluded.worktree_path,
         execution_id=excluded.execution_id, attempt=excluded.attempt,
         lease_holder=excluded.lease_holder, lease_expires_at=excluded.lease_expires_at,
         last_comment_id=excluded.last_comment_id, updated_at=excluded.updated_at`,
      [
        task.id, task.projectId, task.issueNumber, task.issueUrl, task.title,
        task.author, task.body, task.status, task.baseSha ?? null,
        task.featureBranch ?? null, task.worktreePath ?? null, task.executionId ?? null,
        task.attempt, task.idempotencyKey, task.leaseHolder ?? null,
        task.leaseExpiresAt ?? null, task.lastCommentId ?? null, task.createdAt, now,
      ]
    );
  }

  getTask(id: string): TaskRecord | null {
    const db = this.requireDb();
    const row = readOne(db, `SELECT * FROM tasks WHERE id = ?`, [id]);
    return row ? this.mapTask(row) : null;
  }

  getTaskByIdempotencyKey(key: string): TaskRecord | null {
    const db = this.requireDb();
    const row = readOne(db, `SELECT * FROM tasks WHERE idempotency_key = ?`, [key]);
    return row ? this.mapTask(row) : null;
  }

  listTasksByProject(projectId: string, status?: string): TaskRecord[] {
    const db = this.requireDb();
    let rows: Row[];
    if (status) {
      rows = readAll(db, `SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY created_at`, [projectId, status]);
    } else {
      rows = readAll(db, `SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at`, [projectId]);
    }
    return rows.map((r) => this.mapTask(r));
  }

  listTasksByStatus(status: string): TaskRecord[] {
    const db = this.requireDb();
    const rows = readAll(db, `SELECT * FROM tasks WHERE status = ? ORDER BY created_at`, [status]);
    return rows.map((r) => this.mapTask(r));
  }

  listReadyTasks(): TaskRecord[] {
    const db = this.requireDb();
    const rows = readAll(db, `SELECT * FROM tasks WHERE status = 'READY' ORDER BY created_at`);
    return rows.map((r) => this.mapTask(r));
  }

  setLastCommentId(taskId: string, commentId: number): void {
    this.mutate(`UPDATE tasks SET last_comment_id = ?, updated_at = ? WHERE id = ?`, [commentId, new Date().toISOString(), taskId]);
  }

  getTaskByProjectIssue(projectId: string, issueNumber: number): TaskRecord | null {
    const db = this.requireDb();
    const row = readOne(db, `SELECT * FROM tasks WHERE project_id = ? AND issue_number = ?`, [projectId, issueNumber]);
    return row ? this.mapTask(row) : null;
  }

  listTasksByStatuses(statuses: string[]): TaskRecord[] {
    if (statuses.length === 0) return [];
    const db = this.requireDb();
    const placeholders = statuses.map(() => "?").join(",");
    const rows = readAll(db, `SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at`, statuses);
    return rows.map((r) => this.mapTask(r));
  }

  private mapTask(row: Row): TaskRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      issueNumber: Number(row.issue_number),
      issueUrl: String(row.issue_url),
      title: String(row.title),
      author: String(row.author),
      body: String(row.body),
      status: String(row.status) as TaskStatus,
      baseSha: row.base_sha ? String(row.base_sha) : undefined,
      featureBranch: row.feature_branch ? String(row.feature_branch) : undefined,
      worktreePath: row.worktree_path ? String(row.worktree_path) : undefined,
      executionId: row.execution_id ? String(row.execution_id) : undefined,
      attempt: Number(row.attempt ?? 1),
      idempotencyKey: String(row.idempotency_key),
      leaseHolder: row.lease_holder ? String(row.lease_holder) : undefined,
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
      lastCommentId: row.last_comment_id ? Number(row.last_comment_id) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // ---------- transitions ----------
  insertTransition(t: TaskTransition): void {
    this.mutate(
      `INSERT INTO task_transitions (id, task_id, from_status, to_status, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [t.id, t.taskId, t.fromStatus ?? null, t.toStatus, t.reason ?? null, t.actor ?? null, t.createdAt]
    );
  }

  listTransitions(taskId: string): TaskTransition[] {
    const db = this.requireDb();
    const rows = readAll(db, `SELECT * FROM task_transitions WHERE task_id = ? ORDER BY created_at`, [taskId]);
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      fromStatus: r.from_status ? (String(r.from_status) as TaskStatus) : undefined,
      toStatus: String(r.to_status) as TaskStatus,
      reason: r.reason ? String(r.reason) : undefined,
      actor: r.actor ? String(r.actor) : undefined,
      createdAt: String(r.created_at),
    }));
  }

  // ---------- executions ----------
  upsertExecution(e: ExecutionRecord): void {
    this.mutate(
      `INSERT INTO executions (id, task_id, attempt, status, start_time, end_time, exit_code,
        duration_ms, kilo_version, kilo_session_id, kilo_model, kilo_agent, event_log_path, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status, end_time=excluded.end_time, exit_code=excluded.exit_code,
         duration_ms=excluded.duration_ms, kilo_version=excluded.kilo_version,
         kilo_session_id=excluded.kilo_session_id, kilo_model=excluded.kilo_model,
         kilo_agent=excluded.kilo_agent, event_log_path=excluded.event_log_path,
         error_message=excluded.error_message`,
      [
        e.id, e.taskId, e.attempt, e.status, e.startTime, e.endTime ?? null, e.exitCode ?? null,
        e.durationMs ?? null, e.kiloVersion ?? null, e.kiloSessionId ?? null, e.kiloModel ?? null,
        e.kiloAgent ?? null, e.eventLogPath ?? null, e.errorMessage ?? null,
      ]
    );
  }

  getExecution(id: string): ExecutionRecord | null {
    const db = this.requireDb();
    const row = readOne(db, `SELECT * FROM executions WHERE id = ?`, [id]);
    if (!row) return null;
    return this.mapExecution(row);
  }

  listExecutions(taskId: string): ExecutionRecord[] {
    const db = this.requireDb();
    const rows = readAll(db, `SELECT * FROM executions WHERE task_id = ? ORDER BY attempt, start_time`, [taskId]);
    return rows.map((r) => this.mapExecution(r));
  }

  private mapExecution(row: Row): ExecutionRecord {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      attempt: Number(row.attempt),
      status: this.mapExecStatus(String(row.status)),
      startTime: String(row.start_time),
      endTime: row.end_time ? String(row.end_time) : undefined,
      exitCode: row.exit_code ? Number(row.exit_code) : undefined,
      durationMs: row.duration_ms ? Number(row.duration_ms) : undefined,
      kiloVersion: row.kilo_version ? String(row.kilo_version) : undefined,
      kiloSessionId: row.kilo_session_id ? String(row.kilo_session_id) : undefined,
      kiloModel: row.kilo_model ? String(row.kilo_model) : undefined,
      kiloAgent: row.kilo_agent ? String(row.kilo_agent) : undefined,
      eventLogPath: row.event_log_path ? String(row.event_log_path) : undefined,
      errorMessage: row.error_message ? String(row.error_message) : undefined,
    };
  }

  // ---------- verifications ----------
  insertVerification(v: Omit<VerificationRecord, "id">): void {
    this.mutate(
      `INSERT INTO verifications (id, execution_id, command, args, cwd, start_time, end_time,
        exit_code, duration_ms, stdout_path, stderr_path, passed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cryptoRandomId(), v.executionId, v.command, JSON.stringify(v.args), v.cwd, v.startTime,
        v.endTime ?? null, v.exitCode ?? null, v.durationMs ?? null, v.stdoutPath ?? null,
        v.stderrPath ?? null, v.passed === true ? 1 : v.passed === false ? 0 : null,
      ]
    );
  }

  listVerifications(executionId: string): VerificationRecord[] {
    const db = this.requireDb();
    const rows = readAll(db, `SELECT * FROM verifications WHERE execution_id = ? ORDER BY start_time`, [executionId]);
    return rows.map((r) => ({
      id: String(r.id),
      executionId: String(r.execution_id),
      command: String(r.command),
      args: (() => { try { return JSON.parse(String(r.args ?? "[]")); } catch { return []; } })(),
      cwd: String(r.cwd),
      startTime: String(r.start_time),
      endTime: rowOptStr(r.end_time),
      exitCode: rowOptNum(r.exit_code),
      durationMs: rowOptNum(r.duration_ms),
      stdoutPath: rowOptStr(r.stdout_path),
      stderrPath: rowOptStr(r.stderr_path),
      passed: r.passed === 1 ? true : r.passed === 0 ? false : undefined,
    }));
  }

  // ---------- reports ----------
  upsertReport(r: ReportRecord): void {
    this.mutate(
      `INSERT INTO reports (id, task_id, execution_id, status, report_path, issue_comment_id, posted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status, report_path=excluded.report_path,
         issue_comment_id=excluded.issue_comment_id, posted_at=excluded.posted_at`,
      [r.id, r.taskId, r.executionId, r.status, r.reportPath, r.issueCommentId ?? null, r.postedAt ?? null, r.createdAt]
    );
  }

  getReports(taskId: string): ReportRecord[] {
    const db = this.requireDb();
    const rows = readAll(db, `SELECT * FROM reports WHERE task_id = ? ORDER BY created_at`, [taskId]);
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      executionId: String(r.execution_id),
      status: String(r.status) as ReportStatus,
      reportPath: String(r.report_path),
      issueCommentId: r.issue_comment_id ? Number(r.issue_comment_id) : undefined,
      postedAt: rowOptStr(r.posted_at),
      createdAt: String(r.created_at),
    }));
  }

  // ---------- security policies ----------
  upsertSecurityPolicy(policy: SecurityPolicy): void {
    this.mutate(
      `INSERT INTO security_policies (project_id, config, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET config=excluded.config`,
      [policy.projectId, JSON.stringify(policy), policy.createdAt]
    );
  }

  getSecurityPolicy(projectId: string): SecurityPolicy | null {
    const db = this.requireDb();
    const row = readOne(db, `SELECT config FROM security_policies WHERE project_id = ?`, [projectId]);
    if (!row) return null;
    return JSON.parse(String(row.config)) as SecurityPolicy;
  }

  // ---------- meta ----------
  getMeta(key: string): string | null {
    const db = this.requireDb();
    const row = readOne(db, `SELECT value FROM meta WHERE key = ?`, [key]);
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.mutate(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]);
  }

  // ---------- audit ----------
  insertAudit(entry: { projectId?: string; actor?: string; action: string; detail?: string }): void {
    this.mutate(
      `INSERT INTO audit_log (id, project_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), entry.projectId ?? null, entry.actor ?? null, entry.action, entry.detail ?? null, new Date().toISOString()]
    );
  }

  listAudit(projectId?: string, limit: number = 100): Array<{ id: string; projectId?: string; actor?: string; action: string; detail?: string; createdAt: string }> {
    const db = this.requireDb();
    const rows = projectId
      ? readAll(db, `SELECT * FROM audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`, [projectId, limit])
      : readAll(db, `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map((r) => ({
      id: String(r.id),
      projectId: rowOptStr(r.project_id),
      actor: rowOptStr(r.actor),
      action: String(r.action),
      detail: rowOptStr(r.detail),
      createdAt: String(r.created_at),
    }));
  }

  private requireDb(): SqlJsDatabase {
    if (!this.db) throw new Error("database is not open");
    return this.db;
  }

  private mapExecStatus(v: string): ExecutionRecord["status"] {
    switch (v) {
      case "PENDING":
      case "RUNNING":
      case "COMPLETED":
      case "FAILED":
      case "TIMEOUT":
      case "CANCELLED":
        return v;
      default:
        return "FAILED";
    }
  }
}

function rowOptStr(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

function rowOptNum(v: unknown): number | undefined {
  return v === null || v === undefined ? undefined : Number(v);
}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}

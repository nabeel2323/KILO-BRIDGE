"use strict";

import path from "node:path";
import fs from "node:fs";
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
  GitHubIntakeClaim,
  GitHubIntakeClaimStatus,
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
  persist(): void;
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
      persist: () => this.persist(),
    };
  }

  public close(): void {
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

  private export(): Uint8Array {
    if (!this.db) throw new Error("database not open");
    return this.db.export();
  }

  private persist(): void {
    if (!this.db) return;
    try {
      fs.writeFileSync(this.dbPath, this.db.export());
    } catch {
      // best-effort
    }
  }

  private applyMigrations(db: SqlJsDatabase): void {
    const version = this.getUserVersion(db);
    if (version < 1) this.migration1(db);
    if (version < 2) this.migration2(db);
    if (version < 3) this.migration3(db);
    if (version < 4) this.migration4(db);
    if (version < 5) this.migration5(db);
    this.setUserVersion(db, 5);
  }

  private getUserVersion(db: SqlJsDatabase): number {
    const res = db.exec("PRAGMA user_version");
    return Number(res[0]?.values?.[0]?.[0] ?? 0);
  }

  getSchemaVersion(): number {
    return this.getUserVersion(this.requireDb());
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
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        actor TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_issue ON tasks(project_id, issue_number);
      CREATE INDEX IF NOT EXISTS idx_transitions_task ON task_transitions(task_id);
      CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id);
      CREATE INDEX IF NOT EXISTS idx_verifications_exec ON verifications(execution_id);
      CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id);
    `);
  }

  private migration2(db: SqlJsDatabase): void {
    try { db.exec("ALTER TABLE tasks ADD COLUMN publish_approved_at TEXT"); } catch { /* ignore */ }
    try { db.exec("ALTER TABLE tasks ADD COLUMN published_pr_url TEXT"); } catch { /* ignore */ }
  }

  private migration3(db: SqlJsDatabase): void {
    // audit_log already created in migration1; no-op kept for schema versioning.
  }

  private migration4(db: SqlJsDatabase): void {
    try { db.exec("ALTER TABLE verifications ADD COLUMN name TEXT"); } catch { /* ignore */ }
  }

  private migration5(db: SqlJsDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_intake_claims (
        id TEXT PRIMARY KEY,
        repository_full_name TEXT NOT NULL COLLATE NOCASE,
        issue_number INTEGER NOT NULL CHECK (issue_number > 0),
        assignment_generation INTEGER NOT NULL CHECK (assignment_generation > 0),
        project_id TEXT NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL,
        claim_owner TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_expires_at TEXT,
        last_error TEXT,
        UNIQUE(repository_full_name, issue_number, assignment_generation)
      );
      CREATE INDEX IF NOT EXISTS idx_github_intake_claims_status
        ON github_intake_claims(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_github_intake_claims_task
        ON github_intake_claims(task_id);
    `);
  }

  private runPersist(sql: string, params?: unknown[]): void {
    const db = this.requireDb();
    db.run(sql, params as any);
    this.persist();
  }

  // ---------- projects ----------
  upsertProject(config: ProjectConfig, state: string): void {
    const now = new Date().toISOString();
    this.runPersist(
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
    this.runPersist(`UPDATE projects SET state = ?, updated_at = ? WHERE id = ?`, [state, now, id]);
  }

  // ---------- GitHub intake claims ----------
  insertGitHubIntakeClaim(claim: GitHubIntakeClaim): boolean {
    const db = this.requireDb();
    const repository = claim.repositoryFullName.trim().toLowerCase();
    if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(repository)) {
      throw new Error("invalid GitHub repository identity; expected owner/repo");
    }
    if (!Number.isSafeInteger(claim.issueNumber) || claim.issueNumber <= 0) {
      throw new Error("invalid GitHub Issue number");
    }
    if (!Number.isSafeInteger(claim.assignmentGeneration) || claim.assignmentGeneration <= 0) {
      throw new Error("invalid assignment generation");
    }
    db.run(
      `INSERT OR IGNORE INTO github_intake_claims (
        id, repository_full_name, issue_number, assignment_generation, project_id,
        task_id, status, claim_owner, claim_token, claimed_at, updated_at,
        lease_expires_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        claim.id, repository, claim.issueNumber, claim.assignmentGeneration, claim.projectId,
        claim.taskId ?? null, claim.status, claim.claimOwner, claim.claimToken,
        claim.claimedAt, claim.updatedAt, claim.leaseExpiresAt ?? null, claim.lastError ?? null,
      ]
    );
    const inserted = db.getRowsModified() === 1;
    if (inserted) this.persist();
    return inserted;
  }

  getGitHubIntakeClaim(repositoryFullName: string, issueNumber: number, assignmentGeneration = 1): GitHubIntakeClaim | null {
    const db = this.requireDb();
    const repository = repositoryFullName.trim().toLowerCase();
    const row = readOne(db,
      `SELECT * FROM github_intake_claims
       WHERE repository_full_name = ? AND issue_number = ? AND assignment_generation = ?`,
      [repository, issueNumber, assignmentGeneration]
    );
    return row ? this.mapGitHubIntakeClaim(row) : null;
  }

  getGitHubIntakeClaimById(id: string): GitHubIntakeClaim | null {
    const db = this.requireDb();
    const row = readOne(db, `SELECT * FROM github_intake_claims WHERE id = ?`, [id]);
    return row ? this.mapGitHubIntakeClaim(row) : null;
  }

  listGitHubIntakeClaims(statuses?: GitHubIntakeClaimStatus[]): GitHubIntakeClaim[] {
    const db = this.requireDb();
    let rows: Row[];
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => "?").join(",");
      rows = readAll(db,
        `SELECT * FROM github_intake_claims WHERE status IN (${placeholders}) ORDER BY updated_at DESC`,
        statuses
      );
    } else {
      rows = readAll(db, `SELECT * FROM github_intake_claims ORDER BY updated_at DESC`);
    }
    return rows.map((row) => this.mapGitHubIntakeClaim(row));
  }

  updateGitHubIntakeClaim(
    id: string,
    update: Partial<Pick<GitHubIntakeClaim, "taskId" | "status" | "updatedAt" | "leaseExpiresAt" | "lastError">>
  ): boolean {
    const db = this.requireDb();
    const current = this.getGitHubIntakeClaimById(id);
    if (!current) return false;
    const next = { ...current, ...update, updatedAt: update.updatedAt ?? new Date().toISOString() };
    db.run(
      `UPDATE github_intake_claims SET task_id = ?, status = ?, updated_at = ?,
        lease_expires_at = ?, last_error = ? WHERE id = ?`,
      [next.taskId ?? null, next.status, next.updatedAt, next.leaseExpiresAt ?? null, next.lastError ?? null, id]
    );
    const modified = db.getRowsModified() === 1;
    if (modified) this.persist();
    return modified;
  }

  private mapGitHubIntakeClaim(row: Row): GitHubIntakeClaim {
    return {
      id: String(row.id),
      repositoryFullName: String(row.repository_full_name),
      issueNumber: Number(row.issue_number),
      assignmentGeneration: Number(row.assignment_generation),
      projectId: String(row.project_id),
      taskId: row.task_id ? String(row.task_id) : undefined,
      status: String(row.status) as GitHubIntakeClaimStatus,
      claimOwner: String(row.claim_owner),
      claimToken: String(row.claim_token),
      claimedAt: String(row.claimed_at),
      updatedAt: String(row.updated_at),
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
    };
  }

  // ---------- tasks ----------
  upsertTask(task: TaskRecord): void {
    const now = new Date().toISOString();
    this.runPersist(
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

  getTaskByProjectIssue(projectId: string, issueNumber: number): TaskRecord | null {
    const db = this.requireDb();
    const row = readOne(
      db, `SELECT * FROM tasks WHERE project_id = ? AND issue_number = ?`, [projectId, issueNumber]
    );
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

  listTasksByStatuses(statuses: string[]): TaskRecord[] {
    const db = this.requireDb();
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    const rows = readAll(
      db, `SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at`, statuses
    );
    return rows.map((r) => this.mapTask(r));
  }

  listReadyTasks(): TaskRecord[] {
    const db = this.requireDb();
    const rows = readAll(db, `SELECT * FROM tasks WHERE status = 'READY' ORDER BY created_at`);
    return rows.map((r) => this.mapTask(r));
  }

  setLastCommentId(taskId: string, commentId: number): void {
    const db = this.requireDb();
    db.run(`UPDATE tasks SET last_comment_id = ?, updated_at = ? WHERE id = ?`, [commentId, new Date().toISOString(), taskId]);
    this.persist();
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
    const db = this.requireDb();
    db.run(
      `INSERT INTO task_transitions (id, task_id, from_status, to_status, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [t.id, t.taskId, t.fromStatus ?? null, t.toStatus, t.reason ?? null, t.actor ?? null, t.createdAt]
    );
    this.persist();
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
    const db = this.requireDb();
    db.run(
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
    this.persist();
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
      endTime: rowOptStr(row.end_time),
      exitCode: row.exit_code !== null && row.exit_code !== undefined ? Number(row.exit_code) : undefined,
      durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : undefined,
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
    const db = this.requireDb();
    db.run(
      `INSERT INTO verifications (id, execution_id, name, command, args, cwd, start_time, end_time,
        exit_code, duration_ms, stdout_path, stderr_path, passed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cryptoRandomId(), v.executionId, v.name ?? null, v.command, JSON.stringify(v.args), v.cwd, v.startTime,
        v.endTime ?? null, v.exitCode ?? null, v.durationMs ?? null, v.stdoutPath ?? null,
        v.stderrPath ?? null, v.passed === true ? 1 : v.passed === false ? 0 : null,
      ]
    );
    this.persist();
  }

  listVerifications(executionId: string): VerificationRecord[] {
    const db = this.requireDb();
    const rows = readAll(db, `SELECT * FROM verifications WHERE execution_id = ? ORDER BY start_time`, [executionId]);
    return rows.map((r) => ({
      id: String(r.id),
      executionId: String(r.execution_id),
      name: rowOptStr(r.name),
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
    const db = this.requireDb();
    db.run(
      `INSERT INTO reports (id, task_id, execution_id, status, report_path, issue_comment_id, posted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status, report_path=excluded.report_path,
         issue_comment_id=excluded.issue_comment_id, posted_at=excluded.posted_at`,
      [r.id, r.taskId, r.executionId, r.status, r.reportPath, r.issueCommentId ?? null, r.postedAt ?? null, r.createdAt]
    );
    this.persist();
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
    const db = this.requireDb();
    db.run(
      `INSERT INTO security_policies (project_id, config, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET config=excluded.config`,
      [policy.projectId, JSON.stringify(policy), policy.createdAt]
    );
    this.persist();
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
    this.runPersist(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]);
  }

  // ---------- audit ----------
  insertAudit(audit: { projectId?: string; actor?: string; action: string; detail?: string }): void {
    const db = this.requireDb();
    db.run(
      `INSERT INTO audit_log (id, project_id, actor, action, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [cryptoRandomId(), audit.projectId ?? null, audit.actor ?? null, audit.action, audit.detail ?? null, new Date().toISOString()]
    );
    this.persist();
  }

  listAudit(projectId?: string): Array<{ projectId: string | null; actor: string | null; action: string; detail: string | null; createdAt: string }> {
    const db = this.requireDb();
    let rows: Row[];
    if (projectId) {
      rows = readAll(db, `SELECT * FROM audit_log WHERE project_id = ? ORDER BY created_at`, [projectId]);
    } else {
      rows = readAll(db, `SELECT * FROM audit_log ORDER BY created_at`);
    }
    return rows.map((r) => ({
      projectId: r.project_id ? String(r.project_id) : null,
      actor: r.actor ? String(r.actor) : null,
      action: String(r.action),
      detail: r.detail ? String(r.detail) : null,
      createdAt: String(r.created_at),
    }));
  }

  private requireDb(): SqlJsDatabase {
    if (!this.db) throw new Error("database is not open");
    return this.db;
  }

  private mapExecStatus(v: string): ExecutionRecord["status"] {
    switch (v) {
      case "PENDING": case "RUNNING": case "COMPLETED": case "FAILED": case "TIMEOUT": case "CANCELLED":
        return v;
      default: return "FAILED";
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
  return (require("node:crypto") as { randomUUID: () => string }).randomUUID();
}

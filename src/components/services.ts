"use strict";

// Injectable service dependency implementations for Phase 3.6.
// These wrap the existing Bridge components so taskExecute() can be tested
// with fixture-backed adapters while production uses real implementations.

import { GitHubProvider } from "./github";
import { KiloCliAdapter } from "./kilo";
import { WorktreeManager } from "./worktree";
import { SqliteStore } from "../db";
import { Logger } from "./logging";
import type {
  GitHubClient,
  TaskSource,
  ReportSink,
  KiloExecutor,
  WorktreeManager as WorktreeManagerIface,
  BridgeResult,
} from "../types";
import { okResult, failResult } from "../types";
import path from "node:path";

// ---------------------------------------------------------------------------
// GitHubClient implementation (production adapter using GitHubProvider)
// ---------------------------------------------------------------------------

export class GitHubClientImpl implements GitHubClient {
  private readonly gh: GitHubProvider;
  constructor(owner: string, repo: string, ghBin?: string) {
    this.gh = new GitHubProvider({ owner, repo, ghBin });
  }
  async authStatus() {
    return this.gh.authStatus();
  }
  async ensureLabels(labels: string[]): Promise<BridgeResult<void>> {
    const res = await this.gh.ensureLabels(labels as any);
    return okResult();
  }
  async listOpenIssues(opts?: { labels?: string[]; limit?: number }) {
    return this.gh.listOpenIssues(opts);
  }
  async getIssue(issueNumber: number) {
    return this.gh.getIssue(issueNumber);
  }
  async listComments(issueNumber: number) {
    return this.gh.listComments(issueNumber);
  }
  async addLabels(issueNumber: number, labels: string[]): Promise<BridgeResult<void>> {
    return this.gh.addLabels(issueNumber, labels as any);
  }
  async removeLabel(issueNumber: number, label: string): Promise<BridgeResult<void>> {
    return this.gh.removeLabel(issueNumber, label as any);
  }
  async addComment(issueNumber: number, body: string) {
    return this.gh.addComment(issueNumber, body);
  }
}

// ---------------------------------------------------------------------------
// TaskSource implementation (reads from GitHub)
// ---------------------------------------------------------------------------

export class TaskSourceImpl implements TaskSource {
  private readonly ghClient: GitHubClient;
  constructor(ghClient: GitHubClient) {
    this.ghClient = ghClient;
  }
  async listOpenIssues(projectId: string): Promise<BridgeResult<Array<{ issueNumber: number; title: string; author: string; body: string; issueUrl: string; pullRequest?: boolean }>>> {
    const res = await this.ghClient.listOpenIssues({ labels: ["kilo:ready"], limit: 50 });
    if (!res.ok || !res.data) return failResult(res.error ?? "failed to list issues", "LIST_ISSUES_FAILED");
    const issues = res.data as any[];
    return okResult(issues.map((i: any) => ({
      issueNumber: i.number,
      title: i.title,
      author: i.author,
      body: i.body,
      issueUrl: i.htmlUrl || `https://github.com/owner/repo/issues/${i.number}`,
      pullRequest: i.pullRequest,
    })));
  }
  async getIssue(projectId: string, issueNumber: number): Promise<BridgeResult<{ issueNumber: number; title: string; author: string; body: string; issueUrl: string; pullRequest?: boolean } | null>> {
    const res = await this.ghClient.getIssue(issueNumber);
    if (!res.ok || !res.data) return failResult(res.error ?? "issue not found", "ISSUE_NOT_FOUND");
    const d = res.data as any;
    return okResult({ issueNumber: d.number, title: d.title, author: d.author, body: d.body, issueUrl: d.htmlUrl || `https://github.com/owner/repo/issues/${d.number}`, pullRequest: d.pullRequest });
  }
}

// ---------------------------------------------------------------------------
// ReportSink implementation (publishes via GitHub client)
// ---------------------------------------------------------------------------

export class ReportSinkImpl implements ReportSink {
  private readonly ghClient: GitHubClient;
  constructor(ghClient: GitHubClient) {
    this.ghClient = ghClient;
  }
  async publish(reportPath: string, taskId: string, issueNumber: number, body: string): Promise<BridgeResult<{ commentId?: number; postedAt?: string }>> {
    const res = await this.ghClient.addComment(issueNumber, body);
    if (!res.ok) return failResult(res.error ?? "failed to publish report", "PUBLISH_FAILED");
    return okResult({ commentId: res.data as number | undefined, postedAt: new Date().toISOString() });
  }
}

// ---------------------------------------------------------------------------
// KiloExecutor implementation (production adapter using KiloCliAdapter)
// ---------------------------------------------------------------------------

export class KiloExecutorImpl implements KiloExecutor {
  async run(taskSpec: string, opts: { worktreePath: string; kiloConfigPath: string; model?: string; agent?: string; timeoutMs?: number }): Promise<{ exitCode: number; durationMs: number; sessionId?: string; kiloVersion?: string; model?: string; agent?: string; eventLogPath?: string; error?: string; finalResponse?: string }> {
    const adapter = new KiloCliAdapter({
      kiloBin: process.env.KILO_BIN ?? "kilo",
      worktreePath: opts.worktreePath,
      taskTitle: "task",
      taskSpec,
      timeoutMs: opts.timeoutMs ?? 60_000,
      auto: true,
      model: opts.model,
      agent: opts.agent,
      kiloConfigPath: opts.kiloConfigPath,
    });
    const preflight = await adapter.preflight();
    if (!preflight.ok) {
      return { exitCode: 1, durationMs: 0, error: preflight.error ?? "preflight failed" };
    }
    const run = await adapter.run();
    return {
      exitCode: run.exitCode ?? 1,
      durationMs: run.durationMs ?? 0,
      sessionId: run.sessionId,
      kiloVersion: run.kiloVersion,
      model: run.model,
      agent: run.agent,
      eventLogPath: run.eventLogPath,
      error: run.error,
      finalResponse: run.finalResponse,
    };
  }
}

// ---------------------------------------------------------------------------
// WorktreeManager implementation (delegates to existing WorktreeManager)
// ---------------------------------------------------------------------------

export class WorktreeManagerImpl implements WorktreeManagerIface {
  private readonly mgr: WorktreeManager;
  constructor(opts: {
    projectId: string;
    localRepoPath: string;
    worktreeRoot: string;
    baseBranch: string;
    branchPrefix: string;
    releaseBranch: string;
  }) {
    this.mgr = new WorktreeManager(opts);
  }
  async prepareTaskWorktree(issueNumber: number, attempt: number) {
    return this.mgr.prepareTaskWorktree(issueNumber, attempt);
  }
  worktreePathFor(branch: string): string {
    return this.mgr.worktreePathFor(branch);
  }
  generateBranchName(issueNumber: number, attempt: number): string {
    return this.mgr.generateBranchName(issueNumber, attempt);
  }
  async cleanupWorktreeAndBranch(branch: string, dir: string): Promise<void> {
    await this.mgr.cleanupWorktreeAndBranch(branch, dir);
  }
  async collectChangedFiles(worktreePath: string): Promise<string[]> {
    return this.mgr.collectChangedFiles(worktreePath);
  }
}

// ---------------------------------------------------------------------------
// Fixture implementations for offline integration testing (Phase 3.7)
// ---------------------------------------------------------------------------

export class FixtureGitHubClient implements GitHubClient {
  private issues: Map<number, any> = new Map();
  private comments: Map<number, any[]> = new Map();
  private labels: Set<string> = new Set();
  private authenticated: boolean;
  private authError?: string;

  constructor(opts: { authenticated?: boolean; authError?: string; issues?: any[] } = {}) {
    this.authenticated = opts.authenticated ?? true;
    this.authError = opts.authError;
    if (opts.issues) {
      for (const issue of opts.issues) {
        this.issues.set(issue.number, issue);
        if (issue.labels) {
          for (const l of issue.labels) this.labels.add(l);
        }
      }
    }
  }

  async authStatus() {
    if (!this.authenticated) {
      return { authenticated: false, error: this.authError ?? "fixture auth failed" };
    }
    return { authenticated: true, user: "fixture-user" };
  }

  async ensureLabels(labels: string[]): Promise<BridgeResult<void>> {
    for (const l of labels) this.labels.add(l);
    return okResult();
  }

  async listOpenIssues(opts?: { labels?: string[]; limit?: number }) {
    const all = Array.from(this.issues.values());
    let filtered = all.filter((i) => i.state === "open" && !i.pullRequest);
    if (opts?.labels) {
      filtered = filtered.filter((i) => opts.labels!.some((l) => i.labels?.includes(l)));
    }
    return okResult(filtered.slice(0, opts?.limit ?? 50));
  }

  async getIssue(issueNumber: number) {
    const issue = this.issues.get(issueNumber);
    if (!issue) return failResult("issue not found", "ISSUE_NOT_FOUND");
    return okResult(issue);
  }

  async listComments(issueNumber: number) {
    return okResult(this.comments.get(issueNumber) ?? []);
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<BridgeResult<void>> {
    const issue = this.issues.get(issueNumber);
    if (issue) {
      issue.labels = [...(issue.labels ?? []), ...labels];
    }
    labels.forEach((l) => this.labels.add(l));
    return okResult();
  }

  async removeLabel(issueNumber: number, label: string): Promise<BridgeResult<void>> {
    const issue = this.issues.get(issueNumber);
    if (issue && issue.labels) {
      issue.labels = issue.labels.filter((l: string) => l !== label);
    }
    return okResult();
  }

  async addComment(issueNumber: number, body: string): Promise<BridgeResult<number>> {
    const comment = { id: Date.now(), author: "fixture-user", body, isBridge: true };
    const arr = this.comments.get(issueNumber) ?? [];
    arr.push(comment);
    this.comments.set(issueNumber, arr);
    return okResult(comment.id);
  }

  // Test helpers
  getIssueCount() { return this.issues.size; }
  getCommentCount(issueNumber: number) { return (this.comments.get(issueNumber) ?? []).length; }
  getComments(issueNumber: number) { return this.comments.get(issueNumber) ?? []; }
}

export class FixtureTaskSource implements TaskSource {
  private issues: Map<number, any> = new Map();

  constructor(issues: any[] = []) {
    for (const issue of issues) {
      this.issues.set(issue.number, issue);
    }
  }

  async listOpenIssues(projectId: string): Promise<BridgeResult<Array<{ issueNumber: number; title: string; author: string; body: string; issueUrl: string; pullRequest?: boolean }>>> {
    const all = Array.from(this.issues.values());
    const filtered = all.filter((i) => i.state === "open" && !i.pullRequest);
    return okResult(filtered.map((i) => ({
      issueNumber: i.number,
      title: i.title,
      author: i.author,
      body: i.body,
      issueUrl: i.htmlUrl || `https://github.com/owner/repo/issues/${i.number}`,
      pullRequest: i.pullRequest,
    })));
  }

  async getIssue(projectId: string, issueNumber: number): Promise<BridgeResult<{ issueNumber: number; title: string; author: string; body: string; issueUrl: string; pullRequest?: boolean } | null>> {
    const issue = this.issues.get(issueNumber);
    if (!issue) return okResult(null);
    return okResult({ issueNumber: issue.number, title: issue.title, author: issue.author, body: issue.body, issueUrl: issue.htmlUrl || `https://github.com/owner/repo/issues/${issue.number}`, pullRequest: issue.pullRequest });
  }
}

export class FixtureReportSink implements ReportSink {
  published: Array<{ reportPath: string; taskId: string; issueNumber: number; body: string; postedAt: string }> = [];
  failPublish = false;
  publishError = "publish failed";

  async publish(reportPath: string, taskId: string, issueNumber: number, body: string): Promise<BridgeResult<{ commentId?: number; postedAt?: string }>> {
    if (this.failPublish) {
      return failResult(this.publishError, "PUBLISH_FAILED");
    }
    const postedAt = new Date().toISOString();
    this.published.push({ reportPath, taskId, issueNumber, body, postedAt });
    return okResult({ commentId: this.published.length, postedAt });
  }
}

export class FixtureKiloExecutor implements KiloExecutor {
  results: Map<string, { exitCode: number; durationMs: number; sessionId?: string; kiloVersion?: string; model?: string; agent?: string; eventLogPath?: string; error?: string; finalResponse?: string }> = new Map();
  defaultResult: { exitCode: number; durationMs: number; sessionId?: string; kiloVersion?: string; model?: string; agent?: string; eventLogPath?: string; error?: string; finalResponse?: string } = {
    exitCode: 0, durationMs: 1000, sessionId: "fixture-session", kiloVersion: "7.8.27", model: "kilo/liquid/lfm-3-1.7b:free", agent: undefined, eventLogPath: undefined, error: undefined, finalResponse: "fixture response",
  };
  failOnRun = false;
  runError = "kilo execution failed";
  callCount = 0;
  lastRunOpts?: { taskSpec: string; worktreePath: string; kiloConfigPath: string; model?: string; agent?: string; timeoutMs?: number };

  async run(taskSpec: string, opts: { worktreePath: string; kiloConfigPath: string; model?: string; agent?: string; timeoutMs?: number }): Promise<{ exitCode: number; durationMs: number; sessionId?: string; kiloVersion?: string; model?: string; agent?: string; eventLogPath?: string; error?: string; finalResponse?: string }> {
    this.callCount++;
    this.lastRunOpts = { taskSpec, ...opts };
    if (this.failOnRun) {
      return { exitCode: 1, durationMs: 0, error: this.runError };
    }
    const key = `${opts.worktreePath}:${opts.kiloConfigPath}`;
    return this.results.get(key) ?? { ...this.defaultResult };
  }
}

export class FixtureWorktreeManager implements WorktreeManagerIface {
  worktrees: Map<string, { branch: string; dir: string; baseSha: string }> = new Map();
  cleanupCalled: Array<{ branch: string; dir: string }> = [];
  failPrep = false;
  prepError = "worktree preparation failed";
  failCleanup = false;
  cleanupError = "worktree cleanup failed";

  async prepareTaskWorktree(issueNumber: number, attempt: number): Promise<BridgeResult<{ branch: string; dir: string; baseSha: string }>> {
    if (this.failPrep) {
      return failResult(this.prepError, "WORKTREE_PREP_FAILED");
    }
    const branch = `ai/kilo/issue-${issueNumber}-attempt-${attempt}`;
    const dir = `/tmp/kilo-fixture-wt-${issueNumber}-${attempt}`;
    const baseSha = "abc123def456";
    const result = { branch, dir, baseSha };
    this.worktrees.set(branch, result);
    return okResult(result);
  }

  worktreePathFor(branch: string): string {
    return `/tmp/kilo-fixture-wt-${branch}`;
  }

  generateBranchName(issueNumber: number, attempt: number): string {
    return `ai/kilo/issue-${issueNumber}-attempt-${attempt}`;
  }

  async cleanupWorktreeAndBranch(branch: string, dir: string): Promise<void> {
    this.cleanupCalled.push({ branch, dir });
    if (this.failCleanup) {
      throw new Error(this.cleanupError);
    }
    this.worktrees.delete(branch);
  }

  async collectChangedFiles(worktreePath: string): Promise<string[]> {
    return ["src/index.ts", "README.md"];
  }
}

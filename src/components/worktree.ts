"use strict";

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { BridgeResult } from "../types";
import { okResult, failResult } from "../types";

export interface GitWorktreeInfo {
  worktree: string;
  branch: string;
  commit: string;
}

export interface WorktreeManagerOptions {
  projectId: string;
  localRepoPath: string;
  worktreeRoot: string;
  baseBranch: string;
  branchPrefix: string;
  cwd?: string;
}

export class WorktreeManager {
  private readonly projectId: string;
  private readonly localRepoPath: string;
  private readonly worktreeRoot: string;
  private readonly baseBranch: string;
  private readonly branchPrefix: string;
  private readonly cwd: string;

  constructor(opts: WorktreeManagerOptions) {
    this.projectId = opts.projectId;
    this.localRepoPath = opts.localRepoPath;
    this.worktreeRoot = opts.worktreeRoot;
    this.baseBranch = opts.baseBranch;
    this.branchPrefix = opts.branchPrefix;
    this.cwd = opts.cwd ?? process.cwd();
  }

  private async git(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn("git", args, {
        cwd: opts.cwd ?? this.localRepoPath,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        windowsHide: false,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      if (opts.input) {
        try { proc.stdin.write(opts.input); proc.stdin.end(); } catch { /* ignore */ }
      }
      proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      proc.on("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
    });
  }

  async verifyRepo(): Promise<BridgeResult<void>> {
    const res = await this.git(["rev-parse", "--is-inside-work-tree"]);
    if (res.code !== 0 || !res.stdout.includes("true")) {
      return failResult(`not a git repository: ${this.localRepoPath}`, "NOT_GIT_REPO");
    }
    return okResult();
  }

  async verifyOrigin(): Promise<BridgeResult<string>> {
    const res = await this.git(["remote", "get-url", "origin"]);
    if (res.code !== 0) {
      return failResult("origin remote not configured", "NO_ORIGIN");
    }
    return okResult(res.stdout.trim());
  }

  async fetchBaseBranch(): Promise<BridgeResult<void>> {
    const res = await this.git(["fetch", "origin", this.baseBranch]);
    if (res.code !== 0) {
      return failResult(`failed to fetch origin/${this.baseBranch}: ${res.stderr.trim()}`, "FETCH_FAILED");
    }
    return okResult();
  }

  async getBaseSha(): Promise<BridgeResult<string>> {
    const res = await this.git(["rev-parse", `origin/${this.baseBranch}`]);
    if (res.code !== 0) {
      return failResult(`origin/${this.baseBranch} does not exist: ${res.stderr.trim()}`, "BASE_BRANCH_MISSING");
    }
    return okResult(res.stdout.trim());
  }

  async localBranchExists(branch: string): Promise<boolean> {
    const res = await this.git(["show-ref", "--verify", `--refs/heads/${branch}`]);
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  async remoteBranchExists(branch: string): Promise<boolean> {
    const res = await this.git(["show-ref", "--verify", `--refs/remotes/origin/${branch}`]);
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  async createFeatureBranch(branch: string, fromSha: string): Promise<BridgeResult<void>> {
    const exists = await this.localBranchExists(branch);
    if (exists) {
      return failResult(`branch ${branch} already exists`, "BRANCH_EXISTS");
    }
    const res = await this.git(["branch", branch, fromSha]);
    if (res.code !== 0) {
      return failResult(`failed to create branch ${branch}: ${res.stderr.trim()}`, "BRANCH_CREATE_FAILED");
    }
    return okResult();
  }

  async worktreePathFor(branch: string): Promise<string> {
    // Safe, worktree-specific directory under worktreeRoot
    const safe = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
    return path.join(this.worktreeRoot, `${this.projectId}-${safe}`);
  }

  async worktreeExists(dir: string): Promise<boolean> {
    return fs.existsSync(dir);
  }

  async createWorktree(branch: string, dir: string): Promise<BridgeResult<void>> {
    if (fs.existsSync(dir)) {
      return failResult(`worktree directory already exists: ${dir}`, "WORKTREE_EXISTS");
    }
    if (!fs.existsSync(this.worktreeRoot)) {
      fs.mkdirSync(this.worktreeRoot, { recursive: true });
    }
    const res = await this.git(["worktree", "add", dir, branch]);
    if (res.code !== 0) {
      return failResult(`failed to create worktree: ${res.stderr.trim()}`, "WORKTREE_CREATE_FAILED");
    }
    return okResult();
  }

  async isWorktreeClean(dir: string): Promise<BridgeResult<boolean>> {
    const res = await this.git(["status", "--porcelain"], { cwd: dir });
    if (res.code !== 0) {
      return failResult(`failed to check worktree status: ${res.stderr.trim()}`, "WORKTREE_STATUS_FAILED");
    }
    return okResult(res.stdout.trim().length === 0);
  }

  async listWorktrees(): Promise<GitWorktreeInfo[]> {
    const res = await this.git(["worktree", "list", "--porcelain"]);
    const infos: GitWorktreeInfo[] = [];
    let cur: Partial<GitWorktreeInfo> = {};
    for (const line of res.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) cur.worktree = line.slice(9);
      else if (line.startsWith("HEAD ")) { /* skip */ }
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
      else if (line === "") {
        if (cur.worktree) infos.push(cur as GitWorktreeInfo);
        cur = {};
      }
    }
    if (cur.worktree) infos.push(cur as GitWorktreeInfo);
    return infos;
  }

  async collectDiff(dir: string): Promise<BridgeResult<{ stats: string; diff: string }>> {
    const statsRes = await this.git(["diff", "--stat"], { cwd: dir });
    const diffRes = await this.git(["diff"], { cwd: dir });
    return okResult({ stats: statsRes.stdout, diff: diffRes.stdout });
  }

  async collectChangedFiles(dir: string): Promise<string[]> {
    const res = await this.git(["diff", "--name-only"], { cwd: dir });
    return res.stdout.split(/\r?\n/).filter(Boolean);
  }

  generateBranchName(issueNumber: number, attempt: number): string {
    const suffix = attempt > 1 ? `-attempt-${attempt}` : "";
    return `${this.branchPrefix}/issue-${issueNumber}${suffix}`;
  }

  generateWorktreeDir(branch: string): Promise<string> {
    return Promise.resolve(this.worktreePathFor(branch));
  }

  async removeWorktree(dir: string, force: boolean = false): Promise<BridgeResult<void>> {
    if (!fs.existsSync(dir)) return okResult();
    const args = ["worktree", "remove", dir];
    if (force) args.push("--force");
    const res = await this.git(args);
    if (res.code !== 0) {
      return failResult(`failed to remove worktree: ${res.stderr.trim()}`, "WORKTREE_REMOVE_FAILED");
    }
    return okResult();
  }

  async pruneWorktrees(): Promise<BridgeResult<void>> {
    const res = await this.git(["worktree", "prune"]);
    if (res.code !== 0) return failResult(res.stderr.trim(), "WORKTREE_PRUNE_FAILED");
    return okResult();
  }
}

export function makeIdempotencyKey(projectId: string, issueNumber: number, attempt: number): string {
  return crypto.createHash("sha256").update(`${projectId}:${issueNumber}:${attempt}`).digest("hex");
}

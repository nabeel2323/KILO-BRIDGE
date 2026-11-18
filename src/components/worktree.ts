"use strict";

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { BridgeResult, okResult, failResult } from "../types";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeManagerOptions {
  projectId: string;
  localRepoPath: string;
  worktreeRoot: string;
  baseBranch: string;
  branchPrefix: string;
  releaseBranch?: string;
}

export class WorktreeManager {
  private readonly projectId: string;
  private readonly localRepoPath: string;
  private readonly worktreeRoot: string;
  private readonly baseBranch: string;
  private readonly branchPrefix: string;
  private readonly releaseBranch: string;

  constructor(opts: WorktreeManagerOptions) {
    this.projectId = opts.projectId;
    this.localRepoPath = opts.localRepoPath;
    this.worktreeRoot = opts.worktreeRoot;
    this.baseBranch = opts.baseBranch;
    this.branchPrefix = opts.branchPrefix;
    this.releaseBranch = opts.releaseBranch ?? "main";
  }

  private async git(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<GitResult> {
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
      } else {
        try { proc.stdin.end(); } catch { /* ignore */ }
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

  async verifyOriginMatches(expectedRepo: string): Promise<BridgeResult<string>> {
    const res = await this.verifyOrigin();
    if (!res.ok) return res;
    const actual = normalizeRepoUrl(res.data!);
    const expected = normalizeRepoUrl(expectedRepo);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      return failResult(`origin ${actual} does not match expected ${expected}`, "ORIGIN_MISMATCH");
    }
    return okResult(res.data!);
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
    const res = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  async remoteBranchExists(branch: string): Promise<boolean> {
    const res = await this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
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

  worktreePathFor(branch: string): string {
    const safe = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
    return path.join(this.worktreeRoot, `${this.projectId}-${safe}`);
  }

  async worktreeExists(dir: string): Promise<boolean> {
    return fs.existsSync(dir);
  }

  async createWorktree(branch: string, dir: string): Promise<BridgeResult<void>> {
    if (!this.isWithinWorktreeRoot(dir)) {
      return failResult(`worktree path escapes worktree root: ${dir}`, "WORKTREE_PATH_ESCAPE");
    }
    if (fs.existsSync(dir)) {
      return failResult(`worktree directory already exists: ${dir}`, "WORKTREE_EXISTS");
    }
    if (!fs.existsSync(this.worktreeRoot)) {
      fs.mkdirSync(this.worktreeRoot, { recursive: true });
    }
    const res = await this.git(["worktree", "add", "--detach", dir], { cwd: this.localRepoPath });
    if (res.code !== 0) {
      return failResult(`failed to create worktree: ${res.stderr.trim()}`, "WORKTREE_CREATE_FAILED");
    }
    const checkout = await this.git(["checkout", branch], { cwd: dir });
    if (checkout.code !== 0) {
      return failResult(`failed to checkout ${branch} in worktree: ${checkout.stderr.trim()}`, "WORKTREE_CHECKOUT_FAILED");
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

  async listWorktrees(): Promise<Array<{ worktree: string; branch: string; commit: string }>> {
    const res = await this.git(["worktree", "list", "--porcelain"]);
    const infos: Array<{ worktree: string; branch: string; commit: string }> = [];
    let cur: Partial<{ worktree: string; branch: string; commit: string }> = {};
    for (const line of res.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) cur.worktree = line.slice(9);
      else if (line.startsWith("HEAD ")) cur.commit = line.slice(5).slice(0, 40);
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
      else if (line === "") {
        if (cur.worktree) infos.push(cur as { worktree: string; branch: string; commit: string });
        cur = {};
      }
    }
    if (cur.worktree) infos.push(cur as { worktree: string; branch: string; commit: string });
    return infos;
  }

  async collectDiff(dir: string): Promise<BridgeResult<{ stats: string; diff: string }>> {
    const statsRes = await this.git(["diff", "--stat"], { cwd: dir });
    const diffRes = await this.git(["diff"], { cwd: dir });
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard"], { cwd: dir });
    const untrackedFiles = untracked.stdout.trim();
    const diff = untrackedFiles.length > 0
      ? diffRes.stdout + "\nuntracked files:\n" + untrackedFiles + "\n"
      : diffRes.stdout;
    return okResult({
      stats: statsRes.stdout + (untrackedFiles.length > 0 ? "\nuntracked files:\n" + untrackedFiles : ""),
      diff,
    });
  }

  async collectChangedFiles(dir: string): Promise<string[]> {
    const tracked = await this.git(["diff", "--name-only"], { cwd: dir });
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard"], { cwd: dir });
    return [...tracked.stdout.split(/\r?\n/), ...untracked.stdout.split(/\r?\n/)].filter(Boolean);
  }

  async headSha(dir: string): Promise<BridgeResult<string>> {
    const res = await this.git(["rev-parse", "HEAD"], { cwd: dir });
    if (res.code !== 0) return failResult(res.stderr.trim(), "HEAD_SHA_FAILED");
    return okResult(res.stdout.trim());
  }

  async hasUncommittedChanges(): Promise<BridgeResult<boolean>> {
    const res = await this.git(["status", "--porcelain"]);
    if (res.code !== 0) return failResult(res.stderr.trim(), "STATUS_FAILED");
    return okResult(res.stdout.trim().length > 0);
  }

  generateBranchName(issueNumber: number, attempt: number): string {
    const suffix = attempt > 1 ? `-attempt-${attempt}` : "";
    return `${this.branchPrefix}/issue-${issueNumber}${suffix}`;
  }

  async prepareTaskWorktree(issueNumber: number, attempt: number): Promise<BridgeResult<{ branch: string; dir: string; baseSha: string }>> {
    const repoVerify = await this.verifyRepo();
    if (!repoVerify.ok) return repoVerify as unknown as unknown as BridgeResult<{ branch: string; dir: string; baseSha: string }>;
    const originVerify = await this.verifyOrigin();
    if (!originVerify.ok) return originVerify as unknown as unknown as BridgeResult<{ branch: string; dir: string; baseSha: string }>;
    const fetch = await this.fetchBaseBranch();
    if (!fetch.ok) return fetch as unknown as BridgeResult<{ branch: string; dir: string; baseSha: string }>;
    const sha = await this.getBaseSha();
    if (!sha.ok) return sha as unknown as BridgeResult<{ branch: string; dir: string; baseSha: string }>;

    const branch = this.generateBranchName(issueNumber, attempt);
    const branchExists = await this.localBranchExists(branch);
    if (branchExists) {
      return failResult(`branch ${branch} already exists`, "BRANCH_EXISTS");
    }
    const createBranch = await this.createFeatureBranch(branch, sha.data!);
    if (!createBranch.ok) return createBranch as unknown as BridgeResult<{ branch: string; dir: string; baseSha: string }>;

    const dir = this.worktreePathFor(branch);
    const wt = await this.createWorktree(branch, dir);
    if (!wt.ok) return wt as unknown as BridgeResult<{ branch: string; dir: string; baseSha: string }>;

    const clean = await this.isWorktreeClean(dir);
    if (!clean.ok) return clean as unknown as BridgeResult<{ branch: string; dir: string; baseSha: string }>;
    if (clean.data !== true) {
      return failResult(`worktree ${dir} is not clean`, "WORKTREE_DIRTY");
    }

    return okResult({ branch, dir, baseSha: sha.data! });
  }

  isWithinWorktreeRoot(dir: string): boolean {
    const resolved = path.resolve(dir);
    const root = path.resolve(this.worktreeRoot);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  async commitAll(dir: string, message: string): Promise<BridgeResult<string>> {
    const add = await this.git(["add", "-A"], { cwd: dir });
    if (add.code !== 0) return failResult(add.stderr.trim(), "GIT_ADD_FAILED");
    const commit = await this.git(
      ["-c", "user.name=Kilo Bridge", "-c", "user.email=bridge@kilobridge.local", "commit", "-m", message, "--allow-empty"],
      { cwd: dir }
    );
    if (commit.code !== 0) return failResult(commit.stderr.trim(), "GIT_COMMIT_FAILED");
    const sha = await this.headSha(dir);
    return sha;
  }

  async pushBranch(cwdOrDir: string, branch: string): Promise<BridgeResult<void>> {
    const lower = branch.toLowerCase();
    if (lower === this.baseBranch.toLowerCase() || lower === this.releaseBranch.toLowerCase()) {
      return failResult(`refusing to push protected branch ${branch}`, "PROTECTED_BRANCH");
    }
    if (!branch.startsWith(this.branchPrefix)) {
      return failResult(`branch ${branch} does not use prefix ${this.branchPrefix}`, "BRANCH_PREFIX_VIOLATION");
    }
    const res = await this.git(["push", "origin", branch], { cwd: cwdOrDir });
    if (res.code !== 0) return failResult(res.stderr.trim(), "GIT_PUSH_FAILED");
    return okResult();
  }

  async pruneWorktrees(): Promise<BridgeResult<void>> {
    const res = await this.git(["worktree", "prune"]);
    if (res.code !== 0) return failResult(res.stderr.trim(), "WORKTREE_PRUNE_FAILED");
    return okResult();
  }

  async cleanupWorktreeAndBranch(branch: string, dir: string): Promise<BridgeResult<void>> {
    await this.git(["worktree", "remove", "--force", dir], { cwd: this.localRepoPath }).catch(() => {});
    await this.git(["branch", "-D", branch], { cwd: this.localRepoPath }).catch(() => {});
    return okResult();
  }
}

export function normalizeRepoUrl(url: string): string {
  return url
    .replace(/^git@github.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github.com\//, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/^https:\/\/github.com\//, "")
    .toLowerCase();
}

export function makeIdempotencyKey(projectId: string, issueNumber: number, attempt: number): string {
  return crypto.createHash("sha256").update(`${projectId}:${issueNumber}:${attempt}`).digest("hex");
}

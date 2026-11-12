"use strict";

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { BridgeResult } from "../types";
import { okResult, failResult } from "../types";
import { runProcess } from "./process";

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
  releaseBranch?: string;
}

export interface PreparedWorktree {
  branch: string;
  dir: string;
  baseSha: string;
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

  private async git(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const dir = cwd ?? this.localRepoPath;
    // Per-invocation safe.directory: never modifies stored git config.
    return runProcess("git", ["-c", `safe.directory=${dir.replace(/\\/g, "/")}`, ...args], {
      cwd: dir,
      timeoutMs: 120_000,
    });
  }

  // ------------------------------------------------------------------
  // Repository verification (read-only against the user's main tree)
  // ------------------------------------------------------------------

  async verifyRepo(): Promise<BridgeResult<void>> {
    if (!fs.existsSync(this.localRepoPath)) {
      return failResult(`local repository path does not exist: ${this.localRepoPath}`, "REPO_PATH_MISSING");
    }
    const res = await this.git(["rev-parse", "--is-inside-work-tree"]);
    if (res.code !== 0 || !res.stdout.includes("true")) {
      return failResult(`not a git repository: ${this.localRepoPath}`, "NOT_GIT_REPO");
    }
    return okResult();
  }

  async verifyOrigin(): Promise<BridgeResult<string>> {
    // Read the stored URL directly: `git remote get-url` expands insteadOf
    // rewrites, which would mask the configured repository identity.
    const res = await this.git(["config", "--get", "remote.origin.url"]);
    if (res.code !== 0 || !res.stdout.trim()) {
      return failResult("origin remote not configured", "NO_ORIGIN");
    }
    return okResult(res.stdout.trim());
  }

  // Normalize https/ssh git URLs and compare owner/name case-insensitively.
  async verifyOriginMatches(expectedRepository: string): Promise<BridgeResult<string>> {
    const origin = await this.verifyOrigin();
    if (!origin.ok) return origin;
    const actual = normalizeRepoUrl(origin.data!);
    const expected = normalizeRepoUrl(expectedRepository);
    if (actual !== expected) {
      return failResult(`origin ${origin.data!} does not match registered repository ${expectedRepository}`, "ORIGIN_MISMATCH");
    }
    return okResult(origin.data!);
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

  async hasUncommittedChanges(): Promise<BridgeResult<boolean>> {
    const res = await this.git(["status", "--porcelain"]);
    if (res.code !== 0) {
      return failResult(`failed to read main working tree status: ${res.stderr.trim()}`, "STATUS_FAILED");
    }
    return okResult(res.stdout.trim().length > 0);
  }

  async getCurrentBranch(): Promise<BridgeResult<string>> {
    const res = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (res.code !== 0) return failResult(res.stderr.trim(), "BRANCH_READ_FAILED");
    return okResult(res.stdout.trim());
  }

  // ------------------------------------------------------------------
  // Branch / worktree lifecycle
  // ------------------------------------------------------------------

  async localBranchExists(branch: string): Promise<boolean> {
    const res = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return res.code === 0;
  }

  async remoteBranchExists(branch: string): Promise<boolean> {
    const res = await this.git(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    return res.code === 0;
  }

  async createFeatureBranch(branch: string, fromSha: string): Promise<BridgeResult<void>> {
    if (await this.localBranchExists(branch)) {
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

  // Guard: the resolved worktree directory must stay under the configured root.
  isWithinWorktreeRoot(dir: string): boolean {
    const resolved = path.resolve(dir).toLowerCase();
    const root = path.resolve(this.worktreeRoot).toLowerCase();
    return resolved.startsWith(root + path.sep);
  }

  async createWorktree(branch: string, dir: string): Promise<BridgeResult<void>> {
    if (!this.isWithinWorktreeRoot(dir)) {
      return failResult(`worktree dir escapes worktree root: ${dir}`, "WORKTREE_PATH_ESCAPE");
    }
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

  // Full task preparation: fetch base, record SHA, create branch + worktree,
  // verify clean. Conflicts stop safely; existing work is never overwritten.
  async prepareTaskWorktree(issueNumber: number, attempt: number): Promise<BridgeResult<PreparedWorktree>> {
    const repoOk = await this.verifyRepo();
    if (!repoOk.ok) return failResult(repoOk.error!, repoOk.code);
    const fetched = await this.fetchBaseBranch();
    if (!fetched.ok) return failResult(fetched.error!, fetched.code);
    const sha = await this.getBaseSha();
    if (!sha.ok) return failResult(sha.error!, sha.code);

    const branch = this.generateBranchName(issueNumber, attempt);
    const dir = this.worktreePathFor(branch);
    const branchResult = await this.createFeatureBranch(branch, sha.data!);
    if (!branchResult.ok) return failResult(branchResult.error!, branchResult.code);
    const wtResult = await this.createWorktree(branch, dir);
    if (!wtResult.ok) return failResult(wtResult.error!, wtResult.code);
    const clean = await this.isWorktreeClean(dir);
    if (!clean.ok) return failResult(clean.error!, clean.code);
    if (clean.data !== true) {
      return failResult(`freshly created worktree is not clean: ${dir}`, "WORKTREE_DIRTY");
    }
    return okResult({ branch, dir, baseSha: sha.data! });
  }

  async isWorktreeClean(dir: string): Promise<BridgeResult<boolean>> {
    const res = await this.git(["status", "--porcelain"], dir);
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
      else if (line.startsWith("HEAD ")) cur.commit = line.slice(5);
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
      else if (line === "") {
        if (cur.worktree) infos.push(cur as GitWorktreeInfo);
        cur = {};
      }
    }
    if (cur.worktree) infos.push(cur as GitWorktreeInfo);
    return infos;
  }

  // ------------------------------------------------------------------
  // Change inventory / diff (includes untracked files created by Kilo)
  // ------------------------------------------------------------------

  async collectChangedFiles(dir: string): Promise<string[]> {
    const tracked = await this.git(["diff", "--name-only", "HEAD"], dir);
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard"], dir);
    const files = new Set<string>();
    for (const line of tracked.stdout.split(/\r?\n/)) if (line.trim()) files.add(line.trim());
    for (const line of untracked.stdout.split(/\r?\n/)) if (line.trim()) files.add(line.trim());
    return [...files].sort();
  }

  async collectDiff(dir: string): Promise<BridgeResult<{ stats: string; diff: string; changedFiles: string[] }>> {
    const changedFiles = await this.collectChangedFiles(dir);
    const statsRes = await this.git(["diff", "--stat", "HEAD"], dir);
    const diffRes = await this.git(["diff", "HEAD"], dir);
    let diff = diffRes.stdout;
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard"], dir);
    const untrackedFiles = untracked.stdout.split(/\r?\n/).filter(Boolean);
    if (untrackedFiles.length > 0) {
      diff += `\n\n# Untracked files (new):\n${untrackedFiles.map((f) => `#   ${f}`).join("\n")}\n`;
    }
    let stats = statsRes.stdout;
    if (untrackedFiles.length > 0) {
      stats += `\n ${untrackedFiles.length} untracked file(s): ${untrackedFiles.join(", ")}`;
    }
    return okResult({ stats, diff, changedFiles });
  }

  async headSha(dir: string): Promise<BridgeResult<string>> {
    const res = await this.git(["rev-parse", "HEAD"], dir);
    if (res.code !== 0) return failResult(res.stderr.trim(), "HEAD_READ_FAILED");
    return okResult(res.stdout.trim());
  }

  // ------------------------------------------------------------------
  // Bridge-owned publishing operations (never executed by Kilo)
  // ------------------------------------------------------------------

  isProtectedBranch(branch: string): boolean {
    const b = branch.toLowerCase();
    return b === "main" || b === "develop" || b === this.baseBranch.toLowerCase() || b === this.releaseBranch.toLowerCase();
  }

  async commitAll(dir: string, message: string): Promise<BridgeResult<string>> {
    const add = await this.git(["add", "-A"], dir);
    if (add.code !== 0) return failResult(`git add failed: ${add.stderr.trim()}`, "COMMIT_ADD_FAILED");
    const res = await this.git(
      ["-c", "user.name=Kilo Bridge", "-c", "user.email=kilo-bridge@localhost", "commit", "-m", message],
      dir
    );
    if (res.code !== 0) return failResult(`git commit failed: ${res.stderr.trim()}`, "COMMIT_FAILED");
    return this.headSha(dir);
  }

  async pushBranch(dir: string, branch: string): Promise<BridgeResult<void>> {
    if (this.isProtectedBranch(branch)) {
      return failResult(`refusing to push protected branch ${branch}`, "PROTECTED_BRANCH");
    }
    if (!branch.startsWith(this.branchPrefix + "/")) {
      return failResult(`refusing to push branch outside prefix ${this.branchPrefix}/: ${branch}`, "BRANCH_PREFIX_VIOLATION");
    }
    const res = await this.git(["push", "-u", "origin", branch], dir);
    if (res.code !== 0) return failResult(`git push failed: ${res.stderr.trim()}`, "PUSH_FAILED");
    return okResult();
  }

  generateBranchName(issueNumber: number, attempt: number): string {
    const suffix = attempt > 1 ? `-attempt-${attempt}` : "";
    return `${this.branchPrefix}/issue-${issueNumber}${suffix}`;
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

export function normalizeRepoUrl(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/\.git$/, "");
  const ssh = u.match(/^git@[^:]+:(.+)$/);
  if (ssh) return ssh[1];
  const https = u.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (https) return https[1];
  const sshUrl = u.match(/^ssh:\/\/git@[^/]+\/(.+)$/);
  if (sshUrl) return sshUrl[1];
  return u;
}

export function makeIdempotencyKey(projectId: string, issueNumber: number, attempt: number): string {
  return crypto.createHash("sha256").update(`${projectId}:${issueNumber}:${attempt}`).digest("hex");
}
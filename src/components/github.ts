"use strict";

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import type { LabelName, BridgeResult } from "../types";

export interface GhAuth {
  authenticated: boolean;
  user?: string;
  error?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  htmlUrl: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  pullRequest: boolean;
}

export interface GitHubComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  isBridge: boolean;
}

export interface GitHubProviderOptions {
  owner: string;
  repo: string;
  cwd?: string;
}

export class GitHubProvider {
  private readonly owner: string;
  private readonly repo: string;
  private readonly cwd: string;
  private readonly ghBin: string;

  constructor(opts: GitHubProviderOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.cwd = opts.cwd ?? process.cwd();
    this.ghBin = process.env.GH_BIN ?? "gh";
  }

  // ------------------------------------------------------------------
  // Command execution (explicit argument arrays, no shell interpolation)
  // ------------------------------------------------------------------

  private async run(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(this.ghBin, args, {
        cwd: opts.cwd ?? this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        windowsHide: false,
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      if (opts.input) {
        try {
          proc.stdin.write(opts.input);
          proc.stdin.end();
        } catch {
          // ignore
        }
      }
      proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      proc.on("error", (err) =>
        resolve({ code: 127, stdout, stderr: err.message })
      );
    });
  }

  private async runJson<T = unknown>(args: string[], opts?: { cwd?: string; input?: string }): Promise<BridgeResult<T>> {
    const res = await this.run(args, opts);
    if (res.code !== 0) {
      return { ok: false, error: res.stderr.trim() || `gh exited ${res.code}`, code: String(res.code) };
    }
    const text = res.stdout.trim();
    if (!text) return { ok: true, data: undefined as unknown as T };
    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch (err) {
      return { ok: false, error: `failed to parse gh JSON output: ${err}`, code: "PARSE_ERROR" };
    }
  }

  // ------------------------------------------------------------------
  // Authentication
  // ------------------------------------------------------------------

  async authStatus(): Promise<GhAuth> {
    // gh auth status returns non-zero when not authenticated
    const res = await this.run(["auth", "status"]);
    if (res.code === 0) {
      // Parse the logged in user from stdout like "github.com: Logged in as nabeel2323"
      const m = res.stdout.match(/Logged in as\s+(\S+)/);
      return { authenticated: true, user: m ? m[1] : undefined };
    }
    return { authenticated: false, error: res.stderr.trim() || "gh not authenticated" };
  }

  async tokenAvailable(): Promise<boolean> {
    // Do not retrieve or store the token. Just check gh can authenticate.
    const res = await this.run(["auth", "token"]);
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  // ------------------------------------------------------------------
  // Labels
  // ------------------------------------------------------------------

  async listLabels(): Promise<BridgeResult<string[]>> {
    const res = await this.runJson<string[]>([
      "api",
      "repos/${owner}/${repo}/labels".replace("${owner}", this.owner).replace("${repo}", this.repo),
      "--paginate",
      "-t",
      '.[].name',
    ]);
    return res;
  }

  async ensureLabels(labels: LabelName[]): Promise<BridgeResult<{ created: string[]; exists: string[] }>> {
    const created: string[] = [];
    const exists: string[] = [];
    for (const label of labels) {
      // Check existence
      const check = await this.run([
        "label",
        "list",
        "--repo",
        `${this.owner}/${this.repo}`,
        "--search",
        label,
        "--json",
        "name",
      ]);
      if (check.code === 0 && check.stdout.trim().length > 0 && check.stdout.includes(label)) {
        exists.push(label);
        continue;
      }
      const add = await this.run([
        "label",
        "create",
        label,
        "--repo",
        `${this.owner}/${this.repo}`,
        "--force",
      ]);
      if (add.code !== 0) {
        return { ok: false, error: `failed to create label ${label}: ${add.stderr.trim()}`, code: "LABEL_CREATE_FAILED" };
      }
      created.push(label);
    }
    return { ok: true, data: { created, exists } };
  }

  async addLabels(issueNumber: number, labels: LabelName[]): Promise<BridgeResult<void>> {
    if (labels.length === 0) return { ok: true };
    const res = await this.run([
      "label",
      "add",
      String(issueNumber),
      ...labels,
      "--repo",
      `${this.owner}/${this.repo}`,
    ]);
    if (res.code !== 0) {
      return { ok: false, error: res.stderr.trim() || `gh label add exited ${res.code}`, code: "LABEL_ADD_FAILED" };
    }
    return { ok: true };
  }

  async removeLabel(issueNumber: number, label: LabelName): Promise<BridgeResult<void>> {
    const res = await this.run([
      "label",
      "remove",
      String(issueNumber),
      label,
      "--repo",
      `${this.owner}/${this.repo}`,
    ]);
    if (res.code !== 0) {
      // label may already be absent; treat missing as ok
      if (res.stderr.includes("not found") || res.stderr.includes("404")) return { ok: true };
      return { ok: false, error: res.stderr.trim() || `gh label remove exited ${res.code}`, code: "LABEL_REMOVE_FAILED" };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Issues
  // ------------------------------------------------------------------

  async listOpenIssues(opts: { labels?: string[]; limit?: number } = {}): Promise<BridgeResult<GitHubIssue[]>> {
    const args: string[] = [
      "issue",
      "list",
      "--repo",
      `${this.owner}/${this.repo}`,
      "--state",
      "open",
      "--json",
      "number,title,body,state,url,htmlUrl,author,createdAt,updatedAt,labels,isPullRequest",
      "--limit",
      String(opts.limit ?? 100),
    ];
    if (opts.labels && opts.labels.length > 0) {
      args.push("--label", opts.labels.join(","));
    }
    return this.runJson<GitHubIssue[]>(args);
  }

  async getIssue(issueNumber: number): Promise<BridgeResult<GitHubIssue>> {
    return this.runJson<GitHubIssue>([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      `${this.owner}/${this.repo}`,
      "--json",
      "number,title,body,state,url,htmlUrl,author,createdAt,updatedAt,labels,isPullRequest",
    ]);
  }

  // ------------------------------------------------------------------
  // Comments
  // ------------------------------------------------------------------

  async listComments(issueNumber: number): Promise<BridgeResult<GitHubComment[]>> {
    const res = await this.runJson<GitHubComment[]>(
      [
        "api",
        "repos/${owner}/${repo}/issues/${number}/comments".replace("${owner}", this.owner)
          .replace("${repo}", this.repo)
          .replace("${number}", String(issueNumber)),
        "--paginate",
        "-t",
        '.[].{id, body, user: {login}, created_at}',
      ],
      { cwd: this.cwd }
    );
    if (!res.ok || !res.data) return { ok: true, data: [] };
    const arr = res.data as any[];
    return {
      ok: true,
      data: arr.map((c) => ({
        id: c.id,
        body: c.body ?? "",
        author: c.user?.login ?? "",
        createdAt: c.created_at ?? "",
        isBridge: this.isBridgeComment(c.body),
      })),
    };
  }

  async addComment(issueNumber: number, body: string): Promise<BridgeResult<number>> {
    const res = await this.run(
      [
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        `${this.owner}/${this.repo}`,
        "--body",
        body,
      ],
      { cwd: this.cwd }
    );
    if (res.code !== 0) {
      return { ok: false, error: res.stderr.trim() || `gh issue comment exited ${res.code}`, code: "COMMENT_ADD_FAILED" };
    }
    // gh issue comment does not return the new comment id reliably; parse if present
    const m = res.stdout.match(/comment (#?\d+)/i);
    return { ok: true, data: m ? parseInt(m[1], 10) : -1 };
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private isBridgeComment(body: string): boolean {
    return body.includes("[kilo-bridge-report]") || body.includes("Kilo Bridge");
  }

  fullRepo(): string {
    return `${this.owner}/${this.repo}`;
  }
}

export function ghMissingError(): BridgeResult<never> {
  return {
    ok: false,
    error: "GitHub CLI (gh) is not installed or not on PATH. Install GitHub CLI and authenticate with 'gh auth login'.",
    code: "GH_NOT_FOUND",
  };
}

export function isGhNotFound(stderr: string): boolean {
  return /not recognized|not found|no such file|command not found/i.test(stderr);
}

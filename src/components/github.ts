"use strict";

import { spawn } from "node:child_process";
import type { BridgeResult, okResult, failResult, LabelName } from "../types";

export interface GitHubAuth {
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
  ghBin?: string;
  ghPrefixArgs?: string[];
}

export class GitHubProvider {
  private readonly owner: string;
  private readonly repo: string;
  private readonly cwd: string;
  private readonly ghBin: string;
  private readonly ghPrefixArgs: string[];

  constructor(opts: GitHubProviderOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.cwd = opts.cwd ?? process.cwd();
    this.ghBin = opts.ghBin ?? process.env.KILO_GH_BIN ?? process.env.GH_BIN ?? "gh";
    this.ghPrefixArgs = opts.ghPrefixArgs ?? [];
  }

  private repoPath(): string {
    return "repos/" + this.owner + "/" + this.repo;
  }

  private async run(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const fullArgs = [...this.ghPrefixArgs, ...args];
    return new Promise((resolve) => {
      const proc = spawn(this.ghBin, fullArgs, {
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
        try { proc.stdin.write(opts.input); proc.stdin.end(); } catch { /* ignore */ }
      } else {
        try { proc.stdin.end(); } catch { /* ignore */ }
      }
      proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      proc.on("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
    });
  }

  private async runJson<T = unknown>(args: string[], opts?: { cwd?: string; input?: string }): Promise<BridgeResult<T>> {
    const res = await this.run(args, opts);
    if (res.code !== 0) {
      const lower = res.stderr.toLowerCase();
      let code: string | undefined;
      if (/rate limit/i.test(lower)) code = "RATE_LIMITED";
      else if (res.code === 127) code = "GH_NOT_FOUND";
      return { ok: false, error: res.stderr.trim() || "gh exited " + res.code, code };
    }
    const text = res.stdout.trim();
    if (!text) return { ok: true, data: undefined as unknown as T };
    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch (err) {
      return { ok: false, error: "failed to parse gh JSON output: " + err, code: "PARSE_ERROR" };
    }
  }

  async authStatus(): Promise<GitHubAuth> {
    const res = await this.run(["auth", "status"]);
    if (res.code === 0) {
      const output = res.stderr || res.stdout;
      const m = output.match(/Logged in as\s+(\S+)/);
      return { authenticated: true, user: m ? m[1] : undefined };
    }
    return { authenticated: false, error: res.stderr.trim() || "gh not authenticated" };
  }

  async tokenAvailable(): Promise<boolean> {
    const res = await this.run(["auth", "token"]);
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  async listLabels(): Promise<BridgeResult<string[]>> {
    const res = await this.runJson<string[]>([
      "api",
      this.repoPath() + "/labels?per_page=100",
      "--paginate",
      "-t",
      '.[].name',
    ]);
    return res;
  }

  async ensureLabels(labels: readonly LabelName[]): Promise<BridgeResult<{ created: string[]; exists: string[] }>> {
    const created: string[] = [];
    const exists: string[] = [];
    const list = await this.listLabels();
    const items = Array.isArray(list.data) ? (list.data as any[]) : [];
    const present = new Set(items.map((n) => (typeof n === "string" ? n : (n && n.name ? String(n.name) : ""))).filter(Boolean).map((n) => n.toLowerCase()));
    for (const label of labels) {
      if (present.has(label.toLowerCase())) {
        exists.push(label);
        continue;
      }
      const add = await this.run([
        "api",
        this.repoPath() + "/labels",
        "-X", "POST",
        "-f", "name=" + label,
        "-f", "color=" + labelHash(label),
        "-f", "description=Kilo Bridge " + label,
      ]);
      if (add.code !== 0) {
        return { ok: false, error: "failed to create label " + label + ": " + add.stderr.trim(), code: "LABEL_CREATE_FAILED" };
      }
      created.push(label);
      present.add(label.toLowerCase());
    }
    return { ok: true, data: { created, exists } };
  }

  async addLabels(issueNumber: number, labels: LabelName[]): Promise<BridgeResult<void>> {
    if (labels.length === 0) return { ok: true };
    const stdin = JSON.stringify({ labels });
    const res = await this.run([
      "api",
      this.repoPath() + "/issues/" + issueNumber + "/labels",
      "-X", "POST",
      "--input", "-",
    ], { input: stdin });
    if (res.code !== 0) {
      return { ok: false, error: res.stderr.trim() || "gh label add exited " + res.code, code: "LABEL_ADD_FAILED" };
    }
    return { ok: true };
  }

  async removeLabel(issueNumber: number, label: LabelName): Promise<BridgeResult<void>> {
    const res = await this.run([
      "api",
      this.repoPath() + "/issues/" + issueNumber + "/labels/" + encodeURIComponent(label),
      "-X", "DELETE",
    ]);
    if (res.code !== 0) {
      if (res.stderr.includes("404") || res.stderr.includes("not found")) return { ok: true };
      return { ok: false, error: res.stderr.trim() || "gh label remove exited " + res.code, code: "LABEL_REMOVE_FAILED" };
    }
    return { ok: true };
  }

  async listOpenIssues(opts: { labels?: string[]; limit?: number } = {}): Promise<BridgeResult<GitHubIssue[]>> {
    let endpoint = this.repoPath() + "/issues?state=open&per_page=100";
    if (opts.labels && opts.labels.length > 0) {
      endpoint += "&labels=" + opts.labels.join(",");
    }
    const res = await this.runJson<any[]>(["api", endpoint, "--paginate"]);
    if (!res.ok) return res;
    if (!res.data) return { ok: true, data: [] };
    const issues: GitHubIssue[] = [];
    for (const raw of res.data) {
      if (raw.pull_request) continue;
      issues.push({
        number: raw.number,
        title: raw.title ?? "",
        body: raw.body ?? "",
        state: raw.state ?? "open",
        url: raw.url ?? "",
        htmlUrl: raw.html_url ?? raw.url ?? "",
        author: raw.user?.login ?? "",
        createdAt: raw.created_at ?? "",
        updatedAt: raw.updated_at ?? "",
        labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => l.name).filter(Boolean) : [],
        pullRequest: Boolean(raw.pull_request),
      });
    }
    return { ok: true, data: issues };
  }

  async getIssue(issueNumber: number): Promise<BridgeResult<GitHubIssue>> {
    const res = await this.runJson<any>([
      "api",
      this.repoPath() + "/issues/" + issueNumber,
    ]);
    if (!res.ok || !res.data) return res;
    const raw = res.data;
    const issue: GitHubIssue = {
      number: raw.number,
      title: raw.title ?? "",
      body: raw.body ?? "",
      state: raw.state ?? "open",
      url: raw.url ?? "",
      htmlUrl: raw.html_url ?? raw.url ?? "",
      author: raw.user?.login ?? "",
      createdAt: raw.created_at ?? "",
      updatedAt: raw.updated_at ?? "",
      labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => l.name).filter(Boolean) : [],
      pullRequest: Boolean(raw.pull_request),
    };
    return { ok: true, data: issue };
  }

  async listComments(issueNumber: number): Promise<BridgeResult<GitHubComment[]>> {
    const res = await this.runJson<any[]>([
      "api",
      this.repoPath() + "/issues/" + issueNumber + "/comments?per_page=100",
      "--paginate",
    ]);
    if (!res.ok || !res.data) return { ok: true, data: [] };
    return {
      ok: true,
      data: res.data.map((c) => ({
        id: c.id,
        body: c.body ?? "",
        author: c.user?.login ?? "",
        createdAt: c.created_at ?? "",
        isBridge: this.isBridgeComment(c.body),
      })),
    };
  }

  async addComment(issueNumber: number, body: string): Promise<BridgeResult<number>> {
    const stdin = JSON.stringify({ body });
    const res = await this.run(
      [
        "api",
        this.repoPath() + "/issues/" + issueNumber + "/comments",
        "-X", "POST",
        "--input", "-",
      ],
      { input: stdin }
    );
    if (res.code !== 0) {
      return { ok: false, error: res.stderr.trim() || "gh issue comment exited " + res.code, code: "COMMENT_ADD_FAILED" };
    }
    try {
      const parsed = JSON.parse(res.stdout.trim());
      return { ok: true, data: parsed.id };
    } catch {
      return { ok: true, data: -1 };
    }
  }

  async createDraftPr(opts: { title: string; body: string; head: string; base: string }): Promise<BridgeResult<string>> {
    const res = await this.run(
      [
        "pr", "create",
        "--title", opts.title,
        "--body", opts.body,
        "--head", opts.head,
        "--base", opts.base,
        "--draft",
      ]
    );
    if (res.code !== 0) {
      return { ok: false, error: res.stderr.trim() || "gh pr create exited " + res.code, code: "PR_CREATE_FAILED" };
    }
    return { ok: true, data: res.stdout.trim() };
  }

  async getRateLimit(): Promise<BridgeResult<{ remaining: number; limit: number; reset: number }>> {
    const res = await this.runJson<{ resources: { core: { remaining: number; limit: number; reset: number } } }>([
      "api", "rate_limit",
    ]);
    if (!res.ok || !res.data) return { ok: false, error: res.error || "rate limit unknown", code: "RATE_LIMIT_FAILED" };
    return { ok: true, data: res.data.resources.core };
  }

  private isBridgeComment(body: string): boolean {
    return body.includes("[kilo-bridge-report]");
  }

  fullRepo(): string {
    return this.owner + "/" + this.repo;
  }
}

function labelHash(label: string): string {
  let h = 0;
  for (const ch of label) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  const hex = (0x1000000 + (h >>> 0) % 0xffffff).toString(16).slice(1, 7);
  return hex;
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

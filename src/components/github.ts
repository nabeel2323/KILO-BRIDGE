"use strict";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { LabelName, BridgeResult } from "../types";
import { okResult, failResult, KILO_READY_MARKER } from "../types";
import { runProcess } from "./process";

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
  ghBin?: string;
  ghPrefixArgs?: string[];
}

const DEFAULT_GH_FALLBACK = "C:\\Program Files\\GitHub CLI\\gh.exe";

const LABEL_COLORS: Record<string, { color: string; description: string }> = {
  "kilo:ready": { color: "0e8a16", description: "Kilo Bridge: task ready for execution" },
  "kilo:claimed": { color: "fbca04", description: "Kilo Bridge: task claimed by a worker" },
  "kilo:running": { color: "1d76db", description: "Kilo Bridge: task execution in progress" },
  "kilo:report-ready": { color: "5319e7", description: "Kilo Bridge: implementation report available" },
  "kilo:blocked": { color: "d93f0b", description: "Kilo Bridge: task blocked" },
  "kilo:failed": { color: "b60205", description: "Kilo Bridge: task failed" },
  "kilo:changes-requested": { color: "f9d0c4", description: "Kilo Bridge: corrections requested" },
  "kilo:publish-approved": { color: "0075ca", description: "Kilo Bridge: publishing approved by authorized user" },
  "kilo:published": { color: "006b75", description: "Kilo Bridge: feature branch published as draft PR" },
  "kilo:done": { color: "c5def5", description: "Kilo Bridge: task closed out" },
};

// GitHub communication provider. All operations go through authenticated
// `gh api` / `gh` commands with explicit argument arrays. No tokens are ever
// read, stored, or logged (spec §5).
export class GitHubProvider {
  private readonly owner: string;
  private readonly repo: string;
  private readonly cwd: string;
  private readonly ghBin: string;
  private readonly ghPrefixArgs: string[];
  private resolvedBin: string | null = null;

  constructor(opts: GitHubProviderOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.cwd = opts.cwd ?? process.cwd();
    this.ghBin = opts.ghBin ?? process.env.GH_BIN ?? "gh";
    this.ghPrefixArgs = opts.ghPrefixArgs ?? [];
  }

  fullRepo(): string {
    return `${this.owner}/${this.repo}`;
  }

  private apiPath(suffix: string): string {
    return `repos/${this.owner}/${this.repo}${suffix}`;
  }

  private async run(args: string[], opts: { input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const bin = this.resolvedBin ?? this.ghBin;
    let res = await runProcess(bin, [...this.ghPrefixArgs, ...args], { cwd: this.cwd, input: opts.input, timeoutMs: 120_000 });
    // gh may be installed but absent from this session's PATH (Windows).
    if (res.code === 127 && bin === "gh" && this.ghPrefixArgs.length === 0 && fs.existsSync(DEFAULT_GH_FALLBACK)) {
      this.resolvedBin = DEFAULT_GH_FALLBACK;
      res = await runProcess(this.resolvedBin, args, { cwd: this.cwd, input: opts.input, timeoutMs: 120_000 });
    }
    return res;
  }

  private classifyError(stderr: string, code: number): string {
    if (/rate limit|api rate|403|429|secondary rate/i.test(stderr)) return "RATE_LIMITED";
    if (/401|bad credentials|authentication|not logged/i.test(stderr)) return "GH_NOT_AUTHENTICATED";
    if (/404|not found/i.test(stderr)) return "NOT_FOUND";
    return `GH_EXIT_${code}`;
  }

  private async runJson<T>(args: string[], opts: { input?: string } = {}): Promise<BridgeResult<T>> {
    const res = await this.run(args, opts);
    if (res.code !== 0) {
      return failResult(res.stderr.trim() || `gh exited ${res.code}`, this.classifyError(res.stderr, res.code));
    }
    const text = res.stdout.trim();
    if (!text) return okResult(undefined as unknown as T);
    try {
      return okResult(JSON.parse(text) as T);
    } catch (err) {
      return failResult(`failed to parse gh JSON output: ${err}`, "PARSE_ERROR");
    }
  }

  // ------------------------------------------------------------------
  // Authentication
  // ------------------------------------------------------------------

  async authStatus(): Promise<GhAuth> {
    const res = await this.run(["auth", "status"]);
    // gh writes auth status to stderr in recent versions; check both streams.
    const output = res.stdout + "\n" + res.stderr;
    if (res.code === 0) {
      const m = output.match(/Logged in as\s+(\S+)/);
      return { authenticated: true, user: m ? m[1] : undefined };
    }
    return { authenticated: false, error: output.trim() || "gh not authenticated" };
  }

  async getRateLimit(): Promise<BridgeResult<{ remaining: number; limit: number; reset: number }>> {
    const res = await this.runJson<any>(["api", "rate_limit"]);
    if (!res.ok) return failResult(res.error!, res.code);
    const core = res.data?.resources?.core;
    return okResult({ remaining: core?.remaining ?? -1, limit: core?.limit ?? -1, reset: core?.reset ?? 0 });
  }

  async getRepo(): Promise<BridgeResult<{ fullName: string; private: boolean; permissions?: Record<string, boolean> }>> {
    const res = await this.runJson<any>(["api", this.apiPath("")]);
    if (!res.ok) return failResult(res.error!, res.code);
    return okResult({ fullName: res.data.full_name, private: res.data.private, permissions: res.data.permissions });
  }

  // ------------------------------------------------------------------
  // Labels
  // ------------------------------------------------------------------

  async listLabels(): Promise<BridgeResult<string[]>> {
    const res = await this.runJson<any[]>(["api", this.apiPath("/labels?per_page=100"), "--paginate"]);
    if (!res.ok) return failResult(res.error!, res.code);
    return okResult((res.data ?? []).map((l) => String(l.name)));
  }

  async ensureLabels(labels: readonly LabelName[]): Promise<BridgeResult<{ created: string[]; exists: string[] }>> {
    const existing = await this.listLabels();
    if (!existing.ok) return failResult(existing.error!, existing.code);
    const existingSet = new Set(existing.data!);
    const created: string[] = [];
    const exists: string[] = [];
    for (const label of labels) {
      if (existingSet.has(label)) {
        exists.push(label);
        continue;
      }
      const meta = LABEL_COLORS[label] ?? { color: "ededed", description: "Kilo Bridge" };
      const res = await this.run([
        "api", "-X", "POST", this.apiPath("/labels"),
        "-f", `name=${label}`,
        "-f", `color=${meta.color}`,
        "-f", `description=${meta.description}`,
      ]);
      if (res.code !== 0) {
        // Race: another process created it meanwhile.
        if (/already_exists|422/i.test(res.stderr)) {
          exists.push(label);
          continue;
        }
        return failResult(`failed to create label ${label}: ${res.stderr.trim()}`, "LABEL_CREATE_FAILED");
      }
      created.push(label);
    }
    return okResult({ created, exists });
  }

  async addLabels(issueNumber: number, labels: readonly LabelName[]): Promise<BridgeResult<void>> {
    if (labels.length === 0) return okResult();
    const res = await this.run(
      ["api", "-X", "POST", this.apiPath(`/issues/${issueNumber}/labels`), "--input", "-"],
      { input: JSON.stringify({ labels: [...labels] }) }
    );
    if (res.code !== 0) {
      return failResult(res.stderr.trim() || `label add exited ${res.code}`, "LABEL_ADD_FAILED");
    }
    return okResult();
  }

  async removeLabel(issueNumber: number, label: LabelName): Promise<BridgeResult<void>> {
    const res = await this.run([
      "api", "-X", "DELETE",
      this.apiPath(`/issues/${issueNumber}/labels/${encodeURIComponent(label)}`),
    ]);
    if (res.code !== 0) {
      if (/not found|404/i.test(res.stderr)) return okResult(); // already absent
      return failResult(res.stderr.trim() || `label remove exited ${res.code}`, "LABEL_REMOVE_FAILED");
    }
    return okResult();
  }

  // ------------------------------------------------------------------
  // Issues (REST via gh api; PRs are filtered out — spec §5)
  // ------------------------------------------------------------------

  private normalizeIssue(raw: any): GitHubIssue {
    return {
      number: Number(raw.number),
      title: String(raw.title ?? ""),
      body: String(raw.body ?? ""),
      state: String(raw.state ?? ""),
      url: String(raw.url ?? ""),
      htmlUrl: String(raw.html_url ?? ""),
      author: String(raw.user?.login ?? ""),
      createdAt: String(raw.created_at ?? ""),
      updatedAt: String(raw.updated_at ?? ""),
      labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => String(l.name ?? l)) : [],
      pullRequest: Boolean(raw.pull_request),
    };
  }

  async listOpenIssues(opts: { labels?: string[]; limit?: number } = {}): Promise<BridgeResult<GitHubIssue[]>> {
    const params = new URLSearchParams({ state: "open", per_page: "100" });
    if (opts.labels && opts.labels.length > 0) params.set("labels", opts.labels.join(","));
    const res = await this.runJson<any[]>(["api", this.apiPath(`/issues?${params.toString()}`), "--paginate"]);
    if (!res.ok) return failResult(res.error!, res.code);
    const issues = (res.data ?? [])
      .map((r) => this.normalizeIssue(r))
      .filter((i) => !i.pullRequest); // never trust PRs from the Issues API
    return okResult(issues.slice(0, opts.limit ?? 100));
  }

  async getIssue(issueNumber: number): Promise<BridgeResult<GitHubIssue>> {
    const res = await this.runJson<any>(["api", this.apiPath(`/issues/${issueNumber}`)]);
    if (!res.ok) return failResult(res.error!, res.code);
    return okResult(this.normalizeIssue(res.data));
  }

  // ------------------------------------------------------------------
  // Comments
  // ------------------------------------------------------------------

  async listComments(issueNumber: number): Promise<BridgeResult<GitHubComment[]>> {
    const res = await this.runJson<any[]>(["api", this.apiPath(`/issues/${issueNumber}/comments?per_page=100`), "--paginate"]);
    if (!res.ok) return failResult(res.error!, res.code);
    const comments = (res.data ?? []).map((c) => ({
      id: Number(c.id),
      body: String(c.body ?? ""),
      author: String(c.user?.login ?? ""),
      createdAt: String(c.created_at ?? ""),
      isBridge: this.isBridgeComment(String(c.body ?? "")),
    }));
    return okResult(comments);
  }

  async addComment(issueNumber: number, body: string): Promise<BridgeResult<number>> {
    // Body via stdin JSON file: no argument-length limits, no interpolation.
    const res = await this.runJson<any>(
      ["api", "-X", "POST", this.apiPath(`/issues/${issueNumber}/comments`), "--input", "-"],
      { input: JSON.stringify({ body }) }
    );
    if (!res.ok) return failResult(res.error!, res.code);
    return okResult(Number(res.data?.id ?? -1));
  }

  // ------------------------------------------------------------------
  // Pull requests (draft only; never merged by the Bridge)
  // ------------------------------------------------------------------

  async createDraftPr(opts: { title: string; body: string; head: string; base: string }): Promise<BridgeResult<string>> {
    const tmp = path.join(os.tmpdir(), `kilo-bridge-pr-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    try {
      fs.writeFileSync(tmp, opts.body, "utf8");
      const res = await this.run([
        "pr", "create",
        "--draft",
        "--repo", this.fullRepo(),
        "--head", opts.head,
        "--base", opts.base,
        "--title", opts.title,
        "--body-file", tmp,
      ]);
      if (res.code !== 0) {
        return failResult(res.stderr.trim() || `gh pr create exited ${res.code}`, "PR_CREATE_FAILED");
      }
      const url = res.stdout.trim().split(/\r?\n/).pop() ?? "";
      if (!/^https:\/\//.test(url)) {
        return failResult(`could not parse PR URL from gh output: ${res.stdout.trim()}`, "PR_URL_PARSE_FAILED");
      }
      return okResult(url);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  // Only the unique machine-readable marker identifies Bridge comments.
  // Title/body text alone is never trusted (spec §5).
  private isBridgeComment(body: string): boolean {
    return body.includes(KILO_READY_MARKER);
  }
}

export function ghMissingError(): BridgeResult<never> {
  return failResult(
    "GitHub CLI (gh) is not installed or not on PATH. Install GitHub CLI and authenticate with 'gh auth login'.",
    "GH_NOT_FOUND"
  );
}

export function isGhNotFound(stderr: string): boolean {
  return /not recognized|not found|no such file|command not found|ENOENT/i.test(stderr);
}
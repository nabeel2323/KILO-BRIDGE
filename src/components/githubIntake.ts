"use strict";

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { BridgeConfig } from "../config";
import { SqliteStore } from "../db";
import type {
  BridgeResult,
  GitHubIntakeClaim,
  LabelName,
  ProjectConfig,
  TaskRecord,
} from "../types";
import { failResult, okResult } from "../types";
import { ProjectRegistry } from "./registry";
import { GitHubProvider, type GitHubIssue } from "./github";
import { LifecycleManager } from "./lifecycle";
import { ExclusiveProcessLock } from "./processLock";

const READY_LABEL = "kilo:ready";
const CLAIMED_LABEL = "kilo:claimed";
const RUNNING_LABEL = "kilo:running";
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 48 * 1024;
const CLAIM_GENERATION = 1;

export interface GitHubIntakeDispatcher {
  /** Must return true only when the production-isolated execution path is fully available. */
  isReady(): boolean | Promise<boolean>;
  /** Starts the task asynchronously using the secured task runner. Must never fall back to host Kilo. */
  dispatch(task: TaskRecord, claim: GitHubIntakeClaim): Promise<BridgeResult<{ executionId: string }>>;
}

export interface GitHubIntakeProvider {
  authStatus(): Promise<{ authenticated: boolean; user?: string; error?: string }>;
  listOpenIssues(opts?: { labels?: string[]; limit?: number }): Promise<BridgeResult<GitHubIssue[]>>;
  getIssue(issueNumber: number): Promise<BridgeResult<GitHubIssue>>;
  addLabels(issueNumber: number, labels: LabelName[]): Promise<BridgeResult<void>>;
}

export interface GitHubIntakeOptions {
  bridgeRoot: string;
  config: Pick<BridgeConfig,
    "githubIntakeEnabled" | "githubIntakeAllowedRepositories" |
    "ghEnabled" | "kiloEnabled" | "workerEnabled" | "defaultTaskTimeoutMs"
  >;
  store: SqliteStore;
  registry: ProjectRegistry;
  dispatcher: GitHubIntakeDispatcher;
  githubFactory?: (project: ProjectConfig) => GitHubIntakeProvider;
  lockFactory?: (lockPath: string, owner: string) => ExclusiveProcessLock;
  workerId?: string;
}

export interface GitHubIntakePollResult {
  repositoriesChecked: number;
  issuesDiscovered: number;
  issuesEligible: number;
  claimsCreated: number;
  tasksCreated: number;
  executionsStarted: number;
  skipped: number;
  errors: string[];
}

function normalizeRepository(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(normalized) ? normalized : null;
}

function validIssueUrl(value: string, repository: string, issueNumber: number): boolean {
  try {
    const url = new URL(value);
    const expectedPath = `/${repository}/issues/${issueNumber}`;
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      url.pathname.replace(/\/$/, "").toLowerCase() === expectedPath.toLowerCase() &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function hasLabel(issue: GitHubIssue, label: string): boolean {
  return issue.labels.some((value) => value.toLowerCase() === label);
}

function validateIssue(
  issue: GitHubIssue,
  repository: string,
  allowedAuthors: string[]
): string | null {
  if (!Number.isSafeInteger(issue.number) || issue.number <= 0) return "invalid Issue number";
  if (issue.state.toLowerCase() !== "open") return "Issue is not open";
  if (issue.pullRequest) return "pull requests are not eligible";
  if (!hasLabel(issue, READY_LABEL)) return "required kilo:ready label is missing";
  if (!issue.author || !allowedAuthors.some((author) => author.toLowerCase() === issue.author.toLowerCase())) {
    return "Issue author is not in the project allowlist";
  }
  if (!issue.title.trim() || issue.title.length > MAX_TITLE_LENGTH) return "Issue title is empty or too long";
  if (!issue.body.trim() || issue.body.length > MAX_BODY_LENGTH) return "Issue body is empty or exceeds the size limit";
  if (!validIssueUrl(issue.htmlUrl, repository, issue.number)) return "Issue URL does not match the trusted repository";
  return null;
}

export class GitHubIntakeService {
  private readonly opts: GitHubIntakeOptions;
  private readonly store: SqliteStore;
  private readonly registry: ProjectRegistry;
  private readonly lock: ExclusiveProcessLock;
  private running = false;
  private stopRequested = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: GitHubIntakeOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.registry = opts.registry;
    const owner = opts.workerId ?? `github-intake:${os.hostname()}:${process.pid}`;
    this.lock = opts.lockFactory
      ? opts.lockFactory(path.join(opts.bridgeRoot, "data", "github-intake.lock"), owner)
      : new ExclusiveProcessLock(path.join(opts.bridgeRoot, "data", "github-intake.lock"), owner);
  }

  getState(): { running: boolean; enabled: boolean; repositories: string[] } {
    return {
      running: this.running && !this.stopRequested,
      enabled: this.opts.config.githubIntakeEnabled,
      repositories: [...this.opts.config.githubIntakeAllowedRepositories],
    };
  }

  async pollOnce(): Promise<BridgeResult<GitHubIntakePollResult>> {
    const empty = (): GitHubIntakePollResult => ({
      repositoriesChecked: 0, issuesDiscovered: 0, issuesEligible: 0,
      claimsCreated: 0, tasksCreated: 0, executionsStarted: 0, skipped: 0, errors: [],
    });
    if (this.opts.config.githubIntakeEnabled !== true) {
      return failResult("dedicated GitHub intake is disabled", "GITHUB_INTAKE_DISABLED");
    }
    if (this.opts.config.ghEnabled !== true || this.opts.config.kiloEnabled !== true) {
      return failResult("GitHub and Kilo prerequisites must both be enabled before intake", "INTAKE_PREREQUISITES_DISABLED");
    }
    const trusted = new Set(
      this.opts.config.githubIntakeAllowedRepositories.map(normalizeRepository).filter((v): v is string => Boolean(v))
    );
    if (trusted.size === 0) return failResult("no trusted GitHub repositories are configured", "INTAKE_NO_TRUSTED_REPOSITORIES");

    // workerEnabled is intentionally not consulted here: GitHub intake is a separate gate.
    // Do not even inspect GitHub until a production-isolated execution backend is ready.
    let executionReady = false;
    try { executionReady = await this.opts.dispatcher.isReady(); } catch { executionReady = false; }
    if (!executionReady) {
      return failResult("production-isolated task execution is not ready; intake remains fail-closed", "INTAKE_EXECUTION_BACKEND_NOT_READY");
    }

    const lock = this.lock.acquire();
    if (!lock.ok) return failResult(lock.error ?? "another GitHub intake process owns the lock", lock.code ?? "INTAKE_LOCK_FAILED");

    const result = empty();
    try {
      const projects = this.registry.list()
        .filter((entry) => entry.state === "active" && entry.config.state === "active")
        .filter((entry) => trusted.has(normalizeRepository(entry.config.repository) ?? ""));
      const byRepository = new Map<string, ProjectConfig[]>();
      for (const entry of projects) {
        const repository = normalizeRepository(entry.config.repository);
        if (!repository) continue;
        const group = byRepository.get(repository) ?? [];
        group.push(entry.config);
        byRepository.set(repository, group);
      }

      for (const [repository, mappedProjects] of byRepository) {
        if (mappedProjects.length !== 1) {
          result.errors.push(`${repository}: repository maps to more than one active project; refusing intake`);
          result.skipped += 1;
          continue;
        }
        const project = mappedProjects[0];
        const provider = this.opts.githubFactory
          ? this.opts.githubFactory(project)
          : this.defaultProvider(project);
        result.repositoriesChecked += 1;

        const auth = await provider.authStatus();
        if (!auth.authenticated) {
          result.errors.push(`${repository}: GitHub authentication unavailable`);
          continue;
        }
        const listed = await provider.listOpenIssues({ labels: [READY_LABEL] });
        if (!listed.ok || !listed.data) {
          result.errors.push(`${repository}: failed to list ready Issues: ${listed.error ?? "unknown provider error"}`);
          continue;
        }

        for (const candidate of listed.data) {
          result.issuesDiscovered += 1;
          const reason = validateIssue(candidate, repository, project.allowedAuthors);
          if (reason) {
            result.skipped += 1;
            this.audit(project.id, "github_intake.issue_rejected", { repository, issue: candidate.number, reason });
            continue;
          }

          // Re-fetch the Issue immediately before claiming to avoid relying on stale list data.
          const fresh = await provider.getIssue(candidate.number);
          if (!fresh.ok || !fresh.data) {
            result.errors.push(`${repository}#${candidate.number}: could not revalidate Issue before claim`);
            result.skipped += 1;
            continue;
          }
          const freshReason = validateIssue(fresh.data, repository, project.allowedAuthors);
          if (freshReason) {
            result.skipped += 1;
            this.audit(project.id, "github_intake.issue_rejected_after_refresh", { repository, issue: candidate.number, reason: freshReason });
            continue;
          }

          result.issuesEligible += 1;
          if (this.store.getGitHubIntakeClaim(repository, candidate.number, CLAIM_GENERATION)) {
            result.skipped += 1;
            continue;
          }
          if (this.store.getTaskByProjectIssue(project.id, candidate.number)) {
            result.errors.push(`${repository}#${candidate.number}: an existing Bridge task already owns this project/Issue; manual reconciliation required`);
            result.skipped += 1;
            continue;
          }

          const now = new Date().toISOString();
          const claim: GitHubIntakeClaim = {
            id: crypto.randomUUID(),
            repositoryFullName: repository,
            issueNumber: candidate.number,
            assignmentGeneration: CLAIM_GENERATION,
            projectId: project.id,
            status: "CLAIMED",
            claimOwner: `github-intake:${os.hostname()}:${process.pid}`,
            claimToken: crypto.randomUUID(),
            claimedAt: now,
            updatedAt: now,
            leaseExpiresAt: new Date(Date.now() + this.opts.config.defaultTaskTimeoutMs + 15 * 60_000).toISOString(),
          };
          if (!this.store.insertGitHubIntakeClaim(claim)) {
            result.skipped += 1;
            continue;
          }
          result.claimsCreated += 1;
          this.audit(project.id, "github_intake.claim_created", { repository, issue: candidate.number, claimId: claim.id });

          const labelled = await provider.addLabels(candidate.number, [CLAIMED_LABEL]);
          if (!labelled.ok) {
            this.store.updateGitHubIntakeClaim(claim.id, {
              status: "RECONCILIATION_REQUIRED",
              lastError: "claim persisted but kilo:claimed label mutation failed",
            });
            result.errors.push(`${repository}#${candidate.number}: claim persisted but GitHub claim label failed; manual reconciliation required`);
            continue;
          }

          const taskId = `task-${crypto.randomUUID()}`;
          const timestamp = new Date().toISOString();
          const task: TaskRecord = {
            id: taskId,
            projectId: project.id,
            issueNumber: candidate.number,
            issueUrl: fresh.data.htmlUrl,
            title: fresh.data.title,
            author: fresh.data.author,
            body: fresh.data.body,
            status: "READY",
            attempt: 1,
            idempotencyKey: crypto.createHash("sha256")
              .update(`${repository}:${candidate.number}:${CLAIM_GENERATION}`)
              .digest("hex"),
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          this.store.upsertTask(task);
          this.store.insertTransition({
            id: crypto.randomUUID(), taskId, fromStatus: undefined, toStatus: "READY",
            reason: "discovered by dedicated GitHub intake", actor: "github-intake", createdAt: timestamp,
          });

          const lifecycle = new LifecycleManager({
            getTask: (id) => this.store.getTask(id),
            upsertTask: (value) => this.store.upsertTask(value),
            insertTransition: (transition) => this.store.insertTransition(transition),
            listTasksByStatuses: (statuses) => this.store.listTasksByStatuses(statuses),
          });
          const claimed = lifecycle.claimTask(taskId, claim.claimOwner, this.opts.config.defaultTaskTimeoutMs + 15 * 60_000);
          if (!claimed.ok) {
            this.store.updateGitHubIntakeClaim(claim.id, {
              taskId, status: "RECONCILIATION_REQUIRED", lastError: claimed.error ?? "task lease claim failed",
            });
            result.errors.push(`${repository}#${candidate.number}: task was created but lifecycle claim failed`);
            continue;
          }
          result.tasksCreated += 1;
          this.store.updateGitHubIntakeClaim(claim.id, { taskId, status: "TASK_CREATED" });

          // Persist DISPATCHING before crossing the execution boundary. After a crash
          // in this state the service will never blindly relaunch the task.
          this.store.updateGitHubIntakeClaim(claim.id, { status: "DISPATCHING" });
          const currentTask = this.store.getTask(taskId) ?? claimed.data!;
          const dispatched = await this.opts.dispatcher.dispatch(currentTask, claim);
          if (!dispatched.ok || !dispatched.data?.executionId) {
            this.store.updateGitHubIntakeClaim(claim.id, {
              status: "RECONCILIATION_REQUIRED",
              lastError: dispatched.error ?? "dispatcher did not return a durable execution identifier",
            });
            result.errors.push(`${repository}#${candidate.number}: dispatch outcome is uncertain or failed; automatic retry is prohibited`);
            continue;
          }
          this.store.upsertTask({ ...currentTask, executionId: dispatched.data.executionId, updatedAt: new Date().toISOString() });
          const running = await provider.addLabels(candidate.number, [RUNNING_LABEL]);
          if (!running.ok) {
            this.store.updateGitHubIntakeClaim(claim.id, {
              status: "RECONCILIATION_REQUIRED",
              lastError: "execution started but kilo:running label reconciliation failed",
            });
            result.errors.push(`${repository}#${candidate.number}: execution started but running label needs reconciliation`);
            continue;
          }
          this.store.updateGitHubIntakeClaim(claim.id, { status: "RUNNING", lastError: undefined });
          this.audit(project.id, "github_intake.execution_started", {
            repository, issue: candidate.number, claimId: claim.id, taskId, executionId: dispatched.data.executionId,
          });
          result.executionsStarted += 1;
        }
      }
      return okResult(result);
    } catch (error) {
      result.errors.push(String(error));
      return { ok: false, error: "GitHub intake poll failed; inspect the persisted claims for reconciliation", code: "INTAKE_POLL_FAILED", data: result };
    } finally {
      this.lock.release();
    }
  }

  async startContinuous(intervalMs = 30_000): Promise<BridgeResult<void>> {
    if (this.opts.config.githubIntakeEnabled !== true) {
      return failResult("dedicated GitHub intake is disabled", "GITHUB_INTAKE_DISABLED");
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 5_000) {
      return failResult("intake polling interval must be at least 5000ms", "INVALID_POLL_INTERVAL");
    }
    if (this.running) return failResult("GitHub intake is already running", "INTAKE_ALREADY_RUNNING");
    this.running = true;
    this.stopRequested = false;
    const tick = async () => {
      if (this.stopRequested) return;
      const outcome = await this.pollOnce();
      if (!outcome.ok) {
        // The poll result is deliberately not treated as an execution success.
        this.audit(null, "github_intake.poll_blocked", { code: outcome.code ?? "UNKNOWN" });
      }
      if (!this.stopRequested) this.timer = setTimeout(tick, intervalMs);
    };
    this.timer = setTimeout(tick, 0);
    return okResult();
  }

  stop(): void {
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
  }

  private defaultProvider(project: ProjectConfig): GitHubProvider {
    const [owner, repo] = project.repository.split("/");
    return new GitHubProvider({ owner, repo });
  }

  private audit(projectId: string | null, action: string, details: Record<string, unknown>): void {
    this.store.insertAudit({
      projectId: projectId ?? undefined,
      actor: "github-intake",
      action,
      detail: JSON.stringify(details),
    });
  }
}

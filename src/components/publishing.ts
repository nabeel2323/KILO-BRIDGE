"use strict";

import fs from "node:fs";
import type { SqliteStore } from "../db";
import type { Logger } from "./logging";
import type { GitHubProvider } from "./github";
import { LifecycleManager } from "./lifecycle";
import { WorktreeManager } from "./worktree";
import { VerificationEngine } from "./verification";
import type { ProjectConfig, TaskRecord, BridgeResult } from "../types";
import { okResult, failResult } from "../types";

export interface PublishingDeps {
  store: SqliteStore;
  logger: Logger;
  bridgeRoot: string;
}

// Files that must never appear in a published change set.
const PROHIBITED_FILE_PATTERNS = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)secrets\//i,
  /(^|\/)credentials\//i,
  /\.(pem|key|pfx|p12)$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)id_ed25519/i,
  /(^|\/)bridge\.config\.json$/i,
  /(^|\/)kilo-bridge\.sqlite/i,
  /(^|\/)\.git\//i,
];

export function findProhibitedFiles(files: string[]): string[] {
  return files.filter((f) => PROHIBITED_FILE_PATTERNS.some((p) => p.test(f.replace(/\\/g, "/"))));
}

// Controlled publishing (spec §12). Disabled by default; requires an
// authorized kilo:publish-approved label, passing required verification,
// and a clean prohibited-file scan. The Bridge — never Kilo — commits and
// pushes the feature branch and opens a DRAFT pull request. Never merges,
// never pushes to main/develop, never deploys.
export class PublishingManager {
  private readonly store: SqliteStore;
  private readonly logger: Logger;
  private readonly bridgeRoot: string;

  constructor(deps: PublishingDeps) {
    this.store = deps.store;
    this.logger = deps.logger;
    this.bridgeRoot = deps.bridgeRoot;
  }

  async publish(task: TaskRecord, config: ProjectConfig, gh: GitHubProvider): Promise<BridgeResult<{ prUrl: string }>> {
    if (!config.publishingEnabled) {
      return failResult("publishing is disabled for this project", "PUBLISHING_DISABLED");
    }
    if (task.status !== "REPORT_READY") {
      return failResult(`task is not REPORT_READY (status ${task.status})`, "NOT_REPORT_READY");
    }

    // Re-verify the approval label directly from GitHub (never trust local state alone).
    const issue = await gh.getIssue(task.issueNumber);
    if (!issue.ok) return failResult(issue.error!, issue.code);
    if (!issue.data!.labels.includes("kilo:publish-approved")) {
      return failResult("issue lacks kilo:publish-approved label", "NOT_APPROVED");
    }
    if (!issue.data!.labels.includes("kilo:report-ready")) {
      return failResult("issue lacks kilo:report-ready label", "NOT_REPORT_READY");
    }

    if (!task.worktreePath || !task.featureBranch) {
      return failResult("task has no worktree/feature branch recorded", "NO_WORKTREE");
    }
    if (!fs.existsSync(task.worktreePath)) {
      return failResult(`worktree missing: ${task.worktreePath}`, "WORKTREE_MISSING");
    }

    // Confirm the expected verification policy passed for the latest execution.
    const executions = this.store.listExecutions(task.id);
    const latest = executions[executions.length - 1];
    if (!latest) return failResult("no execution recorded for task", "NO_EXECUTION");
    const verifications = this.store.listVerifications(latest.id);
    const commands = VerificationEngine.commandsFromProject(config, task.worktreePath);
    const requiredNames = commands.filter((c) => c.required).map((c) => c.name);
    for (const name of requiredNames) {
      const matches = verifications.filter((v) => `${v.command} ${v.args.join(" ")}`.trim() === name);
      if (matches.length === 0 || !matches.every((v) => v.passed === true)) {
        return failResult(`required verification not passed: ${name}`, "VERIFICATION_NOT_PASSED");
      }
    }

    const worktree = new WorktreeManager({
      projectId: config.id,
      localRepoPath: config.localPath,
      worktreeRoot: config.worktreeRoot,
      baseBranch: config.baseBranch,
      branchPrefix: config.branchPrefix,
      releaseBranch: config.releaseBranch,
    });

    // Prohibited-file scan before anything is committed.
    const changedFiles = await worktree.collectChangedFiles(task.worktreePath);
    const prohibited = findProhibitedFiles(changedFiles);
    if (prohibited.length > 0) {
      return failResult(`prohibited files in change set: ${prohibited.join(", ")}`, "PROHIBITED_FILES");
    }
    if (changedFiles.length === 0) {
      return failResult("no changes to publish", "NO_CHANGES");
    }

    const lifecycle = new LifecycleManager({
      getTask: (id) => this.store.getTask(id),
      upsertTask: (t) => this.store.upsertTask(t),
      insertTransition: (t) => this.store.insertTransition(t),
    });
    const approved = lifecycle.transition(task.id, "PUBLISH_APPROVED", { actor: "publishing", reason: "kilo:publish-approved verified" });
    if (!approved.ok) return failResult(approved.error!, approved.code);

    // Bridge-owned commit + push of the feature branch only.
    const commit = await worktree.commitAll(task.worktreePath, `feat: issue #${task.issueNumber} — ${task.title} (Kilo Bridge attempt ${task.attempt})`);
    if (!commit.ok) return failResult(commit.error!, commit.code);
    const push = await worktree.pushBranch(task.worktreePath, task.featureBranch);
    if (!push.ok) return failResult(push.error!, push.code);

    // Draft PR targeting the configured development branch (never main fallback).
    const pr = await gh.createDraftPr({
      title: `[Kilo] #${task.issueNumber}: ${task.title}`,
      body: [
        `Automated implementation for #${task.issueNumber} by Kilo Bridge.`,
        ``,
        `- Project: ${config.id}`,
        `- Task: ${task.issueUrl}`,
        `- Base: ${config.baseBranch} @ ${task.baseSha ?? "n/a"}`,
        `- Attempt: ${task.attempt}`,
        `- Execution: ${latest.id}`,
        ``,
        `Closes #${task.issueNumber}`,
        ``,
        `> Draft PR created by Kilo Bridge after explicit publish approval. Review required before merge. The Bridge never merges.`,
      ].join("\n"),
      head: task.featureBranch,
      base: config.baseBranch,
    });
    if (!pr.ok) return failResult(pr.error!, pr.code);

    await gh.addComment(task.issueNumber, `[kilo-bridge-report] Published draft pull request: ${pr.data!}\n\nBranch: \`${task.featureBranch}\` → \`${config.baseBranch}\`. Awaiting human review; the Bridge never merges.`);
    await gh.removeLabel(task.issueNumber, "kilo:publish-approved");
    await gh.addLabels(task.issueNumber, ["kilo:published"]);
    lifecycle.transition(task.id, "PUBLISHED", { actor: "publishing", reason: pr.data! });
    this.store.insertAudit({ projectId: config.id, actor: "publishing", action: "task.published", detail: `issue #${task.issueNumber} → ${pr.data!}` });
    this.logger.info("task published", { taskId: task.id, pr: pr.data });
    this.logger.notify("Kilo Bridge", `Issue #${task.issueNumber} published as draft PR`);
    return okResult({ prUrl: pr.data! });
  }
}
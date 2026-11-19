"use strict";

import path from "node:path";
import { ensureBridgeConfig, type BridgeConfig } from "../config";
import type { BridgeResult, GitHubIntakeClaim, TaskRecord } from "../types";
import { failResult } from "../types";
import type { SqliteStore } from "../db";
import type { Logger } from "./logging";
import type { ProjectRegistry } from "./registry";
import type { GitHubIntakeDispatcher } from "./githubIntake";
import { GitHubProvider } from "./github";
import { WindowsSandboxTaskRunner } from "./windowsSandboxTaskRunner";
import { Worker } from "./worker";

function canonicalRepository(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Dedicated dispatcher for durable GitHub claims.
 * It never polls as a generic Worker and cannot execute through host Kilo.
 */
export class SandboxGitHubIntakeDispatcher implements GitHubIntakeDispatcher {
  constructor(private readonly options: {
    bridgeRoot: string;
    store: SqliteStore;
    registry: ProjectRegistry;
    logger: Logger;
    isRuntimeAttested: () => boolean;
  }) {}

  isReady(): boolean {
    try {
      const config = ensureBridgeConfig(this.options.bridgeRoot);
      if (config.githubIntakeEnabled !== true) return false;
      return this.isPrerequisitesReady(config);
    } catch {
      return false;
    }
  }

  /**
   * Checks the isolated runtime and integration prerequisites without requiring
   * the dedicated intake gate itself to be enabled. The Control Center uses
   * this to display whether the second-stage intake activation is available.
   */
  isPrerequisitesReady(configOverride?: BridgeConfig): boolean {
    try {
      const config = configOverride ?? ensureBridgeConfig(this.options.bridgeRoot);
      if (
        config.sandboxExecutionEnabled !== true ||
        config.ghEnabled !== true ||
        config.kiloEnabled !== true ||
        config.githubIntakeAllowedRepositories.length === 0
      ) return false;
      if (!this.options.isRuntimeAttested()) return false;
      return new WindowsSandboxTaskRunner({
        bridgeRoot: this.options.bridgeRoot,
        config,
      }).readiness().ready;
    } catch {
      return false;
    }
  }

  async dispatch(
    task: TaskRecord,
    claim: GitHubIntakeClaim
  ): Promise<BridgeResult<{ executionId: string; taskStatus: TaskRecord["status"] }>> {
    let config: BridgeConfig;
    try {
      config = ensureBridgeConfig(this.options.bridgeRoot);
    } catch {
      return failResult("Bridge configuration could not be loaded", "BRIDGE_CONFIG_INVALID");
    }
    if (!this.isReady()) {
      return failResult("Windows Sandbox execution or intake configuration is not ready", "SANDBOX_NOT_READY");
    }

    const repository = canonicalRepository(claim.repositoryFullName);
    if (!config.githubIntakeAllowedRepositories.some((entry) => canonicalRepository(entry) === repository)) {
      return failResult("claim repository is not on the current trusted repository allowlist", "REPOSITORY_NOT_ALLOWLISTED");
    }

    const persistedClaim = this.options.store.getGitHubIntakeClaim(
      claim.repositoryFullName,
      claim.issueNumber,
      claim.assignmentGeneration
    );
    if (
      !persistedClaim ||
      persistedClaim.id !== claim.id ||
      persistedClaim.status !== "DISPATCHING" ||
      persistedClaim.taskId !== task.id ||
      persistedClaim.claimOwner !== claim.claimOwner ||
      persistedClaim.claimToken !== claim.claimToken
    ) {
      return failResult("durable GitHub intake claim does not match the dispatch request", "INTAKE_CLAIM_MISMATCH");
    }

    const issueMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i.exec(task.issueUrl);
    if (
      !issueMatch ||
      canonicalRepository(issueMatch[1] + "/" + issueMatch[2]) !== repository ||
      Number(issueMatch[3]) !== claim.issueNumber ||
      task.issueNumber !== claim.issueNumber
    ) {
      return failResult("task Issue URL does not match the durable claim repository and number", "INTAKE_REPOSITORY_MISMATCH");
    }

    const matchingProjects = this.options.registry.list().filter(({ config: projectConfig, state }) =>
      state === "active" &&
      projectConfig.state === "active" &&
      canonicalRepository(projectConfig.repository) === repository
    );
    if (
      matchingProjects.length !== 1 ||
      matchingProjects[0].config.id !== claim.projectId ||
      task.projectId !== claim.projectId
    ) {
      return failResult("claim does not map to exactly one active registered project", "PROJECT_MAPPING_MISMATCH");
    }

    const durableTask = this.options.store.getTask(task.id);
    if (
      !durableTask ||
      durableTask.status !== "CLAIMED" ||
      durableTask.leaseHolder !== claim.claimOwner ||
      durableTask.executionId
    ) {
      return failResult("task is not held by the durable intake claim or was already executed", "TASK_LEASE_MISMATCH");
    }
    if (
      !durableTask.leaseExpiresAt ||
      new Date(durableTask.leaseExpiresAt).getTime() <= Date.now() ||
      (persistedClaim.leaseExpiresAt && new Date(persistedClaim.leaseExpiresAt).getTime() <= Date.now())
    ) {
      return failResult("durable task or intake claim lease has expired", "TASK_LEASE_EXPIRED");
    }

    const worker = new Worker({
      store: this.options.store,
      registry: this.options.registry,
      logger: this.options.logger,
      bridgeRoot: this.options.bridgeRoot,
      config: {
        dataDir: path.join(this.options.bridgeRoot, "data"),
        dbPath: config.dbPath,
        logsDir: path.join(this.options.bridgeRoot, "logs"),
        reportsDir: path.join(this.options.bridgeRoot, "reports"),
        worktreeRoot: config.worktreeRoot,
        pollIntervalMs: config.pollIntervalMs,
        defaultTaskTimeoutMs: config.defaultTaskTimeoutMs,
        ghEnabled: config.ghEnabled,
        kiloEnabled: config.kiloEnabled,
        // Deliberately false: only the claim-bound Sandbox entrypoint is available.
        workerEnabled: false,
      },
      mode: "real",
      githubFactory: (registeredProject) => {
        const [owner, repo] = registeredProject.repository.split("/");
        return new GitHubProvider({ owner, repo, ghBin: config.ghBin });
      },
      kiloBin: process.env.KILO_BIN ?? "kilo",
      workerId: claim.claimOwner,
      sandboxExecutionEnabled: config.sandboxExecutionEnabled,
      sandboxRunner: new WindowsSandboxTaskRunner({
        bridgeRoot: this.options.bridgeRoot,
        config,
      }),
    });

    return worker.dispatchClaimedSandboxTask(task.id);
  }
}

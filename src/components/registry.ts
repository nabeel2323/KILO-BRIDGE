"use strict";

import fs from "node:fs";
import path from "node:path";
import {
  BridgeResult,
  okResult,
  failResult,
  ProjectConfig,
  ProjectRegistrationInput,
  ProjectConfigSchema,
  ProjectRegistrationInputSchema,
  SecurityPolicy,
} from "../types";

export interface RegistryDeps {
  upsertProject: (config: ProjectConfig, state: string) => void;
  getProject: (id: string) => { config: ProjectConfig; state: string } | null;
  listProjects: () => Array<{ config: ProjectConfig; state: string }>;
  setProjectState: (id: string, state: string) => void;
  getSecurityPolicy: (projectId: string) => SecurityPolicy | null;
  upsertSecurityPolicy: (policy: SecurityPolicy) => void;
}

export class ProjectRegistry {
  private readonly deps: RegistryDeps;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
  }

  add(input: ProjectRegistrationInput): BridgeResult<ProjectConfig> {
    const parsed = ProjectRegistrationInputSchema.safeParse(input);
    if (!parsed.success) {
      return failResult(`invalid project registration: ${parsed.error.message}`, "INVALID_PROJECT");
    }
    const now = new Date().toISOString();
    const config: ProjectConfig = {
      ...parsed.data,
      createdAt: now,
      updatedAt: now,
      state: "active",
    };
    const validated = ProjectConfigSchema.safeParse(config);
    if (!validated.success) {
      return failResult(`invalid project config: ${validated.error.message}`, "INVALID_PROJECT");
    }
    if (this.deps.getProject(config.id)) {
      return failResult(`project ${config.id} already registered`, "PROJECT_EXISTS");
    }
    this.deps.upsertProject(validated.data, "active");
    return okResult(validated.data);
  }

  list(): Array<{ config: ProjectConfig; state: string }> {
    return this.deps.listProjects();
  }

  get(id: string): { config: ProjectConfig; state: string } | null {
    return this.deps.getProject(id);
  }

  validate(input: ProjectRegistrationInput): BridgeResult<ProjectConfig> {
    const parsed = ProjectRegistrationInputSchema.safeParse(input);
    if (!parsed.success) {
      return failResult(`invalid project config: ${parsed.error.message}`, "INVALID_PROJECT");
    }
    const config: ProjectConfig = { ...parsed.data, state: "active" };
    const validated = ProjectConfigSchema.safeParse(config);
    if (!validated.success) {
      return failResult(`invalid project config: ${validated.error.message}`, "INVALID_PROJECT");
    }
    return okResult(validated.data);
  }

  enable(id: string): BridgeResult<void> {
    const existing = this.deps.getProject(id);
    if (!existing) return failResult(`project ${id} not found`, "PROJECT_NOT_FOUND");
    this.deps.setProjectState(id, "active");
    return okResult();
  }

  disable(id: string): BridgeResult<void> {
    const existing = this.deps.getProject(id);
    if (!existing) return failResult(`project ${id} not found`, "PROJECT_NOT_FOUND");
    this.deps.setProjectState(id, "disabled");
    return okResult();
  }

  inspect(id: string): BridgeResult<{ config: ProjectConfig; state: string; policy: SecurityPolicy | null }> {
    const existing = this.deps.getProject(id);
    if (!existing) return failResult(`project ${id} not found`, "PROJECT_NOT_FOUND");
    const policy = this.deps.getSecurityPolicy(id);
    return okResult({ config: existing.config, state: existing.state, policy });
  }

  // Configuration templates for supported project types.
  static template(projectType: string): Partial<ProjectRegistrationInput> {
    const base: Partial<ProjectRegistrationInput> = {
      allowedAuthors: [],
      verificationCommands: [],
      publishingEnabled: false,
    };
    switch (projectType) {
      case "node":
        return {
          ...base,
          projectType: "node",
          runtime: { nodeVersion: "22", packageManager: "pnpm", packageManagerVersion: "9.15.9" },
          verificationCommands: ["pnpm lint", "pnpm typecheck", "pnpm test:unit", "pnpm build"],
          branchPrefix: "ai/kilo",
        };
      case "laravel":
        return {
          ...base,
          projectType: "laravel",
          runtime: { packageManager: "composer" },
          verificationCommands: ["composer install", "php artisan test"],
          branchPrefix: "ai/kilo",
        };
      case "django":
        return {
          ...base,
          projectType: "django",
          runtime: { packageManager: "pip" },
          verificationCommands: ["python manage.py test"],
          branchPrefix: "ai/kilo",
        };
      case "odoo":
        return {
          ...base,
          projectType: "odoo",
          runtime: { packageManager: "pip" },
          verificationCommands: [],
          branchPrefix: "ai/kilo",
        };
      case "flutter":
        return {
          ...base,
          projectType: "flutter",
          runtime: {},
          verificationCommands: ["flutter analyze", "flutter test"],
          branchPrefix: "ai/kilo",
        };
      case "other":
      default:
        return {
          ...base,
          projectType: "other",
          runtime: {},
          verificationCommands: [],
          branchPrefix: "ai/kilo",
        };
    }
  }

  static scsPlatform(): ProjectRegistrationInput {
    return {
      id: "scs-platform",
      name: "Smart Commerce & Supply Platform",
      repository: "nabeel2323/scs-platform",
      localPath: "C:\\TAIF\\scs-platform",
      baseBranch: "develop",
      releaseBranch: "main",
      worktreeRoot: "C:\\TAIF\\_kilo-worktrees\\scs-platform",
      branchPrefix: "ai/kilo",
      allowedAuthors: ["nabeel2323"],
      runtime: {
        nodeVersion: "22",
        packageManager: "pnpm",
        packageManagerVersion: "9.15.9",
      },
      projectType: "node",
      verificationCommands: ["pnpm lint", "pnpm typecheck", "pnpm test:unit", "pnpm build"],
      conditionalVerification: ["pnpm --filter @scs/api test:coverage"],
      kiloModel: undefined,
      kiloAgent: undefined,
      taskTimeoutMs: 6 * 60 * 60 * 1000,
      pollIntervalMs: 30_000,
      publishingEnabled: false,
    };
  }

  // Runtime configuration summary for a project.
  runtimeConfig(config: ProjectConfig): Record<string, unknown> {
    return {
      id: config.id,
      repository: config.repository,
      localPath: config.localPath,
      baseBranch: config.baseBranch,
      releaseBranch: config.releaseBranch,
      worktreeRoot: config.worktreeRoot,
      branchPrefix: config.branchPrefix,
      allowedAuthors: config.allowedAuthors,
      runtime: config.runtime,
      projectType: config.projectType,
      verificationCommands: config.verificationCommands,
      conditionalVerification: config.conditionalVerification,
      kiloModel: config.kiloModel,
      kiloAgent: config.kiloAgent,
      taskTimeoutMs: config.taskTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      publishingEnabled: config.publishingEnabled,
      state: config.state,
    };
  }
}

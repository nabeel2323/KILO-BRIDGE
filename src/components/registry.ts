"use strict";

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
      state: parsed.data.state ?? "active",
      releaseBranch: parsed.data.releaseBranch ?? "main",
    };
    const validated = ProjectConfigSchema.safeParse(config);
    if (!validated.success) {
      return failResult(`invalid project registration: ${validated.error.message}`, "INVALID_PROJECT");
    }
    if (this.deps.getProject(config.id)) {
      return failResult(`project ${config.id} already registered`, "PROJECT_EXISTS");
    }
    this.deps.upsertProject(validated.data, validated.data.state);
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
    const now = new Date().toISOString();
    const config: ProjectConfig = {
      ...parsed.data,
      createdAt: now,
      updatedAt: now,
      state: parsed.data.state ?? "active",
      releaseBranch: parsed.data.releaseBranch ?? "main",
    };

    // Absolute path requirements (Windows).
    const mustBeAbsolute: (keyof ProjectConfig)[] = ["localPath", "worktreeRoot"];
    for (const field of mustBeAbsolute) {
      const value = (config as unknown as Record<string, unknown>)[field];
      if (typeof value === "string" && !isAbsolutePath(value)) {
        return failResult(`${field} must be an absolute path`, "INVALID_PATH");
      }
    }

    // Worktree must not be inside the repo and repo must not be inside the worktree.
    if (typeof config.localPath === "string" && typeof config.worktreeRoot === "string") {
      const local = path.resolve(config.localPath);
      const wt = path.resolve(config.worktreeRoot);
      if (isWithin(local, wt) || isWithin(wt, local)) {
        return failResult("worktree must be isolated from the repository working tree", "WORKTREE_NOT_ISOLATED");
      }
    }

    if (!config.allowedAuthors || config.allowedAuthors.length === 0) {
      return failResult("allowedAuthors must not be empty", "INVALID_PROJECT");
    }
    if (!config.baseBranch) {
      return failResult("baseBranch is required", "INVALID_PROJECT");
    }
    if (!config.name) {
      return failResult("name is required", "INVALID_PROJECT");
    }

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

  static template(projectType: string): Partial<ProjectRegistrationInput> {
    const base: Partial<ProjectRegistrationInput> = {
      allowedAuthors: [],
      verificationCommands: [],
      advisoryCommands: [],
      conditionalVerification: [],
      releaseBranch: "main",
      publishingEnabled: false,
    };
    switch (projectType) {
      case "node":
        return {
          ...base,
          projectType: "node",
          runtime: { nodeVersion: "22", packageManager: "pnpm", packageManagerVersion: "9.15.9" },
          verificationCommands: ["pnpm lint", "pnpm typecheck", "pnpm test:unit", "pnpm build"],
          advisoryCommands: ["pnpm format:check"],
          branchPrefix: "ai/kilo",
        };
      case "laravel":
        return {
          ...base,
          projectType: "laravel",
          runtime: { packageManager: "composer" },
          verificationCommands: ["php artisan test"],
          advisoryCommands: [],
          branchPrefix: "ai/kilo",
        };
      case "django":
        return {
          ...base,
          projectType: "django",
          runtime: { packageManager: "pip" },
          verificationCommands: ["python manage.py test"],
          advisoryCommands: [],
          branchPrefix: "ai/kilo",
        };
      case "odoo":
        return {
          ...base,
          projectType: "odoo",
          runtime: { packageManager: "pip" },
          verificationCommands: [],
          advisoryCommands: [],
          branchPrefix: "ai/kilo",
        };
      case "flutter":
        return {
          ...base,
          projectType: "flutter",
          runtime: {},
          verificationCommands: ["flutter analyze", "flutter test"],
          advisoryCommands: [],
          branchPrefix: "ai/kilo",
        };
      case "other":
      default:
        return {
          ...base,
          projectType: "other",
          runtime: {},
          verificationCommands: [],
          advisoryCommands: [],
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
      advisoryCommands: ["pnpm format:check"],
      conditionalVerification: ["pnpm --filter @scs/api test:coverage"],
      state: "active",
      taskTimeoutMs: 6 * 60 * 60 * 1000,
      pollIntervalMs: 30_000,
      publishingEnabled: false,
    };
  }

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
      advisoryCommands: config.advisoryCommands,
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

function isAbsolutePath(value: string): boolean {
  // Windows absolute: drive letter or UNC.
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isWithin(child: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

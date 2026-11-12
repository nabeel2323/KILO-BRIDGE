"use strict";

import path from "node:path";
import fs from "node:fs";
import type { SecurityPolicy, BridgeResult, ProjectConfig } from "../types";
import { okResult, failResult } from "../types";

const SENSITIVE_PATH_PATTERNS = [
  ".env",
  ".env.",
  "secrets",
  "credentials",
  "*.pem",
  "*.key",
  "*.crt",
  "id_rsa",
  "id_ed25519",
  ".github/dependabot",
  "node_modules",
  ".git",
];

const BRIDGE_PROTECTED = ["kilo-bridge", ".kilo", "bridge.config.json"];

export interface CommandPolicyRule {
  action: "allow" | "deny";
  command: string; // prefix or glob
  reason: string;
}

export interface BridgeCommandPolicy {
  version: "1.0";
  description: string;
  defaultAction: "deny";
  rules: CommandPolicyRule[];
}

export class SecurityManager {
  private readonly projectId: string;
  private readonly worktreeRoot: string;
  private readonly bridgeRoot: string;

  constructor(projectId: string, worktreeRoot: string, bridgeRoot: string) {
    this.projectId = projectId;
    this.worktreeRoot = worktreeRoot;
    this.bridgeRoot = bridgeRoot;
  }

  generatePolicy(project: ProjectConfig): SecurityPolicy {
    return {
      projectId: project.id,
      denyShellUnapproved: true,
      allowWorktreeOnly: true,
      denySensitivePaths: true,
      denyExternalPaths: true,
      protectBridgeConfig: true,
      denyGitPush: true,
      denyGitCommit: true,
      denyGitMerge: true,
      denyDeploy: true,
      denyDbMigrate: true,
      denyDbReset: true,
      denyDbProdAccess: true,
      createdAt: new Date().toISOString(),
    };
  }

  // Write a Kilo permission config file inside the worktree.
  // The exact schema must match the detected Kilo version; this is the
  // Bridge's best-effort representation and is validated by the Kilo adapter.
  writeKiloPermissionFile(worktreePath: string, policy: SecurityPolicy): BridgeResult<string> {
    const config = {
      version: "1.0",
      projectId: this.projectId,
      scope: worktreePath,
      default: "deny",
      allow: [
        { path: "**", operation: ["read", "edit", "create"], comment: "source-code reading and editing within worktree" },
      ],
      deny: [
        { path: ".env*", operation: ["*"], comment: "environment/secret files" },
        { path: "secrets/**", operation: ["*"], comment: "secret directories" },
        { path: "credentials/**", operation: ["*"], comment: "credential directories" },
        { path: "*.{pem,key,crt}", operation: ["*"], comment: "certificate and key files" },
        { path: ".git/**", operation: ["push", "commit", "merge"], comment: "git push/commit/merge prohibited from Kilo" },
        { path: "node_modules/**", operation: ["write"], comment: "no package installs from Kilo" },
        { path: "infra/**", operation: ["*"], comment: "deployment infrastructure prohibited" },
        { path: "db/**", operation: ["migrate", "reset", "seed"], comment: "database mutations prohibited" },
        { path: `${this.bridgeRoot}/**`, operation: ["*"], comment: "Bridge configuration and credentials protected" },
        { path: "outside_worktree/**", operation: ["*"], comment: "external directory access denied" },
      ],
      shell: {
        allowUnapproved: false,
        denyList: [
          "pnpm db:migrate",
          "pnpm db:seed",
          "pnpm db:reset",
          "pnpm infra:up",
          "pnpm infra:down",
          "git push",
          "git commit",
          "git merge",
          "docker compose up",
          "kubectl",
        ],
      },
      createdAt: policy.createdAt,
    };

    const file = path.join(worktreePath, "kilo.permissions.json");
    try {
      if (!fs.existsSync(worktreePath)) fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
      return okResult(file);
    } catch (err) {
      return failResult(`failed to write kilo permission file: ${err}`, "PERMISSION_WRITE_FAILED");
    }
  }

  // Bridge-level command policy: independent of Kilo's own permissions.
  writeBridgeCommandPolicy(worktreePath: string): BridgeResult<string> {
    const policy: BridgeCommandPolicy = {
      version: "1.0",
      description: "Bridge-level command policy enforced before Kilo execution.",
      defaultAction: "deny",
      rules: [
        { action: "deny", command: "pnpm db:migrate", reason: "database migrations require explicit authorization" },
        { action: "deny", command: "pnpm db:seed", reason: "database seeds require explicit authorization" },
        { action: "deny", command: "pnpm db:reset", reason: "database resets require explicit authorization" },
        { action: "deny", command: "pnpm infra:up", reason: "deployment requires explicit authorization" },
        { action: "deny", command: "pnpm infra:down", reason: "deployment requires explicit authorization" },
        { action: "deny", command: "git push", reason: "Kilo must not push; Bridge controls publishing" },
        { action: "deny", command: "git commit", reason: "Kilo must not commit; Bridge controls publishing" },
        { action: "deny", command: "git merge", reason: "Kilo must not merge" },
        { action: "deny", command: "gh auth login", reason: "authentication is Bridge-owned" },
        { action: "deny", command: "rm -rf", reason: "destructive file removal denied" },
        { action: "allow", command: "pnpm lint", reason: "verification" },
        { action: "allow", command: "pnpm typecheck", reason: "verification" },
        { action: "allow", command: "pnpm test:unit", reason: "verification" },
        { action: "allow", command: "pnpm build", reason: "verification" },
        { action: "allow", command: "pnpm format:check", reason: "advisory verification" },
      ],
    };

    const file = path.join(worktreePath, "bridge.command-policy.json");
    try {
      if (!fs.existsSync(worktreePath)) fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(policy, null, 2), "utf8");
      return okResult(file);
    } catch (err) {
      return failResult(`failed to write bridge command policy: ${err}`, "POLICY_WRITE_FAILED");
    }
  }

  validatePolicy(policy: SecurityPolicy): BridgeResult<void> {
    const required: (keyof SecurityPolicy)[] = [
      "denyShellUnapproved", "allowWorktreeOnly", "denySensitivePaths",
      "denyExternalPaths", "protectBridgeConfig", "denyGitPush", "denyGitCommit",
      "denyGitMerge", "denyDeploy", "denyDbMigrate", "denyDbReset", "denyDbProdAccess",
    ];
    for (const key of required) {
      if (policy[key] !== true) {
        return failResult(`security policy missing required denial: ${key}`, "POLICY_INCOMPLETE");
      }
    }
    return okResult();
  }

  // Path-traversal guard: ensure a path resolves within the worktree.
  isPathWithinWorktree(worktreePath: string, target: string): boolean {
    const resolved = path.resolve(worktreePath, target);
    const root = path.resolve(worktreePath);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  // Secret redaction for logs/outputs.
  redactSecrets(text: string): string {
    let out = text;
    // Reduce common secret-like patterns without storing secrets.
    out = out.replace(/[A-Za-z0-9+/]{40,}=*/g, "[REDACTED]");
    out = out.replace(/ghp_[A-Za-z0-9]{36}/g, "[REDACTED_TOKEN]");
    out = out.replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]");
    out = out.replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]");
    return out;
  }

  // Check a command against deny-list patterns.
  isCommandDenied(command: string): boolean {
    const lower = command.toLowerCase();
    const denied = [
      "db:migrate", "db:seed", "db:reset", "infra:up", "infra:down",
      "git push", "git commit", "git merge", "gh auth login", "rm -rf",
      "docker compose up", "kubectl",
    ];
    return denied.some((d) => lower.includes(d));
  }
}

export { SENSITIVE_PATH_PATTERNS, BRIDGE_PROTECTED };

"use strict";

import path from "node:path";
import fs from "node:fs";
import type { SecurityPolicy, BridgeResult, ProjectConfig } from "../types";
import { okResult, failResult } from "../types";
import { runProcess } from "./process";

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

  // Write the project-level Kilo permission configuration into the worktree.
  // Schema verified against the installed Kilo CLI (https://app.kilo.ai/config.json):
  // `permission` accepts per-tool rules; each rule is "ask"|"allow"|"deny" or a
  // pattern->action map (last matching pattern wins). `--auto` auto-approves
  // anything not explicitly denied, so every dangerous operation MUST be an
  // explicit "deny" — never "ask".
  writeKiloPermissionFile(worktreePath: string, policy: SecurityPolicy): BridgeResult<string> {
    const config = buildKiloPermissionConfig(this.bridgeRoot);
    const file = path.join(worktreePath, "kilo.json");
    try {
      if (!fs.existsSync(worktreePath)) fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
      return okResult(file);
    } catch (err) {
      return failResult(`failed to write kilo permission file: ${err}`, "PERMISSION_WRITE_FAILED");
    }
  }

  // Verify the effective permission configuration before autonomous execution.
  // 1. Bridge-side assertion: the worktree kilo.json must contain every
  //    required explicit denial (tamper/merge check).
  // 2. Kilo-side validation: `kilo config check` in the worktree must pass.
  // If either fails, autonomous execution must be refused (spec §7).
  async verifyEffectivePermissions(
    worktreePath: string,
    opts: { kiloBin?: string; skipKiloCheck?: boolean } = {}
  ): Promise<BridgeResult<{ file: string; kiloCheck: string }>> {
    const file = path.join(worktreePath, "kilo.json");
    if (!fs.existsSync(file)) {
      return failResult(`missing worktree permission config: ${file}`, "PERMISSION_CONFIG_MISSING");
    }
    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      return failResult(`worktree kilo.json is not valid JSON: ${err}`, "PERMISSION_CONFIG_INVALID");
    }
    const missing = findMissingDenials(parsed);
    if (missing.length > 0) {
      return failResult(`worktree permission config missing required denials: ${missing.join(", ")}`, "PERMISSION_DENIALS_MISSING");
    }
    if (opts.skipKiloCheck) {
      return okResult({ file, kiloCheck: "skipped (mock mode)" });
    }
    const res = await runProcess(opts.kiloBin ?? process.env.KILO_BIN ?? "kilo", ["config", "check"], {
      cwd: worktreePath,
      timeoutMs: 60_000,
    });
    const output = (res.stdout + "\n" + res.stderr).trim();
    if (res.code !== 0 || /error|invalid|unknown key/i.test(output)) {
      return failResult(`kilo config check failed: ${output.slice(0, 500)}`, "PERMISSION_CHECK_FAILED");
    }
    return okResult({ file, kiloCheck: output.slice(0, 500) });
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
  // Case-insensitive on Windows; absolute targets outside the root rejected.
  isPathWithinWorktree(worktreePath: string, target: string): boolean {
    const resolved = path.resolve(worktreePath, target);
    const root = path.resolve(worktreePath);
    const a = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const b = process.platform === "win32" ? root.toLowerCase() : root;
    return a === b || a.startsWith(b + path.sep);
  }

  // Secret redaction for logs/outputs. Preserves git SHAs (40/64 hex chars).
  redactSecrets(text: string): string {
    let out = text;
    out = out.replace(/ghp_[A-Za-z0-9]{36}/g, "[REDACTED_TOKEN]");
    out = out.replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]");
    out = out.replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]");
    out = out.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, (m) =>
      /^[a-f0-9]{40}$/i.test(m) || /^[a-f0-9]{64}$/i.test(m) ? m : "[REDACTED]"
    );
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

// ---------------------------------------------------------------------------
// Kilo worktree permission configuration (schema-verified for Kilo 7.8.x).
// Ordering matters: default deny first, then allows, then explicit denies
// (last matching pattern wins in Kilo's permission evaluation).
// ---------------------------------------------------------------------------

export const REQUIRED_FILE_DENIALS = [
  ".env*",
  "**/.env*",
  "**/secrets/**",
  "**/credentials/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  ".git/**",
  "**/node_modules/**",
];

export const REQUIRED_BASH_DENIALS = [
  "git push*",
  "git commit*",
  "git merge*",
  "git reset*",
  "git checkout*",
  "git clean*",
  "*db:migrate*",
  "*db:seed*",
  "*db:reset*",
  "*infra:up*",
  "*infra:down*",
  "*kubectl*",
  "*docker*",
  "gh *",
];

export function buildKiloPermissionConfig(bridgeRoot: string): Record<string, unknown> {
  const fileDenies: Record<string, string> = {};
  for (const p of REQUIRED_FILE_DENIALS) fileDenies[p] = "deny";
  // Protect the Bridge installation (config, database, logs, reports).
  const bridgeGlob = bridgeRoot.replace(/\\/g, "/").replace(/\*/g, "\\*") + "/**";
  fileDenies[bridgeGlob] = "deny";

  const bash: Record<string, string> = { "*": "deny" };
  const allows = [
    "git status*", "git diff*", "git log*", "git show*", "git branch*", "git rev-parse*",
    "ls*", "dir*", "cat *", "type *", "Get-Content*", "Get-ChildItem*",
    "pnpm lint*", "pnpm typecheck*", "pnpm test*", "pnpm build*", "pnpm format*",
    "npm run lint*", "npm run typecheck*", "npm run test*", "npm run build*",
    "node --version", "python --version", "php --version", "flutter --version",
  ];
  for (const p of allows) bash[p] = "allow";
  for (const p of REQUIRED_BASH_DENIALS) bash[p] = "deny";
  const extraDenies = [
    "rm *", "del *", "erase *", "rmdir *", "Remove-Item*", "rd *",
    "curl *", "wget *", "Invoke-WebRequest*", "Invoke-RestMethod*", "iwr *",
    "ssh *", "scp *", "ftp *", "*deploy*", "*production*",
    "powershell*", "pwsh*", "cmd *", "bash *", "sh *", "wscript*", "cscript*",
    "format *", "format:*", "*mkfs*", "*shutdown*", "*restart-computer*",
  ];
  for (const p of extraDenies) bash[p] = "deny";

  return {
    $schema: "https://app.kilo.ai/config.json",
    permission: {
      read: { "**": "allow", ...fileDenies },
      edit: { "**": "allow", ...fileDenies },
      bash,
      external_directory: "deny",
      webfetch: "deny",
      websearch: "deny",
      doom_loop: "deny",
    },
  };
}

// Assert that a parsed worktree kilo.json contains every required denial.
export function findMissingDenials(config: any): string[] {
  const missing: string[] = [];
  const perm = config?.permission;
  if (!perm || typeof perm !== "object") {
    return ["permission object"];
  }
  for (const tool of ["read", "edit"]) {
    const rules = perm[tool];
    if (!rules || typeof rules !== "object") {
      missing.push(`permission.${tool} rules`);
      continue;
    }
    for (const p of REQUIRED_FILE_DENIALS) {
      if (rules[p] !== "deny") missing.push(`permission.${tool}[${p}]`);
    }
  }
  const bash = perm.bash;
  if (!bash || typeof bash !== "object") {
    missing.push("permission.bash rules");
  } else {
    if (bash["*"] !== "deny") missing.push("permission.bash[*] default deny");
    for (const p of REQUIRED_BASH_DENIALS) {
      if (bash[p] !== "deny") missing.push(`permission.bash[${p}]`);
    }
  }
  for (const tool of ["external_directory", "webfetch", "websearch", "doom_loop"]) {
    if (perm[tool] !== "deny") missing.push(`permission.${tool}`);
  }
  return missing;
}

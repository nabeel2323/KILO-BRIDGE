"use strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess, RunProcessResult } from "../../src/components/process";
import type { ProjectConfig } from "../../src/types";

export function makeTempDir(prefix = "kilo-bridge-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup (Windows file locks)
  }
}

export async function git(cwd: string, args: string[]): Promise<RunProcessResult> {
  return runProcess("git", ["-c", "safe.directory=" + cwd.replace(/\\/g, "/"), ...args], { cwd, timeoutMs: 30000 });
}

export async function gitCommit(cwd: string, message: string): Promise<void> {
  const r = await runProcess(
    "git",
    ["-c", "safe.directory=" + cwd.replace(/\\/g, "/"), "-c", "user.name=Bridge Test", "-c", "user.email=bridge-test@example.com", "commit", "-m", message, "--allow-empty"],
    { cwd, timeoutMs: 30000 }
  );
  if (r.code !== 0) throw new Error(`fixture commit failed: ${r.stderr}`);
}

// Create a fixture git repository with an initial commit on `main` and a
// `develop` branch. Optionally create a bare "origin" remote and push both.
export async function makeFixtureRepo(opts: { withOrigin?: boolean; baseBranch?: string } = {}): Promise<{
  repoDir: string;
  originDir: string | null;
  baseSha: string;
  cleanup: () => void;
}> {
  const root = makeTempDir("kilo-fixture-");
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  const baseBranch = opts.baseBranch ?? "develop";
  await git(repoDir, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n", "utf8");
  await git(repoDir, ["add", "-A"]);
  await gitCommit(repoDir, "initial");
  await git(repoDir, ["branch", baseBranch]);
  let originDir: string | null = null;
  if (opts.withOrigin) {
    originDir = path.join(root, "origin.git");
    await git(root, ["init", "--bare", "-b", "main", originDir]);
    await git(repoDir, ["remote", "add", "origin", originDir]);
    await git(repoDir, ["push", "-u", "origin", "main", baseBranch]);
  }
  const sha = await git(repoDir, ["rev-parse", baseBranch]);
  return {
    repoDir,
    originDir,
    baseSha: sha.stdout.trim(),
    cleanup: () => removeDir(root),
  };
}

export function makeProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  const base: ProjectConfig = {
    id: "test-project",
    name: "Test Project",
    repository: "test-owner/test-repo",
    localPath: "C:\\temp\\test-project",
    baseBranch: "develop",
    releaseBranch: "main",
    worktreeRoot: "C:\\temp\\test-worktrees",
    branchPrefix: "ai/kilo",
    allowedAuthors: ["authorized-user"],
    runtime: { nodeVersion: "22", packageManager: "pnpm" },
    projectType: "node",
    verificationCommands: ["pnpm lint", "pnpm test:unit"],
    conditionalVerification: [],
    advisoryCommands: [],
    publishingEnabled: false,
    state: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { ...base, ...overrides };
}

export function makeTaskRecord(overrides: Partial<import("../../src/types").TaskRecord> = {}): import("../../src/types").TaskRecord {
  const now = new Date().toISOString();
  const base: import("../../src/types").TaskRecord = {
    id: "task-" + Math.random().toString(36).slice(2, 10),
    projectId: "test-project",
    issueNumber: 1,
    issueUrl: "https://github.com/test-owner/test-repo/issues/1",
    title: "Test task",
    author: "authorized-user",
    body: "Implement the thing.",
    status: "READY",
    attempt: 1,
    idempotencyKey: "key-" + Math.random().toString(36).slice(2, 10),
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...overrides };
}
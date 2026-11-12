"use strict";

import fs from "node:fs";
import path from "node:path";
import { SqliteStore } from "../../src/db";
import { Logger } from "../../src/components/logging";
import { ProjectRegistry } from "../../src/components/registry";
import { GitHubProvider } from "../../src/components/github";
import { Worker, type WorkerMode } from "../../src/components/worker";
import type { ProjectConfig } from "../../src/types";
import { makeFixtureRepo, makeTempDir, removeDir, git } from "./fixtures";

const MOCK_GH = path.join(__dirname, "..", "..", "..", "tests", "helpers", "mock-gh.cjs");
const MOCK_KILO = path.join(__dirname, "..", "..", "..", "tests", "helpers", "mock-kilo.cjs");

export interface WorkerEnv {
  root: string;
  repoDir: string;
  originDir: string;
  baseSha: string;
  store: SqliteStore;
  registry: ProjectRegistry;
  logger: Logger;
  config: ProjectConfig;
  worker: Worker;
  setGhFixtures: (fixtures: any) => void;
  setKiloFixtures: (fixtures: any) => void;
  ghCalls: () => any[];
  kiloCalls: () => any[];
  cleanup: () => void;
}

export async function makeWorkerEnv(opts: {
  mode?: WorkerMode;
  publishingEnabled?: boolean;
  verificationCommands?: string[];
  taskTimeoutMs?: number;
  ghFixtures?: any;
  kiloFixtures?: any;
} = {}): Promise<WorkerEnv> {
  const root = makeTempDir("kilo-worker-");
  const fixture = await makeFixtureRepo({ withOrigin: true });
  const repoDir = fixture.repoDir;
  // Present the fixture origin as the registered GitHub repository while
  // transparently routing fetch/push to the local bare repo (git insteadOf
  // via environment config — no stored git config is modified).
  await git(repoDir, ["remote", "set-url", "origin", "https://github.com/test-owner/test-repo.git"]);
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${fixture.originDir!.replace(/\\/g, "/")}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/test-owner/test-repo.git";
  const store = new SqliteStore(path.join(root, "data", "test.sqlite"));
  await store.open();
  const logger = new Logger({ logsDir: path.join(root, "logs"), enableConsole: false, enableNotifications: false });
  const registry = new ProjectRegistry({
    upsertProject: (c, s) => store.upsertProject(c, s),
    getProject: (id) => store.getProject(id),
    listProjects: () => store.listProjects(),
    setProjectState: (id, s) => store.setProjectState(id, s),
    getSecurityPolicy: (pid) => store.getSecurityPolicy(pid),
    upsertSecurityPolicy: (p) => store.upsertSecurityPolicy(p),
  });

  const config: ProjectConfig = {
    id: "test-project",
    name: "Test Project",
    repository: "test-owner/test-repo",
    localPath: repoDir,
    baseBranch: "develop",
    releaseBranch: "main",
    worktreeRoot: path.join(root, "worktrees"),
    branchPrefix: "ai/kilo",
    allowedAuthors: ["authorized-user"],
    runtime: { nodeVersion: "22" },
    projectType: "node",
    verificationCommands: opts.verificationCommands ?? ["node --version"],
    conditionalVerification: [],
    advisoryCommands: [],
    taskTimeoutMs: opts.taskTimeoutMs ?? 20000,
    publishingEnabled: opts.publishingEnabled ?? false,
    state: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  registry.add(config as any);

  const ghFixturesPath = path.join(root, "gh-fixtures.json");
  const ghCallsPath = path.join(root, "gh-calls.jsonl");
  const kiloFixturesPath = path.join(root, "kilo-fixtures.json");
  const kiloCallsPath = path.join(root, "kilo-calls.jsonl");

  const defaultGhFixtures = {
    auth: { authenticated: true, user: "authorized-user" },
    api: {
      "repos/test-owner/test-repo/labels?per_page=100": [],
      "repos/test-owner/test-repo/issues?state=open&per_page=100&labels=kilo:ready": [
        {
          number: 1, title: "Test task", body: "Create hello.txt with content hello-kilo", state: "open",
          url: "https://api.github.com/repos/test-owner/test-repo/issues/1",
          html_url: "https://github.com/test-owner/test-repo/issues/1",
          user: { login: "authorized-user" },
          created_at: "2026-11-12T00:00:00Z", updated_at: "2026-11-12T00:00:00Z",
          labels: [{ name: "kilo:ready" }],
        },
      ],
      "repos/test-owner/test-repo/issues/1": {
        number: 1, title: "Test task", body: "Create hello.txt", state: "open",
        html_url: "https://github.com/test-owner/test-repo/issues/1",
        user: { login: "authorized-user" },
        labels: [{ name: "kilo:ready" }],
      },
      "repos/test-owner/test-repo/issues/1/comments?per_page=100": [],
    },
    prCreate: { url: "https://github.com/test-owner/test-repo/pull/10" },
  };
  const defaultKiloFixtures = {
    run: { createFile: { name: "hello.txt", content: "hello-kilo" }, finalText: "Created hello.txt as requested." },
  };
  fs.writeFileSync(ghFixturesPath, JSON.stringify(opts.ghFixtures ?? defaultGhFixtures), "utf8");
  fs.writeFileSync(kiloFixturesPath, JSON.stringify(opts.kiloFixtures ?? defaultKiloFixtures), "utf8");
  process.env.MOCK_GH_FIXTURES = ghFixturesPath;
  process.env.MOCK_GH_CALLS = ghCallsPath;
  process.env.MOCK_KILO_FIXTURES = kiloFixturesPath;
  process.env.MOCK_KILO_CALLS = kiloCallsPath;

  const kiloShim = path.join(root, "kilo-mock.cmd");
  fs.writeFileSync(kiloShim, `@echo off\r\nnode "${MOCK_KILO}" %*\r\n`, "utf8");

  const worker = new Worker({
    store, registry, logger,
    bridgeRoot: root,
    config: {
      dataDir: path.join(root, "data"), dbPath: path.join(root, "data", "test.sqlite"),
      logsDir: path.join(root, "logs"), reportsDir: path.join(root, "reports"),
      worktreeRoot: path.join(root, "worktrees"),
      pollIntervalMs: 30000, defaultTaskTimeoutMs: 20000,
      ghEnabled: true, kiloEnabled: true, workerEnabled: true,
    },
    mode: opts.mode ?? "mock",
    githubFactory: () => new GitHubProvider({
      owner: "test-owner", repo: "test-repo",
      ghBin: process.execPath, ghPrefixArgs: [MOCK_GH],
    }),
    kiloBin: kiloShim,
    workerId: "test-worker",
  });

  const readCalls = (p: string) => () =>
    fs.existsSync(p) ? fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];

  return {
    root, repoDir, originDir: fixture.originDir!, baseSha: fixture.baseSha,
    store, registry, logger, config, worker,
    setGhFixtures: (f) => fs.writeFileSync(ghFixturesPath, JSON.stringify(f), "utf8"),
    setKiloFixtures: (f) => fs.writeFileSync(kiloFixturesPath, JSON.stringify(f), "utf8"),
    ghCalls: readCalls(ghCallsPath),
    kiloCalls: readCalls(kiloCallsPath),
    cleanup: () => {
      store.close();
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
      fixture.cleanup();
      removeDir(root);
    },
  };
}

export function baseGhFixtures(): any {
  return {
    auth: { authenticated: true, user: "authorized-user" },
    api: {
      "repos/test-owner/test-repo/labels?per_page=100": [],
      "repos/test-owner/test-repo/issues?state=open&per_page=100&labels=kilo:ready": [],
      "repos/test-owner/test-repo/issues/1": {
        number: 1, title: "Test task", body: "Create hello.txt", state: "open",
        html_url: "https://github.com/test-owner/test-repo/issues/1",
        user: { login: "authorized-user" },
        labels: [{ name: "kilo:report-ready" }],
      },
      "repos/test-owner/test-repo/issues/1/comments?per_page=100": [],
    },
    prCreate: { url: "https://github.com/test-owner/test-repo/pull/10" },
  };
}
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeWorkerEnv } from "./helpers/worker-env";
import { makeFixtureRepo, git } from "./helpers/fixtures";

test("multi-project: two independent projects execute their own tasks in isolation", async () => {
  const env = await makeWorkerEnv();

  // Second project: own fixture repo, own worktree root, own GitHub repo.
  const fixtureB = await makeFixtureRepo({ withOrigin: true });
  await git(fixtureB.repoDir, ["remote", "set-url", "origin", "https://github.com/test-owner/second-repo.git"]);
  process.env.GIT_CONFIG_COUNT = "2";
  process.env.GIT_CONFIG_KEY_1 = `url.${fixtureB.originDir!.replace(/\\/g, "/")}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_1 = "https://github.com/test-owner/second-repo.git";

  const configB = {
    ...env.config,
    id: "second-project",
    name: "Second Project",
    repository: "test-owner/second-repo",
    localPath: fixtureB.repoDir,
    worktreeRoot: path.join(env.root, "worktrees-b"),
  };
  env.registry.add(configB as any);

  // One fixtures file serves both repositories.
  const ghFixturesPath = process.env.MOCK_GH_FIXTURES!;
  const fixtures = JSON.parse(fs.readFileSync(ghFixturesPath, "utf8"));
  const issueFor = (repo: string, n: number) => ({
    number: n, title: `Task ${repo}#${n}`, body: "Create hello.txt", state: "open",
    url: `https://api.github.com/repos/test-owner/${repo}/issues/${n}`,
    html_url: `https://github.com/test-owner/${repo}/issues/${n}`,
    user: { login: "authorized-user" },
    created_at: "t", updated_at: "t",
    labels: [{ name: "kilo:ready" }],
  });
  fixtures.api["repos/test-owner/second-repo/labels?per_page=100"] = [];
  fixtures.api["repos/test-owner/second-repo/issues?state=open&per_page=100&labels=kilo:ready"] = [issueFor("second-repo", 1)];
  fixtures.api["repos/test-owner/second-repo/issues/1"] = issueFor("second-repo", 1);
  fixtures.api["repos/test-owner/second-repo/issues/1/comments?per_page=100"] = [];
  env.setGhFixtures(fixtures);

  const res = await env.worker.pollOnce();
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data!.length, 2);
  for (const r of res.data!) {
    assert.equal(r.executed, 1, `${r.project}: ${JSON.stringify(r.errors)}`);
  }

  const tasksA = env.store.listTasksByProject("test-project");
  const tasksB = env.store.listTasksByProject("second-project");
  assert.equal(tasksA.length, 1);
  assert.equal(tasksB.length, 1);
  assert.equal(tasksA[0].status, "REPORT_READY");
  assert.equal(tasksB[0].status, "REPORT_READY");

  // Worktrees are isolated per project root.
  assert.ok(tasksA[0].worktreePath!.startsWith(path.join(env.root, "worktrees")));
  assert.ok(tasksB[0].worktreePath!.startsWith(path.join(env.root, "worktrees-b")));
  assert.notEqual(tasksA[0].worktreePath, tasksB[0].worktreePath);

  // Each project's main tree untouched.
  for (const repo of [env.repoDir, fixtureB.repoDir]) {
    const status = await git(repo, ["status", "--porcelain"]);
    assert.equal(status.stdout.trim(), "");
    assert.equal(fs.existsSync(path.join(repo, "hello.txt")), false);
  }

  // Disabling one project stops only that project.
  env.registry.disable("second-project");
  const res2 = await env.worker.pollOnce();
  assert.equal(res2.data!.length, 1);
  assert.equal(res2.data![0].project, "test-project");

  delete process.env.GIT_CONFIG_KEY_1;
  delete process.env.GIT_CONFIG_VALUE_1;
  fixtureB.cleanup();
  env.cleanup();
});
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorktreeManager, normalizeRepoUrl } from "../src/components/worktree";
import { makeFixtureRepo, makeTempDir, removeDir, git } from "./helpers/fixtures";

async function makeManager(opts: { withOrigin?: boolean } = {}) {
  const fixture = await makeFixtureRepo({ withOrigin: opts.withOrigin ?? true });
  const worktreeRoot = path.join(path.dirname(fixture.repoDir), "worktrees");
  const mgr = new WorktreeManager({
    projectId: "test-project",
    localRepoPath: fixture.repoDir,
    worktreeRoot,
    baseBranch: "develop",
    branchPrefix: "ai/kilo",
    releaseBranch: "main",
  });
  return { mgr, fixture, worktreeRoot };
}

test("worktree: verifyRepo / verifyOriginMatches / base SHA", async () => {
  const { mgr, fixture } = await makeManager();
  assert.equal((await mgr.verifyRepo()).ok, true);
  const origin = await mgr.verifyOriginMatches("test-owner/test-repo");
  assert.equal(origin.ok, false, "fixture origin is a local path, not the registered repo");
  // Match against the actual fixture origin path.
  const actual = await mgr.verifyOrigin();
  assert.equal(actual.ok, true);
  assert.equal((await mgr.verifyOriginMatches(actual.data!)).ok, true);
  const sha = await mgr.getBaseSha();
  assert.equal(sha.ok, true);
  assert.equal(sha.data, fixture.baseSha);
  fixture.cleanup();
});

test("worktree: normalizeRepoUrl handles https/ssh/.git", () => {
  assert.equal(normalizeRepoUrl("https://github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(normalizeRepoUrl("git@github.com:Owner/Repo.git"), "owner/repo");
  assert.equal(normalizeRepoUrl("ssh://git@github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(normalizeRepoUrl("https://github.com/owner/repo"), "owner/repo");
});

test("worktree: prepareTaskWorktree creates isolated worktree at base SHA", async () => {
  const { mgr, fixture } = await makeManager();
  const r = await mgr.prepareTaskWorktree(123, 1);
  assert.equal(r.ok, true, r.error);
  const { branch, dir, baseSha } = r.data!;
  assert.equal(branch, "ai/kilo/issue-123");
  assert.equal(baseSha, fixture.baseSha);
  assert.ok(fs.existsSync(dir));
  assert.ok(dir.startsWith(path.dirname(fixture.repoDir)), "worktree outside main repo");
  const head = await mgr.headSha(dir);
  assert.equal(head.data, fixture.baseSha);
  assert.equal((await mgr.isWorktreeClean(dir)).data, true);
  // Main tree untouched: still on main, same HEAD, no new changes.
  const mainBranch = await git(fixture.repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(mainBranch.stdout.trim(), "main");
  fixture.cleanup();
});

test("worktree: dirty main working tree is preserved, never reset", async () => {
  const { mgr, fixture } = await makeManager();
  fs.writeFileSync(path.join(fixture.repoDir, "user-work.txt"), "precious uncommitted work", "utf8");
  const dirty = await mgr.hasUncommittedChanges();
  assert.equal(dirty.ok, true);
  assert.equal(dirty.data, true);
  const r = await mgr.prepareTaskWorktree(7, 1);
  assert.equal(r.ok, true, r.error);
  // User's uncommitted file still present and unmodified.
  assert.equal(fs.readFileSync(path.join(fixture.repoDir, "user-work.txt"), "utf8"), "precious uncommitted work");
  // And NOT present in the isolated worktree.
  assert.equal(fs.existsSync(path.join(r.data!.dir, "user-work.txt")), false);
  fixture.cleanup();
});

test("worktree: branch conflict stops safely, never overwrites", async () => {
  const { mgr, fixture } = await makeManager();
  const first = await mgr.prepareTaskWorktree(55, 1);
  assert.equal(first.ok, true);
  const second = await mgr.prepareTaskWorktree(55, 1);
  assert.equal(second.ok, false);
  assert.equal(second.code, "BRANCH_EXISTS");
  fixture.cleanup();
});

test("worktree: retry attempt gets a unique branch suffix", async () => {
  const { mgr, fixture } = await makeManager();
  const a1 = await mgr.prepareTaskWorktree(9, 1);
  const a2 = await mgr.prepareTaskWorktree(9, 2);
  assert.equal(a1.ok, true);
  assert.equal(a2.ok, true);
  assert.equal(a2.data!.branch, "ai/kilo/issue-9-attempt-2");
  assert.notEqual(a1.data!.dir, a2.data!.dir);
  fixture.cleanup();
});

test("worktree: change inventory includes modified and untracked files", async () => {
  const { mgr, fixture } = await makeManager();
  const r = await mgr.prepareTaskWorktree(21, 1);
  const dir = r.data!.dir;
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\nchanged\n", "utf8");
  fs.writeFileSync(path.join(dir, "new-file.ts"), "export const x = 1;\n", "utf8");
  const files = await mgr.collectChangedFiles(dir);
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("new-file.ts"));
  const diff = await mgr.collectDiff(dir);
  assert.equal(diff.ok, true);
  assert.ok(diff.data!.diff.includes("changed"));
  assert.ok(diff.data!.diff.includes("new-file.ts"));
  assert.ok(diff.data!.stats.includes("untracked"));
  fixture.cleanup();
});

test("worktree: path escape guard", async () => {
  const { mgr, fixture } = await makeManager();
  assert.equal(mgr.isWithinWorktreeRoot(path.join(path.dirname(fixture.repoDir), "worktrees", "x")), true);
  assert.equal(mgr.isWithinWorktreeRoot("C:\\Windows\\system32"), false);
  const r = await mgr.createWorktree("ai/kilo/issue-1", "C:\\Windows\\system32\\evil");
  assert.equal(r.ok, false);
  assert.equal(r.code, "WORKTREE_PATH_ESCAPE");
  fixture.cleanup();
});

test("worktree: push guard rejects protected and off-prefix branches", async () => {
  const { mgr, fixture } = await makeManager();
  for (const b of ["main", "develop", "Main", "DEVELOP"]) {
    const r = await mgr.pushBranch(fixture.repoDir, b);
    assert.equal(r.ok, false, `must refuse ${b}`);
    assert.equal(r.code, "PROTECTED_BRANCH");
  }
  const off = await mgr.pushBranch(fixture.repoDir, "feature/something");
  assert.equal(off.ok, false);
  assert.equal(off.code, "BRANCH_PREFIX_VIOLATION");
  fixture.cleanup();
});

test("worktree: Bridge commitAll + pushBranch to fixture origin", async () => {
  const { mgr, fixture } = await makeManager();
  const r = await mgr.prepareTaskWorktree(31, 1);
  const dir = r.data!.dir;
  fs.writeFileSync(path.join(dir, "feature.txt"), "implemented\n", "utf8");
  const commit = await mgr.commitAll(dir, "feat: implement issue #31");
  assert.equal(commit.ok, true, commit.error);
  assert.match(commit.data!, /^[a-f0-9]{40}$/);
  const push = await mgr.pushBranch(dir, r.data!.branch);
  assert.equal(push.ok, true, push.error);
  // The feature branch exists on the bare origin; develop untouched.
  const remote = await git(fixture.repoDir, ["ls-remote", "--heads", "origin"]);
  assert.ok(remote.stdout.includes("refs/heads/ai/kilo/issue-31"));
  const developSha = await git(fixture.repoDir, ["rev-parse", "origin/develop"]);
  assert.equal(developSha.stdout.trim(), fixture.baseSha, "develop must not move");
  fixture.cleanup();
});

test("worktree: missing base branch fails safely", async () => {
  const fixture = await makeFixtureRepo({ withOrigin: true });
  const mgr = new WorktreeManager({
    projectId: "p",
    localRepoPath: fixture.repoDir,
    worktreeRoot: path.join(path.dirname(fixture.repoDir), "wt"),
    baseBranch: "does-not-exist",
    branchPrefix: "ai/kilo",
  });
  const r = await mgr.prepareTaskWorktree(1, 1);
  assert.equal(r.ok, false);
  fixture.cleanup();
});
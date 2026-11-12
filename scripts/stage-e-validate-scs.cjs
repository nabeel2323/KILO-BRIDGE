"use strict";
// Stage E — SCS Platform registration validation (spec §4).
// Read-only against the user's main working tree: verifies the repository,
// origin, fetches remote refs, records origin/develop SHA, and reports
// uncommitted changes. Never resets/cleans/checkouts/pulls the main tree.
//
// Usage: node scripts/stage-e-validate-scs.cjs
const path = require("path");
const { WorktreeManager } = require("../dist/components/worktree");
const { GitHubProvider } = require("../dist/components/github");

(async () => {
  const config = require("../examples/projects/scs-platform.json");
  const wt = new WorktreeManager({
    projectId: config.id,
    localRepoPath: config.localPath,
    worktreeRoot: config.worktreeRoot,
    baseBranch: config.baseBranch,
    branchPrefix: config.branchPrefix,
    releaseBranch: config.releaseBranch,
  });
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? "[OK]  " : "[FAIL]"} ${name}: ${detail}`); };

  const repo = await wt.verifyRepo();
  add("local-repository", repo.ok, repo.ok ? config.localPath : repo.error);

  const origin = await wt.verifyOriginMatches(config.repository);
  add("origin-matches-registered", origin.ok, origin.ok ? origin.data : origin.error);

  const gh = new GitHubProvider({ owner: "nabeel2323", repo: "scs-platform" });
  const auth = await gh.authStatus();
  add("github-auth", auth.authenticated, auth.authenticated ? `logged in as ${auth.user}` : "not authenticated — run: gh auth login");

  const fetch = await wt.fetchBaseBranch();
  add("fetch-origin-develop", fetch.ok, fetch.ok ? "fetched" : fetch.error);

  const sha = await wt.getBaseSha();
  add("origin-develop-sha", sha.ok, sha.ok ? sha.data : sha.error);

  const branch = await wt.getCurrentBranch();
  add("main-tree-current-branch", branch.ok, branch.ok ? branch.data : branch.error);

  const dirty = await wt.hasUncommittedChanges();
  add("main-tree-uncommitted-changes", dirty.ok, dirty.ok ? (dirty.data ? "PRESENT (left untouched)" : "none") : dirty.error);

  const allOk = checks.every((c) => c.ok);
  console.log(`\nSTAGE E VALIDATION: ${allOk ? "PASS" : "INCOMPLETE — see failed checks"}`);
  console.log("Worker remains DISABLED pending manual review (spec §16 Stage E).");
  if (!allOk) process.exitCode = 1;
})().catch((e) => { console.error("STAGE E ERROR:", e.message); process.exitCode = 1; });
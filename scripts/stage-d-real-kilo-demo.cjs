"use strict";
// Stage D — real Kilo execution demonstration in a disposable worktree.
// Creates a throwaway repository under .scratch/real-demo, prepares an
// isolated worktree, writes + verifies the deny-by-default Kilo permission
// config with the REAL installed CLI, runs one harmless task, verifies the
// result independently, and writes a report. Never touches any real project.
//
// Usage: node scripts/stage-d-real-kilo-demo.cjs
const fs = require("fs");
const path = require("path");
const { runProcess } = require("../dist/components/process");
const { WorktreeManager } = require("../dist/components/worktree");
const { SecurityManager } = require("../dist/components/security");
const { KiloCliAdapter } = require("../dist/components/kilo");
const { VerificationEngine } = require("../dist/components/verification");
const { ReportGenerator } = require("../dist/components/report");

const ROOT = path.join(__dirname, "..", ".scratch", "real-demo");

async function git(cwd, args) {
  const r = await runProcess("git", ["-c", `safe.directory=${cwd.replace(/\\/g, "/")}`, ...args], { cwd, timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  const repoDir = path.join(ROOT, "repo");
  const originDir = path.join(ROOT, "origin.git");
  const worktreeRoot = path.join(ROOT, "worktrees");

  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
    await git(repoDir, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Real Kilo demo\n");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["-c", "user.name=Kilo Bridge", "-c", "user.email=kilo-bridge@localhost", "commit", "-m", "initial"]);
    await git(repoDir, ["branch", "develop"]);
    await git(ROOT, ["init", "--bare", "-b", "main", originDir]);
    await git(repoDir, ["remote", "add", "origin", originDir]);
    await git(repoDir, ["push", "-u", "origin", "main", "develop"]);
  }

  const worktree = new WorktreeManager({
    projectId: "real-demo",
    localRepoPath: repoDir,
    worktreeRoot,
    baseBranch: "develop",
    branchPrefix: "ai/kilo",
    releaseBranch: "main",
  });

  console.log("== Stage D: real Kilo execution demo ==");
  // The demo repo is disposable: clear any previous demo worktree/branch so
  // the demo can be re-run. This never touches real project work.
  const demoDir = worktree.worktreePathFor("ai/kilo/issue-1");
  if (fs.existsSync(demoDir)) {
    await git(repoDir, ["worktree", "remove", "--force", demoDir]);
  }
  if (await worktree.localBranchExists("ai/kilo/issue-1")) {
    await git(repoDir, ["branch", "-D", "ai/kilo/issue-1"]);
  }
  const prepared = await worktree.prepareTaskWorktree(1, 1);
  if (!prepared.ok) throw new Error(`worktree preparation failed: ${prepared.error}`);
  const { branch, dir, baseSha } = prepared.data;
  console.log(`worktree: ${dir}`);
  console.log(`branch:   ${branch} @ ${baseSha}`);

  const security = new SecurityManager("real-demo", worktreeRoot, path.join(__dirname, ".."));
  const policy = security.generatePolicy({ id: "real-demo" });
  const permFile = security.writeKiloPermissionFile(dir, policy);
  if (!permFile.ok) throw new Error(permFile.error);
  security.writeBridgeCommandPolicy(dir);

  console.log("verifying permission config with the real Kilo CLI...");
  const verified = await security.verifyEffectivePermissions(dir, {});
  if (!verified.ok) throw new Error(`permission verification refused: ${verified.error}`);
  console.log(`permission check: ${verified.data.kiloCheck}`);

  const adapter = new KiloCliAdapter({
    worktreePath: dir,
    taskTitle: "Stage D demo task",
    taskSpec: "Create a file named hello.txt in the project root containing exactly the text: hello-kilo",
    model: process.env.DEMO_MODEL || "kilo/~anthropic/claude-haiku-latest",
    timeoutMs: 5 * 60 * 1000,
    auto: true,
  });
  console.log("preflight (detect, help options, auth)...");
  const preflight = await adapter.preflight();
  if (!preflight.ok) throw new Error(`preflight refused: ${preflight.error}`);
  console.log(`kilo version: ${preflight.data.version}`);

  console.log("running real Kilo task (up to 5 minutes)...");
  const run = await adapter.run();
  console.log(`exit=${run.exitCode} timedOut=${run.timedOut} duration=${Math.round(run.durationMs)}ms session=${run.sessionId ?? "n/a"}`);
  console.log(`final response: ${(run.finalResponse ?? "").slice(0, 300)}`);

  const helloPath = path.join(dir, "hello.txt");
  const created = fs.existsSync(helloPath);
  const content = created ? fs.readFileSync(helloPath, "utf8").trim() : "";
  console.log(`hello.txt created: ${created}, content: ${JSON.stringify(content)}`);

  // Independent verification: the file must exist with the exact content.
  const engine = new VerificationEngine({ worktreePath: dir, resultsDir: path.join(ROOT, "verification") });
  const check = await engine.runCommand({
    name: "hello-content",
    command: process.execPath,
    args: ["-e", `const fs=require('fs');const p=${JSON.stringify(helloPath)};if(!fs.existsSync(p)||fs.readFileSync(p,'utf8').trim()!=='hello-kilo')process.exit(1);console.log('content verified')`],
    required: true, conditional: false, cwd: dir,
  });
  console.log(`independent verification: exit=${check.exitCode} passed=${check.passed}`);

  // Main tree must be untouched.
  const mainStatus = await git(repoDir, ["status", "--porcelain"]);
  const mainUntouched = mainStatus === "" && !fs.existsSync(path.join(repoDir, "hello.txt"));
  console.log(`main working tree untouched: ${mainUntouched}`);

  const diff = await worktree.collectDiff(dir);
  const reportGen = new ReportGenerator(path.join(ROOT, "reports"));
  const status = run.exitCode === 0 && check.passed && created ? "COMPLETE" : "FAILED";
  const report = reportGen.generate({
    taskId: "stage-d-demo", issueNumber: 1, issueUrl: "local-demo", projectId: "real-demo",
    executionId: `demo-${Date.now()}`, attempt: 1,
    startTime: new Date().toISOString(), endTime: new Date().toISOString(),
    kiloVersion: run.kiloVersion, sessionId: run.sessionId, baseSha, featureBranch: branch,
    implementationSummary: run.finalResponse ?? "(none)",
    changedFiles: diff.ok ? diff.data.changedFiles : [], diffStats: diff.ok ? diff.data.stats : "",
    verifications: [{ id: check.id, executionId: "demo", command: check.command, args: check.args, cwd: dir, startTime: check.startTime, endTime: check.endTime ?? undefined, exitCode: check.exitCode ?? undefined, durationMs: check.durationMs ?? undefined, passed: check.passed ?? undefined }],
    testFailures: check.passed ? [] : ["hello-content"], documentationChanges: [],
    securityObservations: ["Real kilo config check passed before execution.", "Deny-by-default worktree permissions active."],
    unmetAcceptanceCriteria: [], outstandingIssues: run.error ? [run.error] : [], status,
  });
  console.log(`report: ${report.ok ? report.data : report.error}`);
  console.log(`\nSTAGE D RESULT: ${status}`);
  if (status !== "COMPLETE") process.exitCode = 1;
})().catch((e) => { console.error("STAGE D ERROR:", e.message); process.exitCode = 1; });
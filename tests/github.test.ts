"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GitHubProvider } from "../src/components/github";
import { LABELS } from "../src/types";
import { makeTempDir, removeDir } from "./helpers/fixtures";

// Mock executables are plain .cjs (not compiled); reference the source tree.
const MOCK_GH = path.join(__dirname, "..", "..", "tests", "helpers", "mock-gh.cjs");

function makeProvider(fixtures: any): { gh: GitHubProvider; dir: string; calls: () => any[] } {
  const dir = makeTempDir("kilo-gh-");
  const fixturesPath = path.join(dir, "fixtures.json");
  const callsPath = path.join(dir, "calls.jsonl");
  fs.writeFileSync(fixturesPath, JSON.stringify(fixtures), "utf8");
  process.env.MOCK_GH_FIXTURES = fixturesPath;
  process.env.MOCK_GH_CALLS = callsPath;
  const gh = new GitHubProvider({
    owner: "test-owner",
    repo: "test-repo",
    ghBin: process.execPath,
    ghPrefixArgs: [MOCK_GH],
  });
  return {
    gh,
    dir,
    calls: () =>
      fs.existsSync(callsPath)
        ? fs.readFileSync(callsPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
        : [],
  };
}

function rawIssue(overrides: any = {}) {
  return {
    number: 1,
    title: "Task",
    body: "Do the thing",
    state: "open",
    url: "https://api.github.com/repos/test-owner/test-repo/issues/1",
    html_url: "https://github.com/test-owner/test-repo/issues/1",
    user: { login: "authorized-user" },
    created_at: "2026-11-12T00:00:00Z",
    updated_at: "2026-11-12T00:00:00Z",
    labels: [{ name: "kilo:ready" }],
    ...overrides,
  };
}

test("github: authStatus parses user from stderr (gh writes status to stderr)", async () => {
  const { gh, dir } = makeProvider({ auth: { authenticated: true, user: "nabeel2323" } });
  const auth = await gh.authStatus();
  assert.equal(auth.authenticated, true);
  assert.equal(auth.user, "nabeel2323");
  removeDir(dir);
});

test("github: authStatus failure", async () => {
  const { gh, dir } = makeProvider({ auth: { authenticated: false } });
  const auth = await gh.authStatus();
  assert.equal(auth.authenticated, false);
  assert.ok(auth.error);
  removeDir(dir);
});

test("github: listOpenIssues normalizes REST shape and filters PRs", async () => {
  const { gh, dir } = makeProvider({
    auth: { authenticated: true },
    api: {
      "repos/test-owner/test-repo/issues?state=open&per_page=100&labels=kilo:ready": [
        rawIssue({ number: 1 }),
        rawIssue({ number: 2, pull_request: { url: "https://api.github.com/..." } }),
        rawIssue({ number: 3, user: { login: "someone-else" } }),
      ],
    },
  });
  const res = await gh.listOpenIssues({ labels: ["kilo:ready"] });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data!.length, 2, "PR must be filtered out");
  const issue = res.data![0];
  assert.equal(issue.number, 1);
  assert.equal(issue.author, "authorized-user");
  assert.equal(issue.htmlUrl, "https://github.com/test-owner/test-repo/issues/1");
  assert.deepEqual(issue.labels, ["kilo:ready"]);
  assert.equal(issue.pullRequest, false);
  removeDir(dir);
});

test("github: rate-limit errors are classified", async () => {
  const { gh, dir } = makeProvider({
    apiErrors: {
      "repos/test-owner/test-repo/issues?state=open&per_page=100": { code: 1, stderr: "API rate limit exceeded for user" },
    },
  });
  const res = await gh.listOpenIssues();
  assert.equal(res.ok, false);
  assert.equal(res.code, "RATE_LIMITED");
  removeDir(dir);
});

test("github: getIssue normalizes", async () => {
  const { gh, dir } = makeProvider({
    api: { "repos/test-owner/test-repo/issues/7": rawIssue({ number: 7, title: "Seven" }) },
  });
  const res = await gh.getIssue(7);
  assert.equal(res.ok, true);
  assert.equal(res.data!.title, "Seven");
  assert.equal(res.data!.author, "authorized-user");
  removeDir(dir);
});

test("github: listComments normalizes and detects bridge marker only", async () => {
  const { gh, dir } = makeProvider({
    api: {
      "repos/test-owner/test-repo/issues/1/comments?per_page=100": [
        { id: 10, body: "please fix", user: { login: "authorized-user" }, created_at: "t1" },
        { id: 11, body: "[kilo-bridge-report] report", user: { login: "bot" }, created_at: "t2" },
        { id: 12, body: "Kilo Bridge is great but this is a human comment", user: { login: "human" }, created_at: "t3" },
      ],
    },
  });
  const res = await gh.listComments(1);
  assert.equal(res.ok, true);
  const comments = res.data!;
  assert.equal(comments.length, 3);
  assert.equal(comments[0].isBridge, false);
  assert.equal(comments[1].isBridge, true);
  assert.equal(comments[2].isBridge, false, "text mention alone must not mark as bridge");
  assert.equal(comments[0].author, "authorized-user");
  removeDir(dir);
});

test("github: addComment posts via stdin JSON and returns real id", async () => {
  const { gh, dir, calls } = makeProvider({ nextCommentId: 5000 });
  const res = await gh.addComment(1, "multi\nline \"report\" body");
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data, 5001);
  const posted = calls().find((c) => c.argv.includes("POST") && c.argv.some((a: string) => a.includes("/comments")));
  assert.ok(posted, "comment POST recorded");
  assert.equal(JSON.parse(posted.stdin).body, "multi\nline \"report\" body");
  removeDir(dir);
});

test("github: ensureLabels creates missing, keeps existing, idempotent", async () => {
  const { gh, dir, calls } = makeProvider({
    api: {
      "repos/test-owner/test-repo/labels?per_page=100": [{ name: "kilo:ready" }, { name: "bug" }],
    },
  });
  const res = await gh.ensureLabels(LABELS);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data!.exists, ["kilo:ready"]);
  assert.equal(res.data!.created.length, LABELS.length - 1);
  const posts = calls().filter((c) => c.argv.includes("POST") && c.argv.some((a: string) => a.endsWith("/labels")));
  assert.equal(posts.length, LABELS.length - 1);
  removeDir(dir);
});

test("github: addLabels/removeLabel use REST", async () => {
  const { gh, dir, calls } = makeProvider({});
  assert.equal((await gh.addLabels(1, ["kilo:claimed"])).ok, true);
  assert.equal((await gh.removeLabel(1, "kilo:ready")).ok, true);
  const log = calls();
  assert.ok(log.some((c) => c.argv.includes("POST") && c.argv.some((a: string) => a.includes("/issues/1/labels"))));
  assert.ok(log.some((c) => c.argv.includes("DELETE") && c.argv.some((a: string) => a.includes("/issues/1/labels/kilo%3Aready"))));
  removeDir(dir);
});

test("github: createDraftPr passes draft/base/head and returns URL", async () => {
  const { gh, dir, calls } = makeProvider({ prCreate: { url: "https://github.com/test-owner/test-repo/pull/9" } });
  const res = await gh.createDraftPr({ title: "T", body: "B", head: "ai/kilo/issue-1", base: "develop" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data, "https://github.com/test-owner/test-repo/pull/9");
  const pr = calls().find((c) => c.argv[0] === "pr");
  assert.ok(pr.argv.includes("--draft"));
  assert.equal(pr.argv[pr.argv.indexOf("--base") + 1], "develop");
  assert.equal(pr.argv[pr.argv.indexOf("--head") + 1], "ai/kilo/issue-1");
  assert.ok(!pr.argv.includes("--merge"), "never merge");
  removeDir(dir);
});

test("github: getRateLimit reads core quota", async () => {
  const { gh, dir } = makeProvider({
    api: { rate_limit: { resources: { core: { remaining: 4999, limit: 5000, reset: 123 } } } },
  });
  const res = await gh.getRateLimit();
  assert.equal(res.ok, true);
  assert.equal(res.data!.remaining, 4999);
  removeDir(dir);
});
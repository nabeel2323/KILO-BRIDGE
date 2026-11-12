"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ReportGenerator, type ReportData } from "../src/components/report";
import type { VerificationRecord } from "../src/types";
import { makeTempDir, removeDir } from "./helpers/fixtures";

function makeData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    taskId: "task-abc",
    issueNumber: 42,
    issueUrl: "https://github.com/o/r/issues/42",
    projectId: "test-project",
    executionId: "exec-1",
    attempt: 1,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    kiloVersion: "7.8.27",
    model: "kilo/model",
    agent: "build",
    sessionId: "sess-1",
    baseSha: "a".repeat(40),
    featureBranch: "ai/kilo/issue-42",
    implementationSummary: "Implemented the feature.",
    changedFiles: ["src/a.ts"],
    diffStats: "1 file changed",
    verifications: [],
    testFailures: [],
    documentationChanges: [],
    securityObservations: [],
    unmetAcceptanceCriteria: [],
    outstandingIssues: [],
    status: "COMPLETE",
    ...overrides,
  };
}

function vrec(command: string, args: string[], passed: boolean | undefined): VerificationRecord {
  return {
    id: Math.random().toString(36).slice(2),
    executionId: "exec-1",
    command,
    args,
    cwd: "C:\\wt",
    startTime: new Date().toISOString(),
    passed,
  };
}

test("report: markdown contains marker and all spec sections", () => {
  const dir = makeTempDir("kilo-rep-");
  const gen = new ReportGenerator(dir);
  const md = gen.renderMarkdown(makeData());
  assert.ok(md.includes("[kilo-bridge-report]"));
  for (const section of [
    "Implementation Summary", "Changed File Inventory", "Git Diff Statistics",
    "Verification Results", "Test Failures", "Documentation Changes",
    "Security Observations", "Unmet Acceptance Criteria", "Outstanding Issues", "Final Result",
  ]) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }
  assert.ok(md.includes("task-abc"));
  assert.ok(md.includes("exec-1"));
  assert.ok(md.includes("7.8.27"));
  assert.ok(md.includes("sess-1"));
  assert.ok(md.includes("a".repeat(40)));
  removeDir(dir);
});

test("report: per-execution files, never overwritten", () => {
  const dir = makeTempDir("kilo-rep-");
  const gen = new ReportGenerator(dir);
  const r1 = gen.generate(makeData({ executionId: "exec-1", attempt: 1 }));
  assert.equal(r1.ok, true);
  const r2 = gen.generate(makeData({ executionId: "exec-2", attempt: 2 }));
  assert.equal(r2.ok, true);
  assert.notEqual(r1.data, r2.data);
  assert.ok(fs.existsSync(r1.data!), "first report preserved");
  assert.ok(fs.existsSync(r2.data!));
  // Same execution id again -> hard error, no overwrite.
  const dup = gen.generate(makeData({ executionId: "exec-1", attempt: 1 }));
  assert.equal(dup.ok, false);
  assert.equal(dup.code, "REPORT_EXISTS");
  removeDir(dir);
});

test("report: comment body has marker, summary, evidence", () => {
  const dir = makeTempDir("kilo-rep-");
  const gen = new ReportGenerator(dir);
  const comment = gen.buildComment(makeData(), "C:\\reports\\x.md");
  assert.ok(comment.startsWith("[kilo-bridge-report]"));
  assert.ok(comment.includes("### Summary"));
  assert.ok(comment.includes("### Verification"));
  assert.ok(comment.includes("### Final Result"));
  assert.ok(comment.includes("COMPLETE"));
  removeDir(dir);
});

test("report: COMPLETE gating — failed required command blocks", () => {
  const dir = makeTempDir("kilo-rep-");
  const gen = new ReportGenerator(dir);
  const required = ["pnpm lint", "pnpm test:unit"];
  const ok = [vrec("pnpm", ["lint"], true), vrec("pnpm", ["test:unit"], true)];
  assert.equal(gen.shouldBeComplete(ok, required), true);
  const failed = [vrec("pnpm", ["lint"], true), vrec("pnpm", ["test:unit"], false)];
  assert.equal(gen.shouldBeComplete(failed, required), false);
  removeDir(dir);
});

test("report: COMPLETE gating — missing required command blocks", () => {
  const dir = makeTempDir("kilo-rep-");
  const gen = new ReportGenerator(dir);
  const required = ["pnpm lint", "pnpm test:unit"];
  const partial = [vrec("pnpm", ["lint"], true)];
  assert.equal(gen.shouldBeComplete(partial, required), false);
  assert.equal(gen.shouldBeComplete([], required), false);
  removeDir(dir);
});

test("report: COMPLETE gating — unexecuted (undefined) required blocks", () => {
  const dir = makeTempDir("kilo-rep-");
  const gen = new ReportGenerator(dir);
  const required = ["pnpm lint"];
  assert.equal(gen.shouldBeComplete([vrec("pnpm", ["lint"], undefined)], required), false);
  removeDir(dir);
});

test("report: advisory failure does not block COMPLETE", () => {
  const dir = makeTempDir("kilo-rep-");
  const gen = new ReportGenerator(dir);
  const required = ["pnpm lint"];
  const results = [vrec("pnpm", ["lint"], true), vrec("pnpm", ["format:check"], false)];
  assert.equal(gen.shouldBeComplete(results, required), true);
  removeDir(dir);
});
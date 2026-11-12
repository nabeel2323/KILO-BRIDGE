"use strict";

import fs from "node:fs";
import path from "node:path";
import type { BridgeResult, ReportStatus, TaskRecord, ExecutionRecord, VerificationRecord } from "../types";
import { okResult, failResult } from "../types";

export interface ReportData {
  taskId: string;
  issueNumber: number;
  issueUrl: string;
  projectId: string;
  executionId: string;
  startTime: string;
  endTime: string;
  kiloVersion?: string;
  model?: string;
  agent?: string;
  sessionId?: string;
  baseSha?: string;
  featureBranch?: string;
  implementationSummary: string;
  changedFiles: string[];
  diffStats: string;
  verifications: VerificationRecord[];
  testFailures: string[];
  documentationChanges: string[];
  securityObservations: string[];
  unmetAcceptanceCriteria: string[];
  outstandingIssues: string[];
  status: ReportStatus;
}

export class ReportGenerator {
  private readonly reportsDir: string;

  constructor(reportsDir: string) {
    this.reportsDir = reportsDir;
  }

  generate(data: ReportData): BridgeResult<string> {
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
    const safe = data.taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const file = path.join(this.reportsDir, `${safe}.md`);
    const md = this.renderMarkdown(data);
    try {
      fs.writeFileSync(file, md, "utf8");
      return okResult(file);
    } catch (err) {
      return failResult(`failed to write report: ${err}`, "REPORT_WRITE_FAILED");
    }
  }

  renderMarkdown(data: ReportData): string {
    const lines: string[] = [];
    lines.push(`# Implementation Report — Issue #${data.issueNumber}`);
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push(`- **Task ID:** ${data.taskId}`);
    lines.push(`- **Project:** ${data.projectId}`);
    lines.push(`- **Issue URL:** ${data.issueUrl}`);
    lines.push(`- **Execution ID:** ${data.executionId}`);
    lines.push(`- **Status:** ${data.status}`);
    lines.push(`- **Start:** ${data.startTime}`);
    lines.push(`- **End:** ${data.endTime}`);
    lines.push(`- **Kilo version:** ${data.kiloVersion ?? "n/a"}`);
    lines.push(`- **Model:** ${data.model ?? "n/a"}`);
    lines.push(`- **Agent:** ${data.agent ?? "n/a"}`);
    lines.push(`- **Session ID:** ${data.sessionId ?? "n/a"}`);
    lines.push(`- **Base commit SHA:** ${data.baseSha ?? "n/a"}`);
    lines.push(`- **Feature branch:** ${data.featureBranch ?? "n/a"}`);
    lines.push("");
    lines.push("> " + this.compactSummary(data));
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## Implementation Summary");
    lines.push("");
    lines.push(data.implementationSummary || "_No summary provided._");
    lines.push("");
    lines.push("## Changed File Inventory");
    lines.push("");
    if (data.changedFiles.length === 0) {
      lines.push("_No files changed._");
    } else {
      for (const f of data.changedFiles) lines.push(`- ${f}`);
    }
    lines.push("");
    lines.push("## Git Diff Statistics");
    lines.push("");
    lines.push("```");
    lines.push(data.diffStats || "(none)");
    lines.push("```");
    lines.push("");
    lines.push("## Verification Results");
    lines.push("");
    if (data.verifications.length === 0) {
      lines.push("_No verification commands executed._");
    } else {
      lines.push("| Command | Exit Code | Passed | Duration (ms) |");
      lines.push("|---------|-----------|--------|---------------|");
      for (const v of data.verifications) {
        lines.push(
          `| ${v.command} ${v.args.join(" ")} | ${v.exitCode ?? "n/a"} | ${v.passed ?? "n/a"} | ${v.durationMs ?? "n/a"} |`
        );
      }
    }
    lines.push("");
    lines.push("## Test Failures");
    lines.push("");
    if (data.testFailures.length === 0) {
      lines.push("_No test failures recorded._");
    } else {
      for (const t of data.testFailures) lines.push(`- ${t}`);
    }
    lines.push("");
    lines.push("## Documentation Changes");
    lines.push("");
    if (data.documentationChanges.length === 0) {
      lines.push("_None._");
    } else {
      for (const d of data.documentationChanges) lines.push(`- ${d}`);
    }
    lines.push("");
    lines.push("## Security Observations");
    lines.push("");
    if (data.securityObservations.length === 0) {
      lines.push("_None recorded._");
    } else {
      for (const s of data.securityObservations) lines.push(`- ${s}`);
    }
    lines.push("");
    lines.push("## Unmet Acceptance Criteria");
    lines.push("");
    if (data.unmetAcceptanceCriteria.length === 0) {
      lines.push("_None._");
    } else {
      for (const u of data.unmetAcceptanceCriteria) lines.push(`- ${u}`);
    }
    lines.push("");
    lines.push("## Outstanding Issues");
    lines.push("");
    if (data.outstandingIssues.length === 0) {
      lines.push("_None._");
    } else {
      for (const o of data.outstandingIssues) lines.push(`- ${o}`);
    }
    lines.push("");
    lines.push("## Final Result");
    lines.push("");
    lines.push(`**${data.status}**`);
    lines.push("");
    lines.push(`---\n*Generated by Kilo Bridge ${new Date().toISOString()}*`);
    return lines.join("\n");
  }

  private compactSummary(data: ReportData): string {
    const failed = data.verifications.filter((v) => v.passed === false).length;
    return `Task #${data.issueNumber} (${data.projectId}): ${data.status}. Verifications failed: ${failed}. Branch: ${data.featureBranch ?? "n/a"}.`;
  }

  // Build a comment body suitable for posting to GitHub (compact top + evidence).
  buildComment(data: ReportData, reportPath: string): string {
    const lines: string[] = [];
    lines.push(`[kilo-bridge-report] Implementation Report — Issue #${data.issueNumber}`);
    lines.push("");
    lines.push("### Summary");
    lines.push("");
    lines.push(`- **Project:** ${data.projectId}`);
    lines.push(`- **Execution ID:** ${data.executionId}`);
    lines.push(`- **Status:** ${data.status}`);
    lines.push(`- **Base SHA:** ${data.baseSha ?? "n/a"}`);
    lines.push(`- **Feature branch:** ${data.featureBranch ?? "n/a"}`);
    lines.push(`- **Kilo version:** ${data.kiloVersion ?? "n/a"}`);
    lines.push(`- **Session ID:** ${data.sessionId ?? "n/a"}`);
    lines.push(`- **Start/End:** ${data.startTime} / ${data.endTime}`);
    lines.push("");
    lines.push("### Verification");
    lines.push("");
    if (data.verifications.length === 0) {
      lines.push("_No verification commands executed._");
    } else {
      for (const v of data.verifications) {
        lines.push(`- ${v.command} ${v.args.join(" ")} → exit ${v.exitCode ?? "n/a"} ${v.passed === true ? "PASS" : v.passed === false ? "FAIL" : "n/a"}`);
      }
    }
    lines.push("");
    lines.push("### Test Failures");
    lines.push("");
    if (data.testFailures.length === 0) {
      lines.push("_None._");
    } else {
      for (const t of data.testFailures) lines.push(`- ${t}`);
    }
    lines.push("");
    lines.push("### Final Result");
    lines.push("");
    lines.push(`**${data.status}**`);
    lines.push("");
    lines.push(`Full report: local file \`${reportPath}\``);
    lines.push("");
    lines.push("---");
    lines.push(`Kilo Bridge ${new Date().toISOString()}`);
    return lines.join("\n");
  }

  isFinal(status: ReportStatus): boolean {
    return ["COMPLETE", "PARTIAL", "BLOCKED", "FAILED"].includes(status);
  }

  shouldBeComplete(results: VerificationRecord[], requiredCount: number): boolean {
    // Never COMPLETE when required tests failed or were not executed.
    const failed = results.filter((v) => v.passed === false).length;
    const notRun = results.filter((v) => v.passed === null || v.passed === undefined).length;
    return failed === 0 && notRun === 0;
  }
}

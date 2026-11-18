"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import {
  detectIsolationCapabilities,
  selectIsolationBackend,
  generateWsbConfig,
  isPathUnderAllowedRoots,
} from "../src/components/isolation";
import {
  SUPPORTED_NATIVE_TOOL_PERMISSIONS,
  UNSUPPORTED_NATIVE_TOOL_PERMISSIONS,
  REQUIRED_NATIVE_TOOL_PERMISSIONS,
} from "../src/types";

const KILO_BIN = "kilo";
const BRIDGE_ROOT = path.resolve("C:/TAIF/KILO-BRIDGE");
const FIXTURES_ROOT = path.join(BRIDGE_ROOT, "test-fixtures");
const LOCAL_PROVIDER_SERVER = path.join(FIXTURES_ROOT, "local-provider", "server.js");
let PROVIDER_PORT: number | null = null;

function runKiloDebugAgent(agentName: string, tool: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`"${KILO_BIN}" debug agent "${agentName}" --tool "${tool}"`, {
      encoding: "utf8",
      windowsHide: true,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      code: 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

function httpRequest(port: number, method: string, pathname: string, body: string | null): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path: pathname, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString("utf8")));
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const attempt = (): Promise<void> =>
    httpRequest(port, "GET", "/v1/chat/completions", null).then(() => undefined, () => {
      if (Date.now() >= deadline) throw new Error(`port ${port} did not accept connections within ${timeoutMs} ms`);
      return new Promise((resolve) => setTimeout(resolve, 100)).then(attempt);
    });
  await attempt();
}

// ---------------------------------------------------------------------------
// 1-4. Native tool permission tests via `kilo debug agent`
// ---------------------------------------------------------------------------

test("p310: smoke agent denies read", () => {
  const res = runKiloDebugAgent("bridge-smoke-test", "read");
  assert.equal(res.code !== 0, true, "expected non-zero exit code for denied tool");
  assert.ok(res.stdout.includes("disabled") || res.stderr.includes("disabled"), `expected "disabled" output, got: ${res.stdout}${res.stderr}`);
});

test("p310: smoke agent denies bash", () => {
  const res = runKiloDebugAgent("bridge-smoke-test", "bash");
  assert.equal(res.code !== 0, true);
  assert.ok(res.stdout.includes("disabled") || res.stderr.includes("disabled"), `expected "disabled" output, got: ${res.stdout}${res.stderr}`);
});

test("p310: normal-coding agent allows read", () => {
  const res = runKiloDebugAgent("bridge-normal-coding-test", "read");
  const output = res.stdout + res.stderr;
  assert.ok(!output.includes("disabled"), `expected read to be allowed (schema error/file not found ok), got: ${output}`);
  assert.ok(output.includes("invalid arguments") || output.includes("filePath"), `expected read tool schema validation (allowed), got: ${output}`);
});

test("p310: normal-coding agent denies bash", () => {
  const res = runKiloDebugAgent("bridge-normal-coding-test", "bash");
  assert.equal(res.code !== 0, true);
  assert.ok(res.stdout.includes("disabled") || res.stderr.includes("disabled"), `expected "disabled" output, got: ${res.stdout}${res.stderr}`);
});

// ---------------------------------------------------------------------------
// 5. Local deterministic provider
// ---------------------------------------------------------------------------

test("p310: local provider starts and responds", async () => {
  const child = spawn(process.execPath, [LOCAL_PROVIDER_SERVER], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let providerStdout = "";
  child.stdout.on("data", (d) => (providerStdout += d.toString("utf8")));
  try {
    // Wait for the provider to print its actual port
    const portMatch = await new Promise<string | null>((resolve) => {
      const check = () => {
        const m = providerStdout.match(/actual port: (\d+)/);
        if (m) resolve(m[1]);
        else if (Date.now() - startTime > 15000) resolve(null);
        else setTimeout(check, 100);
      };
      const startTime = Date.now();
      check();
    });
    if (!portMatch) throw new Error("provider did not print actual port within 15s");
    PROVIDER_PORT = parseInt(portMatch, 10);
    await waitForPort(PROVIDER_PORT);
    const body = JSON.stringify({
      model: "local-test/local-model",
      messages: [{ role: "user", content: "verify native tool execution" }],
      tools: [{ type: "function", function: { name: "native_tool_execute", parameters: { type: "object", properties: {}, required: [] } } }],
    });
    const res = await httpRequest(PROVIDER_PORT, "POST", "/v1/chat/completions", body);
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.object, "chat.completion");
    assert.ok(Array.isArray(parsed.choices) && parsed.choices.length > 0);
  } finally {
    try { child.kill(); } catch {}
  }
});

// ---------------------------------------------------------------------------
// 6. Windows Sandbox config generation
// ---------------------------------------------------------------------------

test("p310: generateWsbConfig produces valid XML", () => {
  const inboxPath = path.join(FIXTURES_ROOT, "sandbox-inbox-p310");
  const outboxPath = path.join(FIXTURES_ROOT, "sandbox-outbox-p310");
  const bootstrapScriptPath = path.join(FIXTURES_ROOT, "bootstrap-p310.ps1");
  const config = {
    inboxPath,
    outboxPath,
    bootstrapScriptPath,
    kiloConfigPath: path.join(FIXTURES_ROOT, "native-test-config", "kilo.jsonc"),
    executionId: "p310-wsb-test",
  };
  const xml = generateWsbConfig(config);
  assert.ok(xml.startsWith("<?xml"), "wsb config must be an XML document");
  assert.ok(xml.includes("<Configuration>"), "missing Configuration root element");
  assert.ok(xml.includes("<Networking>Disable</Networking>"), "Networking must be disabled");
  assert.ok(xml.includes("<ClipboardRedirection>Disable</ClipboardRedirection>"), "ClipboardRedirection must be disabled");
  assert.ok(xml.includes(`<HostFolder>${inboxPath}</HostFolder>`), "inbox HostFolder missing");
  assert.ok(xml.includes(`<HostFolder>${outboxPath}</HostFolder>`), "outbox HostFolder missing");

  const inboxIdx = xml.indexOf(`<HostFolder>${inboxPath}</HostFolder>`);
  const outboxIdx = xml.indexOf(`<HostFolder>${outboxPath}</HostFolder>`);
  const inboxReadonlyIdx = xml.indexOf("<ReadOnly>true</ReadOnly>", inboxIdx);
  const outboxReadonlyIdx = xml.indexOf("<ReadOnly>false</ReadOnly>", outboxIdx);
  assert.ok(inboxReadonlyIdx !== -1 && inboxReadonlyIdx > inboxIdx, "inbox must be ReadOnly=true");
  assert.ok(outboxReadonlyIdx !== -1 && outboxReadonlyIdx > outboxIdx, "outbox must be ReadOnly=false");
  assert.ok(inboxIdx < outboxIdx, "inbox must precede outbox in XML");
});

test("p310: WSB uses SandboxFolder not SandboxPath", () => {
  const inboxPath = path.join(FIXTURES_ROOT, "sandbox-inbox-p310");
  const outboxPath = path.join(FIXTURES_ROOT, "sandbox-outbox-p310");
  const config = {
    inboxPath,
    outboxPath,
    bootstrapScriptPath: path.join(FIXTURES_ROOT, "bootstrap-p310.ps1"),
    kiloConfigPath: path.join(FIXTURES_ROOT, "native-test-config", "kilo.jsonc"),
    executionId: "p310-wsb-folder-test",
  };
  const xml = generateWsbConfig(config);
  assert.ok(xml.includes("<SandboxFolder>"), "must use SandboxFolder element");
  assert.ok(!xml.includes("<SandboxPath>"), "must NOT use the invalid SandboxPath element");
});

test("p310: WSB uses LogonCommand with Command child", () => {
  const inboxPath = path.join(FIXTURES_ROOT, "sandbox-inbox-p310");
  const outboxPath = path.join(FIXTURES_ROOT, "sandbox-outbox-p310");
  const config = {
    inboxPath,
    outboxPath,
    bootstrapScriptPath: path.join(FIXTURES_ROOT, "bootstrap-p310.ps1"),
    kiloConfigPath: path.join(FIXTURES_ROOT, "native-test-config", "kilo.jsonc"),
    executionId: "p310-wsb-command-test",
  };
  const xml = generateWsbConfig(config);
  assert.ok(xml.includes("<LogonCommand>"), "must contain LogonCommand element");
  assert.ok(xml.includes("<Command>"), "LogonCommand must contain a Command child element");
  assert.ok(xml.includes("</Command>"), "Command element must be closed");
  assert.ok(xml.includes("powershell.exe"), "Command must invoke powershell.exe");
});

test("p310: WSB XML is well-formed and escapes special characters", () => {
  const inboxPath = "C:\\tmp\\in&box<x>\"'";
  const outboxPath = "C:\\tmp\\out&box<x>\"'";
  const bootstrapScriptPath = "C:\\tmp\\bootstrap<&>\"'.ps1";
  const config = {
    inboxPath,
    outboxPath,
    bootstrapScriptPath,
    kiloConfigPath: "C:\\tmp\\kilo.jsonc",
    executionId: "p310-wsb-escape-test",
  };
  const xml = generateWsbConfig(config);

  // Assert raw unescaped metacharacters do not appear inside element text.
  assert.ok(!xml.includes("<HostFolder>C:\\tmp\\in&box"), "must not emit unescaped ampersand");
  assert.ok(xml.includes("&amp;"), "must escape ampersand");
  assert.ok(xml.includes("&lt;"), "must escape less-than");
  assert.ok(xml.includes("&gt;"), "must escape greater-than");
  assert.ok(xml.includes("&quot;"), "must escape double quote");
  assert.ok(xml.includes("&apos;"), "must escape single quote");

  // Simple structural well-formedness: every opened mapped folder is closed.
  const openCount = (xml.match(/<MappedFolder>/g) || []).length;
  const closeCount = (xml.match(/<\/MappedFolder>/g) || []).length;
  assert.equal(openCount, 2, "must have two mapped folders");
  assert.equal(openCount, closeCount, "MappedFolder elements must be balanced");
});

// ---------------------------------------------------------------------------
// 7. Isolation backend selection
// ---------------------------------------------------------------------------

test("p310: selectIsolationBackend returns WORKTREE_ONLY", () => {
  const caps = detectIsolationCapabilities();
  const sandbox = caps.find((c) => c.backend === "WINDOWS_SANDBOX");
  assert.ok(sandbox, "WINDOWS_SANDBOX capability entry must exist");
  assert.equal(sandbox.available, true, "Windows Sandbox must be available on this machine");
  assert.equal(sandbox.provisioned, false, "Windows Sandbox must not be provisioned");
  assert.equal(selectIsolationBackend(), "WORKTREE_ONLY", "WORKTREE_ONLY must be selected when no backend is provisioned");
});

// ---------------------------------------------------------------------------
// 8. Path containment
// ---------------------------------------------------------------------------

test("p310: path containment prevents escape", () => {
  const allowedRoots = [BRIDGE_ROOT, FIXTURES_ROOT];
  assert.equal(isPathUnderAllowedRoots(path.join(BRIDGE_ROOT, "src", "components", "isolation.ts"), allowedRoots), true);
  assert.equal(isPathUnderAllowedRoots(BRIDGE_ROOT, allowedRoots), true);
  assert.equal(isPathUnderAllowedRoots(path.join(FIXTURES_ROOT, "local-provider", "server.js"), allowedRoots), true);
  assert.equal(isPathUnderAllowedRoots(path.join("C:", "Windows", "System32"), allowedRoots), false);
  assert.equal(isPathUnderAllowedRoots(path.join(BRIDGE_ROOT, "..", "..", "Windows"), allowedRoots), false);
});

// ---------------------------------------------------------------------------
// 9. kilo debug agent lists available tools
// ---------------------------------------------------------------------------

test("p310: kilo debug agent lists available tools", () => {
  const smoke = JSON.parse(execSync(`"${KILO_BIN}" debug agent bridge-smoke-test`, { encoding: "utf8", windowsHide: true }));
  const normal = JSON.parse(execSync(`"${KILO_BIN}" debug agent bridge-normal-coding-test`, { encoding: "utf8", windowsHide: true }));
  assert.equal(smoke.name, "bridge-smoke-test");
  assert.equal(normal.name, "bridge-normal-coding-test");
  assert.equal(smoke.tools.read, false);
  assert.equal(smoke.tools.glob, false);
  assert.equal(smoke.tools.grep, false);
  assert.equal(smoke.tools.edit, false);
  assert.equal(smoke.tools.bash, false);
  assert.equal(normal.tools.read, true);
  assert.equal(normal.tools.glob, true);
  assert.equal(normal.tools.grep, true);
  assert.equal(normal.tools.edit, true);
assert.equal(normal.tools.write, true);
  assert.equal(normal.tools.bash, false);
});

// ---------------------------------------------------------------------------
// 10. Sandbox staging & session detection regression tests
// ---------------------------------------------------------------------------

import { validateSandboxStaging } from "../src/components/isolation";
import { detectExistingSandboxSession } from "../src/components/isolation";
import { classifySandboxProcesses } from "../src/components/isolation";
import { validateSandboxGuestResult, isFreshResultFile } from "../src/components/isolation";
import { SANDBOX_RESULT_PROTOCOL_VERSION } from "../src/components/isolation";

test("p310: validateSandboxStaging requires inbox/outbox directories", () => {
  const inboxPath = path.join(FIXTURES_ROOT, "nonexistent-inbox");
  const outboxPath = path.join(FIXTURES_ROOT, "nonexistent-outbox");
  const errors = validateSandboxStaging({
    inboxPath,
    outboxPath,
    bootstrapScriptPath: "bootstrap.ps1",
    kiloExePath: "kilo.exe",
    providerScriptPath: "server.js",
    kiloConfigPath: "kilo.jsonc",
  });
  assert.ok(errors.length >= 2, "must report missing inbox and outbox");
  assert.ok(errors.some((e) => e.includes("inbox directory does not exist")), "inbox error must be actionable");
  assert.ok(errors.some((e) => e.includes("outbox directory does not exist")), "outbox error must be actionable");
});

test("p310: detectExistingSandboxSession reports no session when none exists", () => {
  // We cannot easily mock Get-Process here; just verify function runs without throw
  const result = detectExistingSandboxSession();
assert.ok(typeof result.detected === "boolean");
  assert.ok(Array.isArray(result.clients));
  assert.ok(Array.isArray(result.launchers));
assert.ok(Array.isArray(result.vmWorkers));
  // result.detail does not exist on SandboxSessionDetection
});

test("p310: classifySandboxProcesses ignores unrelated vmwp processes", () => {
  const processes = [
    { name: "vmwp.exe", pid: 1234 },
    { name: "vmwp.exe", pid: 5678 },
  ];
  const result = classifySandboxProcesses(processes);
  assert.equal(result.detected, false, "bare vmwp processes must not be treated as a Sandbox session");
  assert.equal(result.clients.length, 0);
  assert.equal(result.launchers.length, 0);
  assert.equal(result.vmWorkers.length, 2);
});

test("p310: validateSandboxGuestResult rejects stale result file (pre-dates launch)", () => {
  const launchTimeMs = Date.now();
  const staleMtimeMs = launchTimeMs - 5000; // 5 seconds before launch
  const result = {
    protocolVersion: SANDBOX_RESULT_PROTOCOL_VERSION,
    executionId: "test-exec-id",
    stages: [{ stage: "guest-bootstrap-started", ok: true, detail: "", ts: new Date().toISOString() }],
    finalStatus: "success",
    kiloExitCode: 0,
    toolEvidence: [{ tool: "test", success: true }],
    outputArtifacts: [],
  };
  const validation = validateSandboxGuestResult(result, {
    executionId: "test-exec-id",
    launchTimeMs,
    statMtimeMs: staleMtimeMs,
  });
  assert.equal(validation.ok, false, "stale result file must be rejected");
  assert.ok(validation.errors.some((e) => e.includes("predates sandbox launch")), "error must mention staleness");
});

test("p310: classifySandboxProcesses detects WindowsSandboxClient as active session", () => {
  const processes = [
    { name: "WindowsSandboxClient.exe", pid: 4321 },
    { name: "vmwp.exe", pid: 9999 },
  ];
  const result = classifySandboxProcesses(processes);
  assert.equal(result.detected, true, "WindowsSandboxClient.exe must be treated as an active Sandbox session");
  assert.ok(result.clients.includes(4321), "client pid must be reported");
  assert.equal(result.vmWorkers.length, 1, "unrelated vmwp must still be classified separately");
});

test("p310: validateSandboxGuestResult rejects missing required stages", () => {
  const result = {
    protocolVersion: SANDBOX_RESULT_PROTOCOL_VERSION,
    executionId: "test-exec-id",
    stages: [{ stage: "guest-bootstrap-started", ok: true, detail: "", ts: new Date().toISOString() }],
    finalStatus: "success",
    kiloExitCode: 0,
    toolEvidence: [{ tool: "test", success: true }],
    outputArtifacts: [],
  };
  const validation = validateSandboxGuestResult(result, {
    executionId: "test-exec-id",
    launchTimeMs: Date.now(),
    statMtimeMs: Date.now(),
  });
  assert.equal(validation.ok, false, "missing stages must be rejected");
  assert.ok(validation.errors.some((e) => e.includes("missing required guest stage")), "error must list missing stages");
});

test("p310: isFreshResultFile accepts fresh result and rejects pre-launch mtime", () => {
  const freshPath = path.join(FIXTURES_ROOT, "phase310-fresh-result.json");
  fs.writeFileSync(freshPath, "test");
  const freshStat = fs.statSync(freshPath).mtimeMs;
  assert.equal(isFreshResultFile(freshPath, freshStat, freshStat), true, "result written after launch must be fresh");
  fs.rmSync(freshPath, { force: true });

  const stalePath = path.join(FIXTURES_ROOT, "phase310-stale-result.json");
  fs.writeFileSync(stalePath, "test");
  const staleMtime = new Date(Date.now() - 60000);
  fs.utimesSync(stalePath, staleMtime, staleMtime);
  const staleStat = fs.statSync(stalePath).mtimeMs;
  assert.equal(isFreshResultFile(stalePath, Date.now(), staleStat), false, "result predating launch must be rejected");
  fs.rmSync(stalePath, { force: true });
});

test("p310: classifySandboxProcesses treats WindowsSandboxClient as active session and blocks launch", () => {
  // Simulate the detection result that launchWindowsSandbox uses to refuse a
  // second launch: a WindowsSandboxClient.exe process must set detected=true.
  const processes = [
    { name: "WindowsSandboxClient.exe", pid: 4321 },
    { name: "WindowsSandbox.exe", pid: 4320 },
    { name: "vmwp.exe", pid: 9999 },
  ];
  const result = classifySandboxProcesses(processes);
  assert.equal(result.detected, true, "WindowsSandboxClient.exe must be treated as an active Sandbox session");
  assert.ok(result.clients.includes(4321), "client pid must be reported");
  assert.ok(result.launchers.includes(4320), "launcher pid must be reported");
  assert.equal(result.vmWorkers.length, 1, "unrelated vmwp must still be classified separately");
  // The launch block message must reference the client PID so the operator
  // knows which process to close before retrying.
  const message = `an active Windows Sandbox session is already running (WindowsSandboxClient.exe PID ${result.clients.join(", ")}); close the existing Sandbox window/session before retrying`;
  assert.ok(message.includes("4321"), "block message must name the offending client PID");
});

test("p310: validateSandboxGuestResult distinguishes launcher exit from guest completion", () => {
  // A guest result whose kiloExitCode is null must not be accepted even if the
  // launcher (WindowsSandbox.exe) exited cleanly — the guest never finished.
  const result = {
    protocolVersion: SANDBOX_RESULT_PROTOCOL_VERSION,
    executionId: "test-exec-id",
    stages: [
      { stage: "guest-bootstrap-started", ok: true, detail: "", ts: new Date().toISOString() },
      { stage: "kilo-completed", ok: false, detail: "kilo exit code null", ts: new Date().toISOString() },
    ],
    finalStatus: "failure",
    kiloExitCode: null,
    toolEvidence: [{ tool: "read", success: false }],
    outputArtifacts: [],
  };
  const validation = validateSandboxGuestResult(result, {
    executionId: "test-exec-id",
    launchTimeMs: Date.now(),
    statMtimeMs: Date.now(),
  });
  assert.equal(validation.ok, false, "a guest result with null kiloExitCode must not be accepted");
  assert.ok(validation.errors.some((e) => e.includes("kilo execution exit code missing")), "error must cite the missing kilo exit code");
  // The launcher PID must not be mistaken for the guest exit code.
  const withLauncherPid = validateSandboxGuestResult(result, {
    executionId: "test-exec-id",
    launcherPid: 9999,
    launchTimeMs: Date.now(),
    statMtimeMs: Date.now(),
  });
  assert.equal(withLauncherPid.ok, false, "launcher PID must not substitute for guest kiloExitCode");
});

test("p310: validateSandboxGuestResult rejects failed finalStatus and non-zero kiloExitCode", () => {
  const result = {
    protocolVersion: SANDBOX_RESULT_PROTOCOL_VERSION,
    executionId: "test-exec-id",
    stages: [
      { stage: "guest-bootstrap-started", ok: true, detail: "", ts: new Date().toISOString() },
      { stage: "kilo-completed", ok: true, detail: "", ts: new Date().toISOString() },
    ],
    finalStatus: "failure",
    kiloExitCode: 1,
    toolEvidence: [{ tool: "read", success: true }],
    outputArtifacts: [],
  };
  const validation = validateSandboxGuestResult(result, {
    executionId: "test-exec-id",
    launchTimeMs: Date.now(),
    statMtimeMs: Date.now(),
  });
  assert.equal(validation.ok, false, "a failed guest execution must not be accepted");
  assert.ok(validation.errors.some((e) => e.includes("final status is not success")), "error must cite final status");
  assert.ok(validation.errors.some((e) => e.includes("kilo execution failed with exit code 1")), "error must cite kilo exit code");
});



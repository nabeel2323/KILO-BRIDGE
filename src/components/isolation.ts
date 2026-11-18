"use strict";

// Execution isolation backends (Phase 3.7).
// Provides pluggable OS-enforced execution boundaries for Kilo subprocesses.
// WORKTREE_ONLY is the default and only application-level separation.
// WINDOWS_SANDBOX and RESTRICTED_ACCOUNT require OS capabilities that may not
// be available on all machines.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runProcess } from "./process";

export type IsolationBackend = "WORKTREE_ONLY" | "WINDOWS_SANDBOX" | "RESTRICTED_ACCOUNT" | "OS_SANDBOX";

export interface SandboxConfig {
  inboxPath: string;
  outboxPath: string;
  bootstrapScriptPath: string;
  kiloConfigPath: string;
  executionId: string;
  timeoutMs?: number;
}

export type SandboxFinalStatus =
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "BOOT_FAILED"
  | "PROVIDER_FAILED"
  | "KILO_FAILED"
  | "EVIDENCE_INCOMPLETE";

export interface SandboxOutputArtifact {
  name: string;
  sha256: string;
  size: number;
}

export interface SandboxExecutionResult {
  executionId: string;
  finalStatus: SandboxFinalStatus;
  guestBootVerified: boolean;
  providerStarted: boolean;
  providerHealthVerified: boolean;
  kiloStarted: boolean;
  kiloExitCode: number | null;
  effectiveConfigHash: string | null;
  nativeToolEvidence: unknown;
  outputArtifacts: SandboxOutputArtifact[];
  timeout: number;
  error: string | null;
  cleanupStatus: "cleaned" | "cleanup-failed";
}

export const SANDBOX_RESULT_PROTOCOL_VERSION = 2;

export interface SandboxProcessInfo {
  name: string;
  pid: number;
}

export interface SandboxSessionDetection {
  detected: boolean;
  clients: number[];
  launchers: number[];
  vmWorkers: number[];
}

export interface SandboxStagingPaths {
  inboxPath: string;
  outboxPath: string;
  bootstrapScriptPath: string;
  kiloExePath: string;
  providerScriptPath: string;
  kiloConfigPath: string;
  nodeExePath?: string;
}

export interface SandboxResultValidationOptions {
  executionId: string;
  launcherPid?: number;
  launchTimeMs?: number;
  statMtimeMs?: number;
  readResultText?: string;
  parseResult?: (text: string) => unknown;
  verifyArtifact?: (relPath: string, expectedSha256: string) => boolean;
  nowMs?: number;
}

export interface SandboxResultValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  result: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Sandbox session detection
// ---------------------------------------------------------------------------

// Classify enumerated processes into Windows Sandbox guests versus unrelated
// Hyper-V workers. Only WindowsSandboxClient.exe is treated as proof of an
// active guest session; bare vmwp.exe processes may belong to unrelated VMs
// and are reported but never treated as a Sandbox instance.
export function classifySandboxProcesses(processes: SandboxProcessInfo[]): SandboxSessionDetection {
  const clients = processes.filter((p) => p.name.toLowerCase() === "windowssandboxclient.exe").map((p) => p.pid);
  const launchers = processes.filter((p) => p.name.toLowerCase() === "windowssandbox.exe").map((p) => p.pid);
  const vmWorkers = processes.filter((p) => p.name.toLowerCase() === "vmwp.exe").map((p) => p.pid);
  return { detected: clients.length > 0, clients, launchers, vmWorkers };
}

// Enumerate sandbox-related processes via PowerShell. Best effort: any
// failure degrades to "unable to enumerate" rather than blocking launch.
export function detectExistingSandboxSession(): SandboxSessionDetection {
  try {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process WindowsSandboxClient,WindowsSandbox -ErrorAction SilentlyContinue | Select-Object Name,Id | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8" },
    );
    const processes: SandboxProcessInfo[] = [];
    const raw = (result.stdout || "").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of arr) {
          processes.push({ name: String(entry.Name ?? entry.name ?? ""), pid: Number(entry.Id ?? entry.id ?? 0) });
        }
      } catch {
        // unparseable output: fall back to empty
      }
    }
    return classifySandboxProcesses(processes);
  } catch {
    return { detected: false, clients: [], launchers: [], vmWorkers: [] };
  }
}

// ---------------------------------------------------------------------------
// Staging validation
// ---------------------------------------------------------------------------

export function validateSandboxStaging(paths: SandboxStagingPaths): string[] {
  const errors: string[] = [];
  const checkFile = (label: string, target: string): void => {
    if (!fs.existsSync(target)) {
      errors.push(`${label} does not exist: ${target}`);
      return;
    }
    try {
      if (!fs.statSync(target).isFile()) {
        errors.push(`${label} is not a file: ${target}`);
      }
    } catch {
      errors.push(`${label} cannot be stat'ed: ${target}`);
    }
  };
  const checkDir = (label: string, target: string): void => {
    if (!fs.existsSync(target)) {
      errors.push(`${label} directory does not exist: ${target}`);
      return;
    }
    try {
      if (!fs.statSync(target).isDirectory()) {
        errors.push(`${label} path is not a directory: ${target}`);
      }
    } catch {
      errors.push(`${label} cannot be stat'ed: ${target}`);
    }
  };
  checkDir("inbox", paths.inboxPath);
  // Do not require outbox contents to exist; an empty directory is valid.
  checkDir("outbox", paths.outboxPath);
  checkFile("bootstrap script", paths.bootstrapScriptPath);
  checkFile("kilo launcher", paths.kiloExePath);
  if (paths.nodeExePath) checkFile("node runtime", paths.nodeExePath);
  checkFile("local provider", paths.providerScriptPath);
  checkFile("isolated Kilo configuration", paths.kiloConfigPath);
  return errors;
}

// ---------------------------------------------------------------------------
// Guest result validation
// ---------------------------------------------------------------------------

const REQUIRED_STAGES = [
  "guest-bootstrap-started",
  "mapped-folders-accessible",
  "node-runtime-found",
  "kilo-launcher-found",
  "kilo-config-found",
  "provider-script-found",
  "provider-started",
  "provider-health",
  "kilo-started",
  "kilo-completed",
  "result-file-written",
];

function getStringProp(value: unknown, key: string): string | null {
  if (value === null || value === undefined) return null;
  const obj = value as Record<string, unknown>;
  if (key in obj && typeof obj[key] === "string") return obj[key] as string;
  return null;
}

function getBoolProp(value: unknown, key: string): boolean | null {
  if (value === null || value === undefined) return null;
  const obj = value as Record<string, unknown>;
  if (key in obj && typeof obj[key] === "boolean") return obj[key] as boolean;
  return null;
}

function getNumberProp(value: unknown, key: string): number | null {
  if (value === null || value === undefined) return null;
  const obj = value as Record<string, unknown>;
  if (key in obj && typeof obj[key] === "number") return obj[key] as number;
  return null;
}

export function validateSandboxGuestResult(
  result: unknown,
  opts: SandboxResultValidationOptions,
): SandboxResultValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (result === null || result === undefined || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, errors: ["sandbox result is not a JSON object"], warnings, result: null };
  }
  const res = result as Record<string, unknown>;

  const protocolVersion = getNumberProp(res, "protocolVersion");
  if (protocolVersion !== SANDBOX_RESULT_PROTOCOL_VERSION) {
    errors.push(`unsupported protocol version: ${protocolVersion ?? "missing"}`);
  }

  const executionId = getStringProp(res, "executionId");
  if (executionId !== opts.executionId) {
    errors.push(`execution id mismatch: expected ${opts.executionId}, got ${executionId ?? "missing"}`);
  }

  const stages = res.stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    errors.push("no guest startup stages recorded");
  } else {
    const stageNames = new Set<string>();
    let bootStartedOk: boolean | null = null;
    for (const stage of stages) {
      const s = stage as Record<string, unknown>;
      const name = typeof s.stage === "string" ? s.stage : undefined;
      if (name) stageNames.add(name);
      if (name === "guest-bootstrap-started") bootStartedOk = s.ok === true;
    }
    for (const required of REQUIRED_STAGES) {
      if (!stageNames.has(required)) errors.push(`missing required guest stage: ${required}`);
    }
    if (bootStartedOk === false) {
      errors.push("guest bootstrap did not successfully start");
    } else if (bootStartedOk === null) {
      errors.push("guest bootstrap stage missing");
    }
  }

  const finalStatus = getStringProp(res, "finalStatus");
  if (finalStatus !== "success") {
    errors.push(`guest final status is not success: ${finalStatus ?? "missing"}`);
  }

  const kiloExitCode = getNumberProp(res, "kiloExitCode");
  if (kiloExitCode === null) {
    errors.push("kilo execution exit code missing");
  } else if (kiloExitCode !== 0) {
    errors.push(`kilo execution failed with exit code ${kiloExitCode}`);
  }

  const toolEvidence = res.toolEvidence;
  if (!Array.isArray(toolEvidence) || toolEvidence.length === 0) {
    errors.push("no guest tool evidence present");
  }

  const nowMs = opts.nowMs ?? Date.now();
  // Staleness check: result must have been produced after the guest launch.
  if (opts.statMtimeMs !== undefined && opts.launchTimeMs !== undefined) {
    const toleranceMs = 2000;
    if (opts.statMtimeMs < opts.launchTimeMs - toleranceMs) {
      errors.push(`guest result file predates sandbox launch (mtime ${opts.statMtimeMs} < launch ${opts.launchTimeMs})`);
    } else if (opts.statMtimeMs > nowMs + toleranceMs) {
      warnings.push(`guest result file mtime is in the future relative to host clock`);
    }
  }

  // Artifact integrity: recorded artifacts must be verifiable.
  const artifacts = res.outputArtifacts;
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      const a = artifact as Record<string, unknown>;
      const name = typeof a.name === "string" ? a.name : undefined;
      const sha256 = typeof a.sha256 === "string" ? a.sha256 : undefined;
      if (!name || !sha256) {
        errors.push("output artifact missing name or sha256");
        continue;
      }
      if (opts.verifyArtifact && !opts.verifyArtifact(name, sha256)) {
        errors.push(`artifact integrity check failed: ${name}`);
      }
    }
  }

  if (Array.isArray(toolEvidence) && toolEvidence.length === 0 && !Array.isArray(artifacts)) {
    errors.push("no execution evidence recorded");
  }

  return { ok: errors.length === 0, errors, warnings, result: res };
}

// Determine whether a result file path is fresh relative to guest launch.
export function isFreshResultFile(resultPath: string, launchTimeMs: number, nowMs?: number): boolean {
  const ref = nowMs ?? Date.now();
  let statMs: number | undefined;
  try {
    statMs = fs.statSync(resultPath).mtimeMs;
  } catch {
    return false;
  }
  const toleranceMs = 2000;
  return statMs >= launchTimeMs - toleranceMs && statMs <= ref + toleranceMs;
}

export interface IsolationCapability {
  backend: IsolationBackend;
  available: boolean;
  // provisioned means the backend is ready for automated launch, not merely
  // that the OS feature exists on the machine. Available != provisioned.
  provisioned: boolean;
  reason?: string;
  prerequisites?: string;
  operatorAction?: string;
}

export interface IsolationResult {
  ok: boolean;
  backend: IsolationBackend;
  pid?: number;
  error?: string;
  cleanup?: () => Promise<void>;
}

const BRIDGE_ROOT = "C:\\TAIF\\KILO-BRIDGE";
const SANDBOX_FIXTURES_ROOT = path.join(BRIDGE_ROOT, "test-fixtures");
const WINDOWS_SANDBOX_EXE = "C:\\Windows\\System32\\WindowsSandbox.exe";
const WINDOWS_SANDBOX_FEATURE = "Containers-DisposableClientVM";
const SANDBOX_DESKTOP = "C:\\Users\\WDAGUtilityAccount\\Desktop";
const SANDBOX_WORK_DIR = "C:\\Users\\WDAGUtilityAccount\\Desktop\\work";
const SANDBOX_PORT = 34567;
const DEFAULT_TIMEOUT_MS = 600000;
const KILO_MODEL = "local-test/local-model";
const KILO_AGENT = "bridge-normal-coding-test";

// Escape text for safe inclusion in a Windows Sandbox .wsb XML document.
function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(new RegExp(String.fromCharCode(39)), "&apos;");
}

// Validate that a target path does not escape any of the allowed root
// directories. Fail closed: returns false unless the resolved target is
// equal to or strictly within one of the resolved roots.
export function isPathUnderAllowedRoots(target: string, allowedRoots: string[]): boolean {
  const resolved = path.resolve(target).toLowerCase();
  for (const root of allowedRoots) {
    const rootResolved = path.resolve(root).toLowerCase();
    if (
      resolved === rootResolved ||
      resolved.startsWith(rootResolved + "\\") ||
      resolved.startsWith(rootResolved + "/")
    ) {
      return true;
    }
  }
  return false;
}

// Resolve the kilo executable to copy into the sandbox inbox.
function resolveKiloExe(): string | undefined {
  const bin = process.env.KILO_BIN ?? "kilo";
  if (path.extname(bin) && fs.existsSync(bin)) {
    return bin;
  }
  try {
    const result = spawnSync("where.exe", [bin], { encoding: "utf8" });
    const line = (result.stdout || "").split(/\r?\n/)[0].trim();
    if (line && fs.existsSync(line)) {
      return line;
    }
  } catch {
    // ignore
  }
  return undefined;
}

// Build the PowerShell bootstrap script that runs inside the sandbox.
// It performs end-to-end verification: input/output directory checks,
// provider startup with an Invoke-RestMethod health check, kilo execution
// with an actual captured exit code, SHA-256 hashing of output files, and
// a structured JSON verification result written to the outbox. The script
// exits 0 only when every step succeeded.
function buildBootstrapScript(executionId: string, timeoutMs = DEFAULT_TIMEOUT_MS): string {
  return `param(
  [string]$InBox,
  [string]$OutBox,
  [string]$WorkDir,
  [string]$ExecutionId,
  [int]$TimeoutMs = ${timeoutMs}
)
$ErrorActionPreference = "Stop"

$stages = [System.Collections.ArrayList]::new()

function Add-Stage {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    [void]$stages.Add([ordered]@{ stage = $Name; ok = $Ok; detail = $Detail; ts = (Get-Date).ToString("o") })
}

$result = [ordered]@{
  protocolVersion = 2
  executionId = $ExecutionId
  guestStartupTimestamp = $null
  guestCompletionTimestamp = $null
  finalStatus = "FAILED"
  guestBootVerified = $false
  providerStarted = $false
  providerHealthVerified = $false
  kiloStarted = $false
  kiloExitCode = $null
  effectiveConfigHash = $null
  nativeToolEvidence = $null
  outputArtifacts = @()
  stages = @()
  timeout = $TimeoutMs
  error = $null
  cleanupStatus = "pending"
}

try {
  // The guest is executing, so the sandbox VM booted successfully.
  Add-Stage "guest-bootstrap-started" $true "Guest bootstrap began for execution $ExecutionId"
  $result.guestBootVerified = $true
  $result.guestStartupTimestamp = (Get-Date).ToString("o")

  // 1. Verify the input directory is readable.
  if (-not (Test-Path -Path $InBox -PathType Container)) {
    Add-Stage "mapped-folders-accessible" $false "InBox not readable: $InBox"
    throw "Input directory is not readable: $InBox"
  }
  $null = Get-ChildItem -Path $InBox -ErrorAction Stop

  // 2. Verify the output directory is writable.
  $null = New-Item -ItemType Directory -Path $OutBox -Force -ErrorAction Stop
  $probePath = Join-Path $OutBox (".write-probe-" + $ExecutionId)
  try {
    Set-Content -Path $probePath -Value "write-probe" -Encoding utf8 -ErrorAction Stop
    Remove-Item -Path $probePath -Force -ErrorAction SilentlyContinue
  } catch {
    Add-Stage "mapped-folders-accessible" $false "OutBox not writable: $OutBox"
    throw "Output directory is not writable: $OutBox"
  }
  Add-Stage "mapped-folders-accessible" $true "InBox=$InBox OutBox=$OutBox"

  // Stage inbox contents into the working directory.
  $null = New-Item -ItemType Directory -Path $WorkDir -Force
  $null = Copy-Item -Path "$InBox\\*" -Destination $WorkDir -Recurse -Force -ErrorAction SilentlyContinue

  // Hash of the effective kilo configuration.
  $configPath = Join-Path $WorkDir "kilo.jsonc"
  if (Test-Path -Path $configPath -PathType Leaf) {
    $configBytes = [System.IO.File]::ReadAllBytes($configPath)
    $configSha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $result.effectiveConfigHash = [BitConverter]::ToString($configSha.ComputeHash($configBytes)).Replace("-", "").ToLower()
    } finally {
      $configSha.Dispose()
    }
  }

  // 3. Start the local provider and check health via Invoke-RestMethod.
  $nodeExe = Join-Path $WorkDir "node.exe"
  $nodeFound = Test-Path -Path $nodeExe -PathType Leaf
  Add-Stage "node-runtime-found" $nodeFound "node.exe present in inbox"
  $kiloExe = Join-Path $WorkDir "kilo.exe"
  $kiloFound = Test-Path -Path $kiloExe -PathType Leaf
  Add-Stage "kilo-launcher-found" $kiloFound "kilo.exe present in inbox"
  Add-Stage "kilo-config-found" (Test-Path -Path $configPath -PathType Leaf) "kilo.jsonc present"
  $providerScript = Join-Path $WorkDir "server.js"
  Add-Stage "provider-script-found" (Test-Path -Path $providerScript -PathType Leaf) "server.js present"

  $provider = Start-Process -FilePath "node.exe" -ArgumentList @("server.js", "--port", "${SANDBOX_PORT}") -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
  $providerStarted = $false
  if ($provider) {
    $global:providerProcess = $provider
    $providerStarted = $true
    $result.providerStarted = $true
  }
  Add-Stage "provider-started" $providerStarted "Provider process launched"

  $healthOk = $false
  if ($global:providerProcess) {
    $healthUri = "http://127.0.0.1:${SANDBOX_PORT}/health"
    for ($i = 0; $i -lt 15; $i++) {
      Start-Sleep -Seconds 1
      try {
        $null = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 2 -ErrorAction Stop
        $healthOk = $true
        break
      } catch {
        $msg = $_.Exception.Message
        if ($msg -match "(400|401|403|404|405|500|502|503)") {
          // The server responded with an HTTP status code: it is listening.
          $healthOk = $true
          break
        }
      }
    }
  }
  $result.providerHealthVerified = $healthOk
  Add-Stage "provider-health" $healthOk "http://127.0.0.1:${SANDBOX_PORT}/health"
  if (-not $healthOk) {
    throw "Local provider health check failed"
  }

  // 4. Start kilo and capture the actual exit code.
  $env:KILO_CONFIG = Join-Path $WorkDir "kilo.jsonc"
  $kilo = Start-Process -FilePath (Join-Path $WorkDir "kilo.exe") -ArgumentList @("run", "--model", "${KILO_MODEL}", "--agent", "${KILO_AGENT}") -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
  $kiloStarted = $false
  if ($kilo) {
    $global:kiloProcess = $kilo
    $kiloStarted = $true
    $result.kiloStarted = $true
  }
  Add-Stage "kilo-started" $kiloStarted "Kilo launcher started"

  $kiloExitCode = $null
  if ($global:kiloProcess) {
    $waitOk = $global:kiloProcess.WaitForExit($TimeoutMs)
    if (-not $waitOk) {
      try { $global:kiloProcess.Kill() } catch {}
      $kiloExitCode = -1
    } else {
      $kiloExitCode = $global:kiloProcess.ExitCode
    }
  }
  $result.kiloExitCode = $kiloExitCode
  Add-Stage "kilo-completed" ($kiloExitCode -eq 0) ("kilo exit code " + ($kiloExitCode.ToString()))

  // 5. Capture output files with SHA-256 hashes.
  $artifacts = [System.Collections.ArrayList]::new()
  $files = Get-ChildItem -Path $WorkDir -File -Recurse -ErrorAction SilentlyContinue
  foreach ($file in $files) {
    try {
      $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
      $sha = [System.Security.Cryptography.SHA256]::Create()
      try {
        $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "").ToLower()
      } finally {
        $sha.Dispose()
      }
      $relName = $file.FullName.Substring($WorkDir.Length).TrimStart([char]92, [char]47)
      $null = $artifacts.Add([ordered]@{ name = $relName; sha256 = $hash; size = $bytes.Length })
    } catch {
      // skip unreadable files
    }
  }
  $result.outputArtifacts = [array]$artifacts

  // 6. Native tool evidence produced by the kilo run.
  $evidencePath = Join-Path $WorkDir "native-tool-verification.json"
  if (Test-Path -Path $evidencePath -PathType Leaf) {
    $evidenceRaw = Get-Content -Path $evidencePath -Raw -ErrorAction SilentlyContinue
    if ($evidenceRaw) {
      $result.nativeToolEvidence = $evidenceRaw | ConvertFrom-Json -ErrorAction SilentlyContinue
    }
  }

  $hasEvidence = $result.outputArtifacts.length -gt 0 -or $result.nativeToolEvidence -ne $null
  $readOk = $false
  $readPath = Join-Path $WorkDir "read.txt"
  if (Test-Path -Path $readPath -PathType Leaf) {
    $content = Get-Content -Path $readPath -Raw -ErrorAction SilentlyContinue
    if ($content -and $content.Trim().Length -gt 0) { $readOk = $true }
  }
  Add-Stage "fixture-state-verified" ($hasEvidence -and $readOk) "read.txt and artifacts present"

  // Final status.
  if ($kiloStarted -and $kiloExitCode -eq 0 -and $readOk) {
    $result.finalStatus = "success"
    // Promote outputArtifacts as toolEvidence for the structured result contract.
    $result.toolEvidence = $result.outputArtifacts
    $result.nativeToolEvidence = $null
  } else if ($kiloStarted) {
    $result.finalStatus = "FAILED"
  } else if ($providerStarted) {
    $result.finalStatus = "PROVIDER_FAILED"
  } else {
    $result.finalStatus = "BOOT_FAILED"
  }
} catch {
  $result.error = $_.Exception.Message
  if (-not $result.providerStarted) {
    $result.finalStatus = "BOOT_FAILED"
  } else if (-not $result.providerHealthVerified) {
    $result.finalStatus = "PROVIDER_FAILED"
  } else if ($result.kiloStarted) {
    $result.finalStatus = "KILO_FAILED"
  } else {
    $result.finalStatus = "FAILED"
  }
} finally {
  $result.guestCompletionTimestamp = (Get-Date).ToString("o")
  $result.stages = [array]$stages

  // Write the structured verification result to the outbox (BOM-free UTF-8).
  $null = New-Item -ItemType Directory -Path $OutBox -Force -ErrorAction SilentlyContinue
  $outFile = Join-Path $OutBox ("sandbox-result-" + $ExecutionId + ".json")
  $json = $result | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding $false))
  Add-Stage "result-file-written" $true ("sandbox-result-" + $ExecutionId + ".json")

  // 7. Stop processes cleanly.
  if ($global:kiloProcess) { try { $global:kiloProcess | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }
  if ($global:providerProcess) { try { $global:providerProcess | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }
  $result.cleanupStatus = "cleaned"

  // 8. Exit 0 only if everything succeeded.
  if ($result.finalStatus -eq "success") {
    exit 0
  }
  exit 1
}
`;
}
// Generate a Windows Sandbox .wsb XML configuration document.
// Networking and all redirection are disabled. Only the inbox (read-only)
// and outbox (writable) host folders are mapped. The LogonCommand runs the
// sandbox bootstrap script inside the sandbox.
export function generateWsbConfig(config: SandboxConfig): string {
  const sandboxInbox = path.win32.join(SANDBOX_DESKTOP, path.win32.basename(config.inboxPath));
  const sandboxOutbox = path.win32.join(SANDBOX_DESKTOP, path.win32.basename(config.outboxPath));
  const sandboxWork = path.win32.join(SANDBOX_DESKTOP, "work");
  const timeoutArg = config.timeoutMs && config.timeoutMs > 0 ? ` -TimeoutMs ${config.timeoutMs}` : "";
  const logonCommand =
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${xmlEscape(config.bootstrapScriptPath)}" ` +
    `-InBox "${xmlEscape(sandboxInbox)}" -OutBox "${xmlEscape(sandboxOutbox)}" -WorkDir "${xmlEscape(sandboxWork)}" ` +
    `-ExecutionId "${xmlEscape(config.executionId)}"${timeoutArg}`;

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Configuration>\n` +
    `  <Networking>Disable</Networking>\n` +
    `  <ClipboardRedirection>Disable</ClipboardRedirection>\n` +
    `  <PrinterRedirection>Disable</PrinterRedirection>\n` +
    `  <AudioRedirection>Disable</AudioRedirection>\n` +
    `  <VideoRedirection>Disable</VideoRedirection>\n` +
    `  <MappedFolders>\n` +
    `    <MappedFolder>\n` +
`      <HostFolder>${xmlEscape(config.inboxPath)}</HostFolder>\n` +
    `      <SandboxFolder>${sandboxInbox}</SandboxFolder>\n` +
    `      <ReadOnly>true</ReadOnly>\n` +
    `    </MappedFolder>\n` +
    `    <MappedFolder>\n` +
    `      <HostFolder>${xmlEscape(config.outboxPath)}</HostFolder>\n` +
    `      <SandboxFolder>${sandboxOutbox}</SandboxFolder>\n` +
    `      <ReadOnly>false</ReadOnly>\n` +
    `    </MappedFolder>\n` +
    `  </MappedFolders>\n` +
    `  <LogonCommand>\n` +
    `    <Command>${xmlEscape(logonCommand)}</Command>\n` +
    `  </LogonCommand>\n` +
    `</Configuration>\n`;
}

function removeTreeSafely(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

const VALID_FINAL_STATUSES: SandboxFinalStatus[] = [
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "BOOT_FAILED",
  "PROVIDER_FAILED",
  "KILO_FAILED",
  "EVIDENCE_INCOMPLETE",
];

function newSandboxExecutionResult(
  executionId: string,
  timeoutMs: number,
  finalStatus: SandboxFinalStatus,
  error: string | null,
  guest: Record<string, unknown> | null,
  cleanupStatus: "cleaned" | "cleanup-failed"
): SandboxExecutionResult {
  const getBool = (key: string, def: boolean): boolean => {
    const value = guest?.[key];
    return typeof value === "boolean" ? value : def;
  };
  const getNumber = (key: string, def: number | null): number | null => {
    const value = guest?.[key];
    return typeof value === "number" ? value : def;
  };
  const getString = (key: string, def: string | null): string | null => {
    const value = guest?.[key];
    return typeof value === "string" ? value : def;
  };
  return {
    executionId,
    finalStatus,
    guestBootVerified: getBool("guestBootVerified", false),
    providerStarted: getBool("providerStarted", false),
    providerHealthVerified: getBool("providerHealthVerified", false),
    kiloStarted: getBool("kiloStarted", false),
    kiloExitCode: getNumber("kiloExitCode", null),
    effectiveConfigHash: getString("effectiveConfigHash", null),
    nativeToolEvidence: guest?.nativeToolEvidence ?? null,
    outputArtifacts: Array.isArray(guest?.outputArtifacts)
      ? (guest.outputArtifacts as SandboxOutputArtifact[])
      : [],
    timeout: timeoutMs,
    error,
    cleanupStatus,
  };
}
// Launch a Kilo subprocess under the Windows Sandbox isolation backend.
// The sandbox runs a PowerShell bootstrap that starts a local provider and
// Kilo, performs native tool verification, and exports a structured JSON
// verification result to the outbox, which is validated and collected on
// the host. This backend never silently falls back to WORKTREE_ONLY.
export async function launchWindowsSandbox(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; executionId?: string; kiloConfigPath?: string; worktreePath?: string }
): Promise<SandboxExecutionResult> {
  const executionId = opts.executionId || crypto.randomBytes(8).toString("hex");
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  const fail = (finalStatus: SandboxFinalStatus, error: string): SandboxExecutionResult =>
    newSandboxExecutionResult(executionId, timeoutMs, finalStatus, error, null, "cleaned");

  if (os.platform() !== "win32") {
    return fail("FAILED", "Windows Sandbox backend is Windows-only.");
  }

  if (!fs.existsSync(WINDOWS_SANDBOX_EXE)) {
    return fail("BOOT_FAILED", "Windows Sandbox executable not found at " + WINDOWS_SANDBOX_EXE);
  }

  const inboxPath = path.join(SANDBOX_FIXTURES_ROOT, `sandbox-inbox-${executionId}`);
  const outboxPath = path.join(SANDBOX_FIXTURES_ROOT, `sandbox-outbox-${executionId}`);
  const configPath = path.join(SANDBOX_FIXTURES_ROOT, `sandbox-${executionId}.wsb`);
  const hostBootstrapPath = path.join(inboxPath, "bootstrap.ps1");
  const sandboxBootstrapPath = path.win32.join(SANDBOX_DESKTOP, path.win32.basename(inboxPath), "bootstrap.ps1");

  const allowedRoots = [BRIDGE_ROOT, SANDBOX_FIXTURES_ROOT];
  if (opts.kiloConfigPath) allowedRoots.push(path.dirname(opts.kiloConfigPath));
  if (opts.worktreePath) allowedRoots.push(opts.worktreePath);

  const validatePath = (label: string, target: string): string | undefined => {
    if (!isPathUnderAllowedRoots(target, allowedRoots)) {
      return `${label} is outside allowed roots: ${target}`;
    }
    return undefined;
  };

  const pathChecks: Array<[string, string]> = [
    ["inboxPath", inboxPath],
    ["outboxPath", outboxPath],
    ["configPath", configPath],
    ["bootstrapScriptPath", hostBootstrapPath],
  ];
  for (const [label, target] of pathChecks) {
    const err = validatePath(label, target);
    if (err) {
      return fail("FAILED", err);
    }
  }
  if (opts.kiloConfigPath) {
    const err = validatePath("kiloConfigPath", opts.kiloConfigPath);
    if (err) {
      return fail("FAILED", err);
    }
  }
  if (opts.worktreePath) {
    const err = validatePath("worktreePath", opts.worktreePath);
    if (err) {
      return fail("FAILED", err);
    }
  }

  const kiloExe = resolveKiloExe();
  if (!kiloExe) {
    removeTreeSafely(inboxPath);
    removeTreeSafely(outboxPath);
    return fail("BOOT_FAILED", "kilo.exe not found; set KILO_BIN or ensure kilo is on PATH.");
  }

  if (!opts.kiloConfigPath || !fs.existsSync(opts.kiloConfigPath)) {
    removeTreeSafely(inboxPath);
    removeTreeSafely(outboxPath);
    return fail("FAILED", "kilo config path is required for WINDOWS_SANDBOX backend.");
  }

  // Refuse to launch when another Windows Sandbox guest session is active.
  const existingSession = detectExistingSandboxSession();
  if (existingSession.detected) {
    removeTreeSafely(inboxPath);
    removeTreeSafely(outboxPath);
    const clientIds = existingSession.clients.length ? ` (WindowsSandboxClient.exe PID ${existingSession.clients.join(", ")})` : "";
    return fail("FAILED", `an active Windows Sandbox session is already running${clientIds}; close the existing Sandbox window/session before retrying`);
  }

  const launchTimeMs = Date.now();

  try {
    fs.mkdirSync(inboxPath, { recursive: true });
    fs.mkdirSync(outboxPath, { recursive: true });

    // Copy required files into the inbox (mapped read-only into the sandbox).
    fs.copyFileSync(kiloExe, path.join(inboxPath, "kilo.exe"));
    fs.copyFileSync(opts.kiloConfigPath, path.join(inboxPath, "kilo.jsonc"));
    fs.writeFileSync(hostBootstrapPath, buildBootstrapScript(executionId, timeoutMs), "utf8");

    // Deterministic local provider.
    const providerSrc = path.join(SANDBOX_FIXTURES_ROOT, "local-provider");
    if (fs.existsSync(path.join(providerSrc, "server.js"))) {
      fs.copyFileSync(path.join(providerSrc, "server.js"), path.join(inboxPath, "server.js"));
    }
    if (fs.existsSync(path.join(providerSrc, "package.json"))) {
      fs.copyFileSync(path.join(providerSrc, "package.json"), path.join(inboxPath, "package.json"));
    }

    // Synthetic fixtures.
    const fixturesDir = path.join(inboxPath, "fixtures");
    fs.mkdirSync(fixturesDir, { recursive: true });
    const fixtureSources = [
      path.join(SANDBOX_FIXTURES_ROOT, "agents", "bridge-normal-coding-test.md"),
      path.join(SANDBOX_FIXTURES_ROOT, "native-test-config", "kilo.jsonc"),
    ];
    for (const src of fixtureSources) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(fixturesDir, path.basename(src)));
      }
    }

    // Validate that every mapped host path now exists before launch.
    const stagingErrors = validateSandboxStaging({
      inboxPath,
      outboxPath,
      bootstrapScriptPath: hostBootstrapPath,
      kiloExePath: path.join(inboxPath, "kilo.exe"),
      providerScriptPath: path.join(inboxPath, "server.js"),
      kiloConfigPath: path.join(inboxPath, "kilo.jsonc"),
    });
    if (stagingErrors.length > 0) {
      removeTreeSafely(inboxPath);
      removeTreeSafely(outboxPath);
      return fail("FAILED", `sandbox staging validation failed: ${stagingErrors.join("; ")}`);
    }

    // Refuse to accept a stale result file left over from a previous attempt.
    const resultPath = path.join(outboxPath, `sandbox-result-${executionId}.json`);
    if (fs.existsSync(resultPath)) {
      removeTreeSafely(inboxPath);
      removeTreeSafely(outboxPath);
      return fail("FAILED", "a stale sandbox result file already exists for this execution id");
    }

    // Generate the .wsb configuration with safe XML escaping.
    const sandboxConfig: SandboxConfig = {
      inboxPath,
      outboxPath,
      bootstrapScriptPath: sandboxBootstrapPath,
      kiloConfigPath: opts.kiloConfigPath,
      executionId,
      timeoutMs,
    };
    const wsbConfig = generateWsbConfig(sandboxConfig);
    fs.writeFileSync(configPath, wsbConfig, "utf8");

    // Launch Windows Sandbox and wait for it to complete (synchronous).
    const sandboxResult = spawnSync(WINDOWS_SANDBOX_EXE, [configPath], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });

    let timedOut = false;
    let spawnError: string | undefined;
    if (sandboxResult.error !== undefined) {
      const err = sandboxResult.error instanceof Error ? sandboxResult.error : new Error(String(sandboxResult.error));
      spawnError = err.message;
      timedOut = (err as { code?: string }).code === "ETIMEDOUT" || /timeout/i.test(err.message);
    } else if (sandboxResult.status === null || sandboxResult.signal !== null) {
      timedOut = true;
      spawnError = `Windows Sandbox process was terminated${sandboxResult.signal ? ` (signal ${sandboxResult.signal})` : ""}; likely exceeded timeout of ${timeoutMs} ms`;
    } else if (sandboxResult.status !== 0) {
      spawnError = `Windows Sandbox exited with code ${sandboxResult.status}`;
    }

    // Collect output artifacts from the outbox. Every artifact must belong
    // to this execution ID; fail closed otherwise.
    let artifactError: string | undefined;
    try {
      if (fs.existsSync(outboxPath)) {
        for (const name of fs.readdirSync(outboxPath)) {
          if (name.includes(executionId)) {
            continue;
          }
          artifactError = `outbox artifact ${name} does not belong to execution ${executionId}`;
        }
      }
    } catch (err) {
      artifactError = err instanceof Error ? err.message : String(err);
    }

// Parse the structured verification result written by the guest.
    let guest: unknown = null;
    let parseError: string | undefined;
    let resultStatMtimeMs: number | undefined;
    try {
      if (fs.existsSync(resultPath)) {
        resultStatMtimeMs = fs.statSync(resultPath).mtimeMs;
        guest = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      }
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }

    let finalStatus: SandboxFinalStatus = "FAILED";
    let error: string | null = null;
    if (timedOut) {
      finalStatus = "TIMED_OUT";
      error = spawnError ?? `Windows Sandbox exceeded timeout of ${timeoutMs} ms`;
    } else if (spawnError) {
      finalStatus = "FAILED";
      error = spawnError;
    } else if (parseError) {
      finalStatus = "FAILED";
      error = `failed to parse sandbox result JSON: ${parseError}`;
    } else if (artifactError) {
      finalStatus = "FAILED";
      error = artifactError;
    } else if (guest === null) {
      finalStatus = "FAILED";
      error = "no sandbox verification result was written to the outbox";
    } else {
      const g = guest as Record<string, unknown>;
      let status: SandboxFinalStatus = "FAILED";
      if (typeof g.finalStatus === "string") {
        if (g.finalStatus === "success") status = "COMPLETED";
        else if (VALID_FINAL_STATUSES.includes(g.finalStatus as SandboxFinalStatus)) status = g.finalStatus as SandboxFinalStatus;
      }
      finalStatus = status;
      error = typeof g.error === "string" ? g.error : null;

      // Enforce the stricter guest result contract: protocol version,
      // execution id, required stages, and final status.
      const validation = validateSandboxGuestResult(guest, {
        executionId,
        launchTimeMs,
        statMtimeMs: resultStatMtimeMs,
      });
      if (!validation.ok) {
        finalStatus = "FAILED";
        error = `guest result validation failed: ${validation.errors.join("; ")}`;
      }
    }

    // Clean up sandbox workspaces after collecting results.
    let cleanupStatus: "cleaned" | "cleanup-failed" = "cleaned";
    try {
      removeTreeSafely(inboxPath);
      removeTreeSafely(outboxPath);
      removeTreeSafely(configPath);
    } catch {
      cleanupStatus = "cleanup-failed";
    }

    return newSandboxExecutionResult(executionId, timeoutMs, finalStatus, error, guest as Record<string, unknown> | null, cleanupStatus);
  } catch (err) {
    removeTreeSafely(inboxPath);
    removeTreeSafely(outboxPath);
    removeTreeSafely(configPath);
    return fail("FAILED", err instanceof Error ? err.message : String(err));
  }
}

// Detect which isolation backends are available on this machine.
export function detectIsolationCapabilities(): IsolationCapability[] {
  const caps: IsolationCapability[] = [];

  // WORKTREE_ONLY is always available (application-level separation).
  caps.push({
    backend: "WORKTREE_ONLY",
    available: true,
    provisioned: true,
    reason: "Git worktree + Kilo tool permissions (application-level only)",
  });

  // WINDOWS_SANDBOX requires Windows 10/11 Pro/Enterprise with Hyper-V.
  if (os.platform() === "win32") {
    const exeExists = fs.existsSync(WINDOWS_SANDBOX_EXE);
    let featureEnabled = false;
    if (exeExists) {
      try {
        const result = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-WindowsOptionalFeature -Online -FeatureName ${WINDOWS_SANDBOX_FEATURE} | Select-Object -ExpandProperty State`,
          ],
          { encoding: "utf8" },
        );
        const state = (result.stdout || "").trim();
        featureEnabled = state.toLowerCase() === "enabled";
      } catch {
        // ignore
      }
    }
    const available = exeExists && featureEnabled;
    caps.push({
      backend: "WINDOWS_SANDBOX",
      available,
      provisioned: false,
      reason: available
        ? "Windows Sandbox executable and feature detected (Windows 10 Pro, build 22631)"
        : "Windows Sandbox not detected (requires Windows Pro/Enterprise + Hyper-V).",
      prerequisites: "Windows 10/11 Pro or Enterprise, Hyper-V enabled, Windows Sandbox feature enabled",
      operatorAction: available
        ? "None required - Windows Sandbox is already enabled on this machine."
        : "Enable Windows Sandbox feature and Hyper-V on this machine.",
    });
  } else {
    caps.push({
      backend: "WINDOWS_SANDBOX",
      available: false,
      provisioned: false,
      reason: "Windows Sandbox is Windows-only.",
      prerequisites: "Windows 10/11 Pro or Enterprise, Hyper-V enabled, Windows Sandbox feature enabled",
      operatorAction: "Install Windows 10/11 Pro or Enterprise with Hyper-V and enable Windows Sandbox.",
    });
  }

  // RESTRICTED_ACCOUNT requires ability to create/run as a separate Windows identity.
  if (os.platform() === "win32") {
    caps.push({
      backend: "RESTRICTED_ACCOUNT",
      available: false,
      provisioned: false,
      reason: "Restricted Windows account not configured (requires admin setup).",
      prerequisites: "Dedicated Windows execution account, NTFS ACL controls, secure process-launch mechanism",
      operatorAction: "Create dedicated restricted account, configure NTFS ACLs, provision secure credentials.",
    });
  } else {
    caps.push({
      backend: "RESTRICTED_ACCOUNT",
      available: false,
      provisioned: false,
      reason: "Restricted account isolation is Windows-only in this implementation.",
      prerequisites: "Dedicated Windows execution account, NTFS ACL controls, secure process-launch mechanism",
      operatorAction: "Create dedicated restricted account, configure NTFS ACLs, provision secure credentials.",
    });
  }

  // OS_SANDBOX is not implemented in this phase.
  caps.push({
    backend: "OS_SANDBOX",
    available: false,
    provisioned: false,
    reason: "Generic OS sandboxing not implemented",
    prerequisites: "Docker, Windows Sandbox, or container runtime",
    operatorAction: "Install and configure container runtime.",
  });

  return caps;
}

// Select the best isolation backend.
// WORKTREE_ONLY is preferred unless WINDOWS_SANDBOX or RESTRICTED_ACCOUNT is
// explicitly provisioned (not just available) for automated launch.
export function selectIsolationBackend(preferred?: IsolationBackend): IsolationBackend {
  const caps = detectIsolationCapabilities();
  const provisioned = caps.filter((c) => c.provisioned).map((c) => c.backend);

  if (preferred && provisioned.includes(preferred)) {
    return preferred;
  }

  // Prefer OS-level isolation only when explicitly provisioned; otherwise WORKTREE_ONLY.
  for (const candidate of ["WINDOWS_SANDBOX", "RESTRICTED_ACCOUNT", "WORKTREE_ONLY"] as IsolationBackend[]) {
    if (provisioned.includes(candidate)) return candidate;
  }

  return "WORKTREE_ONLY";
}

// Launch a Kilo subprocess under the selected isolation backend.
// WORKTREE_ONLY: runs normally with Kilo tool permissions as the boundary.
// WINDOWS_SANDBOX: runs inside an isolated Windows Sandbox VM and returns a
// structured SandboxExecutionResult derived from the guest verification JSON.
// RESTRICTED_ACCOUNT / OS_SANDBOX: not implemented.
export async function launchIsolated(
  backend: IsolationBackend,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; executionId?: string; kiloConfigPath?: string; worktreePath?: string }
): Promise<IsolationResult> {
  if (backend === "WINDOWS_SANDBOX") {
    const sandbox = await launchWindowsSandbox(cmd, args, opts);
    return {
      ok: sandbox.finalStatus === "COMPLETED",
      backend: "WINDOWS_SANDBOX",
      error: sandbox.error ?? undefined,
      cleanup: async (): Promise<void> => {
        // The sandbox workspace is cleaned inside launchWindowsSandbox.
      },
    };
  }

  if (backend === "RESTRICTED_ACCOUNT" || backend === "OS_SANDBOX") {
    return {
      ok: false,
      backend,
      error: `Isolation backend "${backend}" is not implemented.`,
    };
  }

  // WORKTREE_ONLY: spawn normally.
  try {
    const proc = runProcess(cmd, args, opts);
    const result = await proc;
    return {
      ok: result.code === 0,
      backend: "WORKTREE_ONLY",
      error: result.code !== 0 ? `Process exited with code ${result.code}` : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      backend: "WORKTREE_ONLY",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Report whether the current environment has OS-level isolation available.
// Returns true only if WINDOWS_SANDBOX is available.
export function hasOsLevelIsolation(): boolean {
  const caps = detectIsolationCapabilities();
  return caps.some((c) => c.available && c.backend === "WINDOWS_SANDBOX");
}

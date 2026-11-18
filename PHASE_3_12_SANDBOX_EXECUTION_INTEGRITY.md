# Phase 3.12 Sandbox Execution Integrity

## Overview
This document describes the Windows Sandbox backend implementation for Kilo Bridge Phase 3.12. The backend provides isolated, disposable execution environments for untrusted agent tool calls using Windows Sandbox (WSb), a lightweight desktop environment based on Hyper-V. The design goal is fail-closed execution: if the sandbox cannot be verified as operational, all tool calls are denied.

## Architecture
- Backend: src/components/sandbox.ts (WindowsSandboxProvider)
- Configuration: .wsb XML files generated per execution
- Bootstrap: PowerShell bootstrap script injected into the sandbox
- File exchange: mapped folders (read-only inputs, write-only outputs)
- Lifecycle: create -> launch -> monitor -> collect -> terminate -> dispose
- Fail-closed: any exception or non-zero exit denies the operation

## .wsb XML Configuration
The .wsb file is an XML manifest consumed by Windows Sandbox. Key elements:
- `<Configuration>`: root element
- `<MappedFolders>`: host-to-sandbox folder mappings with `<ReadOnly>true</ReadOnly>` for inputs
- `<LogonCommand>`: command executed on sandbox user logon (bootstrap script)
- `<MemoryInMB>`: memory allocation (default 4096 MB)
- `<VGpu>`: enable/disable GPU (disabled for headless CI)
- `<Networking>`: disable (disable networking for isolation)
- `<AudioInput>`, `<VideoInput>`, `<PrinterRedirection>`, `<ClipboardRedirection>`: disabled for attack-surface reduction

Example .wsb structure:
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>C:\TAIF\KILO-BRIDGE\sandbox\input</HostFolder>
      <SandboxFolder>C:\Users\WDAGUtilityAccount\input</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>C:\TAIF\KILO-BRIDGE\sandbox\output</HostFolder>
      <SandboxFolder>C:\Users\WDAGUtilityAccount\output</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    "C:\Users\WDAGUtilityAccount\bootstrap.ps1"
  </LogonCommand>
  <MemoryInMB>4096</MemoryInMB>
  <VGpu>Disable</VGpu>
  <Networking>Disable</Networking>
</Configuration>

## Bootstrap Script
The bootstrap script (bootstrap.ps1) runs inside the sandbox at logon:
1.  Sets execution policy to Bypass for the sandbox session
2.  Invokes the agent command with arguments read from a command file in the input folder
3.  Redirects stdout/stderr to files in the output folder
4.  Writes an exit code marker file to signal completion
5.  Exits with the agent's exit code

The bootstrap script is copied into the input folder and launched via <LogonCommand>. It does not persist beyond the sandbox session lifetime.

## Secure File Exchange
- Input folder: mapped read-only; contains command file, bootstrap script, and any read-only assets
- Output folder: mapped read-write; receives stdout.log, stderr.log, exit-code marker, and result artifacts
- No clipboard redirection, no printer redirection, no drive passthrough beyond the two mapped folders
- Networking disabled inside the sandbox to prevent exfiltration
- All paths are resolved and validated before mapping to prevent path traversal

## Lifecycle Management
1.  Validate inputs and deny-by-default policy check
2.  Generate .wsb XML and bootstrap script
3.  Copy inputs to the input staging folder
4.  Launch `WindowsSandbox.exe <config.wsb>`
5.  Poll the output folder for the exit-code marker (timeout-bound)
6.  On completion: read exit code, stdout, stderr; produce result
7.  On timeout: terminate sandbox, mark as DENIED/timed-out
8.  Clean up staging folders; dispose of the worktree association

Windows Sandbox is single-instance per desktop session; concurrent launches are serialized via the file-based worker lock.

## Fail-Closed Behavior
- If .wsb generation fails -> DENIED
- If WindowsSandbox.exe fails to launch -> DENIED
- If bootstrap script does not produce an exit-code marker within timeout -> DENIED (timed out)
- If exit code is non-zero -> DENIED (failed)
- If output folder is missing expected artifacts -> DENIED
- If any exception occurs at any stage -> DENIED, with error logged to stderr
- No partial results are ever trusted; output is only accepted when the exit-code marker confirms clean completion

## Headless Limitation
Windows Sandbox requires an interactive desktop session to boot. In headless/CI environments (no logged-on user, no GPU, no display), the sandbox launches but cannot complete the boot sequence. This means backend code is implemented but runtime execution cannot be verified in this environment. See PHASE_3_12_SANDBOX_RUNTIME_EVIDENCE.md.

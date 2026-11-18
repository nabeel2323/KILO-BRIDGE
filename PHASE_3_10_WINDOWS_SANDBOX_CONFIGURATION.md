# Phase 3.10 Windows Sandbox Configuration

## Overview

Windows Sandbox (.wsb) configuration for isolated agent execution. The .wsb file format is an XML-based configuration used by Windows Sandbox to launch a lightweight, isolated desktop environment.

## .wsb XML Format

File extension: .wsb
Root element: <Configuration>
Namespace: default (no namespace required)

Minimal .wsb structure:

<Configuration>
  <Networking>Disable</Networking>
  <Clipboard>Disable</Clipboard>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>C:\TAIF\KILO-BRIDGE\sandbox</HostFolder>
      <SandboxFolder>C:\sandbox</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>cmd.exe /c "echo sandbox ready &gt; C:\sandbox\ready.txt"</Command>
  </LogonCommand>
</Configuration>

## Networking Disabled

<Networking>Disable</Networking>

- Prevents the sandbox from accessing host or external network.
- Critical for deny-by-default security: no outbound calls from sandboxed agents.
- Verified by absence of network adapters with external connectivity inside sandbox.

## Clipboard Disabled

<Clipboard>Disable</Clipboard>

- Prevents clipboard sharing between host and sandbox.
- Blocks exfiltration of data via copy/paste.
- Ensures isolation boundary is maintained.

## Mapped Folders

Mapped folders expose specific host directories into the sandbox. Each <MappedFolder> contains:

| Element | Description |
|---------|-------------|
| HostFolder | Absolute path on the host to share |
| SandboxFolder | Absolute path inside sandbox where host folder appears |
| ReadOnly | true/false; whether sandbox can write to the folder |

Example:

<MappedFolders>
  <MappedFolder>
    <HostFolder>C:\TAIF\KILO-BRIDGE\sandbox\input</HostFolder>
    <SandboxFolder>C:\sandbox\input</SandboxFolder>
    <ReadOnly>true</ReadOnly>
  </MappedFolder>
  <MappedFolder>
    <HostFolder>C:\TAIF\KILO-BRIDGE\sandbox\output</HostFolder>
    <SandboxFolder>C:\sandbox\output</SandboxFolder>
    <ReadOnly>false</ReadOnly>
  </MappedFolder>
</MappedFolders>

- Input folder: read-only, agent reads task data but cannot modify host source.
- Output folder: read-write, agent writes results that host can collect.
- Path containment: mapped folders are the only host paths accessible inside sandbox.

## Logon Command

<LogonCommand>
  <Command>cmd.exe /c "..."</Command>
</LogonCommand>

- Executed when sandbox session starts.
- Used to initialize the sandbox environment (e.g., set PATH, launch agent wrapper).
- Output is not capturable from host without additional tooling.

Example logon command for agent execution:

<LogonCommand>
  <Command>cmd.exe /c "cd C:\sandbox\input &amp;&amp; node agent.js &gt; C:\sandbox\output\log.txt 2&gt;&amp;1"</Command>
</LogonCommand>

## Path Containment

- Sandbox processes can only access mapped folders and sandbox-internal paths.
- Host filesystem outside mapped folders is invisible to sandbox.
- No access to C:\Windows, C:\Users, or host program files unless explicitly mapped.
- Mapped folder paths must be absolute; relative paths are rejected.

## XML Escaping

Special characters in .wsb XML must be escaped:

| Character | Escape Sequence |
|-----------|-----------------|
| & | &amp; |
| < | &lt; |
| > | &gt; |
| " | &quot; |
| ' | &apos; |

Example: &gt; for > in command redirection, &amp; for & in command chaining.

Improper escaping causes .wsb parse failure and sandbox launch failure.

## Complete .wsb Example

<Configuration>
  <Networking>Disable</Networking>
  <Clipboard>Disable</Clipboard>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>C:\TAIF\KILO-BRIDGE\sandbox\input</HostFolder>
      <SandboxFolder>C:\sandbox\input</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>C:\TAIF\KILO-BRIDGE\sandbox\output</HostFolder>
      <SandboxFolder>C:\sandbox\output</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>cmd.exe /c "cd /d C:\sandbox\input &amp;&amp; node index.js &gt; C:\sandbox\output\result.log 2&gt;&amp;1"</Command>
  </LogonCommand>
</Configuration>

## Integration

- src/components/worker.ts — worker flow would launch WSB via runProcess (src/components/process.ts).
- src/components/process.ts — spawn/timeout/Windows handling for WSB process launch.
- src/security.ts — deny-by-default policy applies to sandboxed agent commands.

---
Generated: 2026-11-15T21:07:39Z
Phase: 3.10

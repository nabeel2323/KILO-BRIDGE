param([int]$TimeoutMs = 0)

$ErrorActionPreference = 'Stop'

$DEFAULT_TIMEOUT_MS = 600000
if ($TimeoutMs -gt 0) {
        $effectiveTimeoutMs = $TimeoutMs
    } else {
        $effectiveTimeoutMs = $DEFAULT_TIMEOUT_MS
    }

$root = Split-Path -Parent $PSScriptRoot

$WINDOWS_SANDBOX_EXE = "C:\Windows\System32\WindowsSandbox.exe"
$WINDOWS_SANDBOX_FEATURE = "Containers-DisposableClientVM"
$SANDBOX_PORT = 34567

$stagingRoot = Join-Path $root "scripts\phase312-staging"
$inboxHost = Join-Path $stagingRoot "inbox"
$outboxHost = Join-Path $stagingRoot "outbox"
$wsbPath = Join-Path $stagingRoot "phase312-sandbox.wsb"
$bootstrapPath = Join-Path $inboxHost "bootstrap.ps1"
$resultPath = Join-Path $outboxHost "result.json"
$diagnosticsRoot = Join-Path $root "scripts\phase312-diagnostics"
$guestBin = Join-Path $inboxHost "guest"

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host ("=== " + $Title + " ===")
}

function Write-FileUtf8NoBom {
    param([string]$Path, [string]$Content)
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Get-Sha256 {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            $bytes = $sha.ComputeHash($stream)
            $builder = New-Object System.Text.StringBuilder
            foreach ($b in $bytes) {
                [void]$builder.Append($b.ToString("x2"))
            }
            return $builder.ToString()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

function Test-InteractiveDesktop {
    if (-not [System.Environment]::UserInteractive) {
        return $false
    }
    try {
        $proc = Get-Process -Name "explorer" -ErrorAction SilentlyContinue
        return $null -ne $proc
    } catch {
        return $false
    }
}

# Detect an already-running Windows Sandbox session. Windows Sandbox permits
# only one running instance at a time. A genuine Sandbox session is identified
# by WindowsSandboxClient.exe (the guest session host). Bare vmwp.exe processes
# are Hyper-V worker processes and may belong to unrelated VMs, so they are
# reported for diagnostics but never treated as proof of a Sandbox session.
function Get-ExistingSandboxSession {
    $result = [ordered]@{
        detected = $false
        clients = @()
        launchers = @()
        vmWorkers = @()
        detail = ""
    }
    try {
        $clients = @(Get-Process -Name "WindowsSandboxClient" -ErrorAction SilentlyContinue)
        $launchers = @(Get-Process -Name "WindowsSandbox" -ErrorAction SilentlyContinue)
        $vmWorkers = @(Get-Process -Name "vmwp" -ErrorAction SilentlyContinue)
    } catch {
        return $result
    }

    foreach ($p in $clients) {
        $result.clients += [ordered]@{ name = $p.ProcessName; pid = $p.Id; startTime = $p.StartTime.ToString("o") }
    }
    foreach ($p in $launchers) {
        $result.launchers += [ordered]@{ name = $p.ProcessName; pid = $p.Id; startTime = $p.StartTime.ToString("o") }
    }
    foreach ($p in $vmWorkers) {
        $result.vmWorkers += [ordered]@{ name = $p.ProcessName; pid = $p.Id; startTime = $p.StartTime.ToString("o") }
    }

    # WindowsSandboxClient.exe is the reliable indicator of an active guest
    # session; a launcher process alone may be a stale window.
    $result.detected = ($result.clients.Count -gt 0)
    if ($result.detected) {
        $ids = ($result.clients | ForEach-Object { $_.pid }) -join ", "
        $result.detail = "An active Windows Sandbox guest session is already running (WindowsSandboxClient.exe PID: $ids)."
    } else {
        $result.detail = "No active Windows Sandbox guest session detected."
    }
    return $result
}

function Xml-Escape {
    param([string]$Value)
    return $Value -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;' -replace "'", '&apos;'
}

function Save-Diagnostics {
    param([string]$WsbPath, [string]$OutBoxHost, [string]$DiagnosticsRoot)
    if (-not (Test-Path $DiagnosticsRoot)) {
        New-Item -ItemType Directory -Path $DiagnosticsRoot -Force | Out-Null
    }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $diagDir = Join-Path $DiagnosticsRoot ("run-" + $stamp)
    New-Item -ItemType Directory -Path $diagDir -Force | Out-Null
    if (Test-Path $WsbPath) {
        Copy-Item -Path $WsbPath -Destination (Join-Path $diagDir "phase312-sandbox.wsb") -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $OutBoxHost) {
        $outboxDest = Join-Path $diagDir "outbox"
        New-Item -ItemType Directory -Path $outboxDest -Force | Out-Null
        Get-ChildItem -Path $OutBoxHost -Force | ForEach-Object {
            Copy-Item -Path $_.FullName -Destination $outboxDest -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "Diagnostics saved to $diagDir"
    return $diagDir
}

function Exit-PrereqFailure {
    param([string]$Message)
    Write-Host "PREREQUISITE FAILURE: $Message"
    try { Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot } catch {}
    exit 2
}

function Exit-Failure {
    param([string]$Message)
    Write-Host "FAILURE: $Message"
    try { Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot } catch {}
    exit 1
}

try {
    Write-Section "Prerequisite checks"

    if (-not (Test-Path $WINDOWS_SANDBOX_EXE)) {
        Exit-PrereqFailure "WindowsSandbox.exe not found at $WINDOWS_SANDBOX_EXE"
    }

    $featureEnabled = $false
    $dismOutput = $null
    try {
        $dismOutput = & dism /Online /Get-FeatureInfo /FeatureName:$WINDOWS_SANDBOX_FEATURE 2>&1
        $featureEnabled = ($dismOutput | Select-String -Pattern "State\s*:\s*Enabled" -Quiet)
    } catch {
        $featureEnabled = $false
    }
    if (-not $featureEnabled) {
        $msg = "Windows Sandbox feature '$WINDOWS_SANDBOX_FEATURE' is not enabled"
        if ($dismOutput) { $msg += "; dism: $($dismOutput -join ' ')" }
        Exit-PrereqFailure $msg
    }

if (-not (Test-InteractiveDesktop)) {
        Exit-PrereqFailure "No interactive desktop detected (UserInteractive or explorer process missing)"
    }

    Write-Section "Check for existing Sandbox instance"
    $existing = Get-ExistingSandboxSession
    if ($existing.clients.Count -gt 0) {
        Write-Host "Existing Sandbox session detected:"
        foreach ($c in $existing.clients) {
            Write-Host ("  WindowsSandboxClient.exe PID=" + $c.pid + " started=" + $c.startTime)
        }
        foreach ($l in $existing.launchers) {
            Write-Host ("  WindowsSandbox.exe PID=" + $l.pid + " started=" + $l.startTime)
        }
        if ($existing.vmWorkers.Count -gt 0) {
            Write-Host ("  (info) " + $existing.vmWorkers.Count + " unrelated vmwp.exe process(es) present")
        }
        Exit-PrereqFailure "A Windows Sandbox session is already running. Close the existing Sandbox window/session, then rerun this script."
    }
    Write-Host ("No active Sandbox session. " + $existing.detail)

    Write-Section "Prepare staging"
    if (Test-Path $stagingRoot) {
        Remove-Item -Path $stagingRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $inboxHost -Force | Out-Null
    New-Item -ItemType Directory -Path $outboxHost -Force | Out-Null
    New-Item -ItemType Directory -Path $guestBin -Force | Out-Null

    Write-Section "Stage fixtures"
    $fixtures = @{
        "read.txt"        = "read-only fixture content for phase312 sandbox integration`n"
        "write-target.txt" = "initial write-target content`n"
        "edit-target.txt"  = "original edit-target content`n"
        "glob-test.ts"     = "export const foo = 'bar';`nexport const baz = 42;`n"
        "grep-target.txt"  = "grep me: unique-phase312-token-abc123`n"
    }
    foreach ($name in $fixtures.Keys) {
        Write-FileUtf8NoBom -Path (Join-Path $inboxHost $name) -Content $fixtures[$name]
    }

    Write-Section "Resolve node.exe"
    $nodeExe = & where.exe node 2>$null
    if (-not $nodeExe) {
        Exit-PrereqFailure "node.exe not found on PATH"
    }
    $nodeExe = ($nodeExe | Select-Object -First 1).Trim()
    Copy-Item -Path $nodeExe -Destination (Join-Path $guestBin "node.exe") -Force

    Write-Section "Resolve native kilo.exe"
    $kiloRaw = & where.exe kilo 2>$null
    if (-not $kiloRaw) {
        Exit-PrereqFailure "kilo not found on PATH"
    }
    $kiloResolved = ($kiloRaw | Select-Object -First 1).Trim()
    # The kilo CLI shim lives in the global npm directory; its self-contained
    # native binary sits under node_modules\@kilocode\cli\node_modules. Use the
    # native kilo.exe so the sandbox guest does not need node_modules staged.
    $shimDir = Split-Path -Parent $kiloResolved
    $nativeCandidates = @(
        (Join-Path $shimDir "node_modules\@kilocode\cli\node_modules\@kilocode\cli-windows-x64\bin\kilo.exe"),
        (Join-Path $shimDir "node_modules\@kilocode\cli\node_modules\@kilocode\cli-windows-x64-baseline\bin\kilo.exe")
    )
    $nativeKilo = $nativeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $nativeKilo) {
        $found = Get-ChildItem -Path (Join-Path $shimDir "node_modules\@kilocode\cli") -Filter "kilo.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $nativeKilo = $found.FullName }
    }
    if (-not $nativeKilo) {
        Exit-PrereqFailure "Native kilo.exe not found under $shimDir\node_modules\@kilocode\cli"
    }
    $kiloDest = Join-Path $guestBin "kilo.exe"
    Copy-Item -Path $nativeKilo -Destination $kiloDest -Force

    Write-Section "Copy server.js"
    $serverJsSrc = Join-Path $root "test-fixtures\local-provider\server.js"
    if (-not (Test-Path $serverJsSrc)) {
        Exit-PrereqFailure "server.js not found at $serverJsSrc"
    }
    Copy-Item -Path $serverJsSrc -Destination (Join-Path $inboxHost "server.js") -Force

    Write-Section "Generate kilo.jsonc"
    $kiloJsonc = @'
{
  "$schema": "https://app.kilo.ai/config.json",
  "provider": {
    "local-test": {
      "name": "local-test",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:34567/v1"
      },
      "models": {
        "local-model": {
          "name": "local-model",
          "tool_call": true,
          "limit": {
            "context": 32768,
            "output": 4096
          }
        }
      }
    }
  },
  "permission": {
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "edit": "allow",
    "write": "allow",
    "bash": "deny",
    "lsp": "deny",
    "todoread": "deny",
    "todowrite": "deny"
  },
  "disabled_providers": []
}
'@
    Write-FileUtf8NoBom -Path (Join-Path $inboxHost "kilo.jsonc") -Content $kiloJsonc

Write-Section "Generate bootstrap.ps1"
    $bootstrapContent = @'
param([string]$InBox,[string]$OutBox)
$ErrorActionPreference = 'Stop'

$stages = [System.Collections.ArrayList]::new()
$executionId = [guid]::NewGuid().ToString("N")
$workDir = Join-Path $OutBox "work"
$resultPath = Join-Path $OutBox "result.json"
$stageLog = Join-Path $OutBox "guest-stages.json"

function Add-Stage {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    [void]$stages.Add([ordered]@{ stage = $Name; ok = $Ok; detail = $Detail; ts = (Get-Date).ToString("o") })
    # Flush after every stage so a hard crash still leaves evidence.
    try {
        if (Test-Path $OutBox) {
            [System.IO.File]::WriteAllText($stageLog, ($stages | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding $false))
        }
    } catch {}
}

function Write-Result {
    param([string]$FinalStatus, $Extra = @{})
    $toolEvidence = @()
    if ($stages.Count -gt 0) {
        $toolEvidence += @{ tool = "guest-stages"; success = ($FinalStatus -eq "success"); detail = ($stages | ConvertTo-Json -Depth 6) }
    }
    $outputArtifacts = @()
    if (Test-Path $workDir) {
        Get-ChildItem -Path $workDir -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($workDir.Length).TrimStart("\")
            if ($rel -like "*.log" -or $rel -like "*.err" -or $rel -like "*.out") { return }
            $hash = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash
            $outputArtifacts += @{ path = ("C:\outbox\work\" + $rel); hash = $hash }
        }
    }
    $result = [ordered]@{
        protocolVersion = 2
        executionId = $executionId
        guestStartupTimestamp = (Get-Date).ToString("o")
        guestCompletionTimestamp = $null
        stages = @($stages)
        providerStarted = ($stages | Where-Object { $_.stage -eq "provider-health" -and $_.ok } | Measure-Object).Count -gt 0
        providerHealthVerified = ($stages | Where-Object { $_.stage -eq "provider-health" -and $_.ok } | Measure-Object).Count -gt 0
        kiloStarted = ($stages | Where-Object { $_.stage -eq "kilo-started" -and $_.ok } | Measure-Object).Count -gt 0
        kiloExitCode = $null
        toolEvidence = $toolEvidence
        outputArtifacts = $outputArtifacts
        error = $null
        finalStatus = $FinalStatus
    }
    foreach ($k in $Extra.Keys) { $result[$k] = $Extra[$k] }
    if ($null -eq $result.guestCompletionTimestamp) { $result.guestCompletionTimestamp = (Get-Date).ToString("o") }
    $json = $result | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($resultPath, $json, (New-Object System.Text.UTF8Encoding $false))
}

try {
    Add-Stage "guest-bootstrap-started" $true "Guest bootstrap began for execution $executionId"

    if (-not (Test-Path $InBox)) { Add-Stage "inbox-accessible" $false "InBox not accessible: $InBox"; Write-Result "failure"; exit 2 }
    if (-not (Test-Path $OutBox)) { Add-Stage "outbox-accessible" $false "OutBox not accessible: $OutBox"; Write-Result "failure"; exit 2 }
    Add-Stage "mapped-folders-accessible" $true "InBox=$InBox OutBox=$OutBox"

    New-Item -ItemType Directory -Path $workDir -Force | Out-Null
    Copy-Item -Path (Join-Path $InBox "*") -Destination $workDir -Recurse -Force

    $nodePath = Join-Path $workDir "guest\node.exe"
    $serverPath = Join-Path $workDir "server.js"
    $configPath = Join-Path $workDir "kilo.jsonc"
    $kiloCmd = Join-Path $workDir "guest\kilo.exe"
    if (-not (Test-Path $kiloCmd)) { $kiloCmd = Join-Path $workDir "guest\kilo.cmd" }

    if (-not (Test-Path $nodePath)) { Add-Stage "node-runtime-found" $false "node.exe missing at $nodePath"; Write-Result "failure"; exit 2 }
    Add-Stage "node-runtime-found" $true "node.exe at $nodePath"
    if (-not (Test-Path $kiloCmd)) { Add-Stage "kilo-launcher-found" $false "kilo launcher missing"; Write-Result "failure"; exit 2 }
    Add-Stage "kilo-launcher-found" $true "kilo at $kiloCmd"
    if (-not (Test-Path $configPath)) { Add-Stage "kilo-config-found" $false "kilo.jsonc missing at $configPath"; Write-Result "failure"; exit 2 }
    Add-Stage "kilo-config-found" $true "kilo.jsonc at $configPath"
    if (-not (Test-Path $serverPath)) { Add-Stage "provider-script-found" $false "server.js missing at $serverPath"; Write-Result "failure"; exit 2 }
    Add-Stage "provider-script-found" $true "server.js at $serverPath"

    $providerStarted = $false
    $providerHealthVerified = $false
    $serverLog = Join-Path $workDir "server.log"
    $serverErrLog = Join-Path $workDir "server-err.log"
    try {
        $process = Start-Process -FilePath $nodePath -ArgumentList @("$serverPath","--port","34567") -WorkingDirectory $workDir -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrLog -ErrorAction Stop
        $providerStarted = $true
    } catch {
        $providerStarted = $false
    }
    Add-Stage "provider-started" $providerStarted "Provider process launched"

    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:34567/health" -TimeoutSec 2 -ErrorAction Stop | Out-Null
            $providerHealthVerified = $true
            break
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    Add-Stage "provider-health" $providerHealthVerified "http://127.0.0.1:34567/health"
    if (-not $providerHealthVerified) {
        Write-Result "failure"
        exit 3
    }

    $env:KILO_CONFIG = $configPath
    $kiloStarted = $false
    $kiloExitCode = $null
    $errorText = $null
    try {
        Add-Stage "kilo-started" $true "Launching kilo run"
        $kiloStarted = $true
        $kiloOutFile = Join-Path $workDir "kilo.out"
        $kiloErrFile = Join-Path $workDir "kilo.err"
        $kiloArgs = @("run","--model","local-test/local-model","--agent","native-normal-coding-test","--auto","--pure","--format","json","--dir",$workDir,"--title","bridge-local-integration","Read the file read.txt using the read tool and report its contents.")
        $kiloProc = Start-Process -FilePath $kiloCmd -ArgumentList $kiloArgs -WorkingDirectory $workDir -Wait -NoNewWindow -RedirectStandardOutput $kiloOutFile -RedirectStandardError $kiloErrFile -PassThru -ErrorAction Stop
        $kiloExitCode = $kiloProc.ExitCode
    } catch {
        $kiloExitCode = $null
        $errorText = $_.Exception.Message
    }
    if ($null -eq $kiloExitCode) {
        $kiloExitCodeText = "null"
    } else {
        $kiloExitCodeText = $kiloExitCode.ToString()
    }
    Add-Stage "kilo-completed" ($kiloExitCode -eq 0) ("kilo exit code " + $kiloExitCodeText)

    $readOk = $false
    $readPath = Join-Path $workDir "read.txt"
    if (Test-Path $readPath) {
        $content = Get-Content -Path $readPath -Raw -ErrorAction SilentlyContinue
        if ($content -and $content.Trim().Length -gt 0) { $readOk = $true }
    }
    Add-Stage "fixture-state-verified" $readOk "read.txt present and non-empty"

    Add-Stage "result-file-written" $true $resultPath
    if ($kiloExitCode -eq 0 -and $readOk) {
        $finalStatus = "success"
    } else {
        $finalStatus = "failure"
    }
    Write-Result $finalStatus @{ kiloExitCode = $kiloExitCode; error = $errorText }
    if ($kiloExitCode -eq 0 -and $readOk) { exit 0 } else { exit 1 }
} catch {
    try {
        Add-Stage "guest-fatal-error" $false $_.Exception.Message
    } catch {}
    try { Write-Result "failure" } catch {}
    exit 1
}
'@
    Write-FileUtf8NoBom -Path $bootstrapPath -Content $bootstrapContent

    Write-Section "Validate mapped host paths before launch"
    $requiredPaths = @(
        @{ label = "inboxHost"; path = $inboxHost },
        @{ label = "outboxHost"; path = $outboxHost },
        @{ label = "bootstrap.ps1"; path = $bootstrapPath },
        @{ label = "node.exe"; path = (Join-Path $guestBin "node.exe") },
        @{ label = "kilo launcher"; path = (Join-Path $guestBin "kilo.exe") },
        @{ label = "server.js"; path = (Join-Path $inboxHost "server.js") },
        @{ label = "kilo.jsonc"; path = (Join-Path $inboxHost "kilo.jsonc") }
    )
    foreach ($p in $requiredPaths) {
        if (-not (Test-Path $p.path)) {
            Exit-PrereqFailure ("Required staged file/directory missing: " + $p.label + " at " + $p.path)
        }
    }
    Write-Host "All mapped host paths verified."

    Write-Section "Generate .wsb"
    $escInbox = Xml-Escape $inboxHost
    $escOutbox = Xml-Escape $outboxHost
    $escLogon = Xml-Escape "powershell.exe -ExecutionPolicy Bypass -File C:\inbox\bootstrap.ps1 -InBox C:\inbox -OutBox C:\outbox"
    $wsbContent = @"
<?xml version="1.0" encoding="UTF-8"?>
<Configuration>
  <Networking>Disable</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$escInbox</HostFolder>
      <SandboxFolder>C:\inbox</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$escOutbox</HostFolder>
      <SandboxFolder>C:\outbox</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>$escLogon</Command>
  </LogonCommand>
</Configuration>
"@
    Write-FileUtf8NoBom -Path $wsbPath -Content $wsbContent

    Write-Section "Launch Windows Sandbox"
    $sandboxProc = Start-Process -FilePath $WINDOWS_SANDBOX_EXE -ArgumentList @($wsbPath) -PassThru
    Write-Host ("Sandbox started (PID " + $sandboxProc.Id + ")")

    Write-Section "Poll for result"
    $deadline = (Get-Date).AddMilliseconds($effectiveTimeoutMs)
    $resultReceived = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $resultPath) {
            $resultReceived = $true
            break
        }
        if ($sandboxProc.HasExited) {
            Exit-Failure "Sandbox process exited (exit code $($sandboxProc.ExitCode)) before producing result"
        }
        Start-Sleep -Seconds 2
    }
    if (-not $resultReceived) {
        if ($sandboxProc.HasExited) {
            Exit-Failure "Sandbox process exited before producing result"
        } else {
            try { $sandboxProc.Kill() } catch {}
            Exit-Failure "Timed out waiting for result after $effectiveTimeoutMs ms"
        }
    }

Write-Section "Validate result"
    $resultRaw = Get-Content -Path $resultPath -Raw -Encoding UTF8
    $result = $resultRaw | ConvertFrom-Json

    # Protocol version must be supported.
    if (-not ($result.protocolVersion -eq 2)) {
        Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot
        Exit-Failure "Unsupported protocolVersion: $($result.protocolVersion)"
    }

    # executionId must be a valid GUID.
    $guid = [Guid]::Empty
    $guidOk = $false
    try { $guidOk = [guid]::TryParse($result.executionId, [ref]$guid) } catch { $guidOk = $false }
    if (-not $guidOk) {
        Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot
        Exit-Failure "Invalid executionId: $($result.executionId)"
    }

    # Stages must be present and non-empty.
    if (-not $result.stages -or $result.stages.Count -eq 0) {
        Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot
        Exit-Failure "No guest stages present in result"
    }

    # Required stage markers must exist (even if some failed, they must be recorded).
    $requiredStages = @("guest-bootstrap-started", "mapped-folders-accessible", "node-runtime-found", "kilo-launcher-found", "kilo-config-found", "provider-script-found", "provider-started", "provider-health", "kilo-started", "kilo-completed", "result-file-written")
    foreach ($rs in $requiredStages) {
        $found = $false
        foreach ($s in $result.stages) {
            if ($s.stage -eq $rs) { $found = $true; break }
        }
        if (-not $found) {
            Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot
            Exit-Failure "Missing required guest stage: $rs"
        }
    }

    # Guest startup must have genuinely occurred (guest-bootstrap-started succeeded).
    $bootOk = $false
    foreach ($s in $result.stages) {
        if ($s.stage -eq "guest-bootstrap-started" -and $s.ok -eq $true) { $bootOk = $true; break }
    }
    if (-not $bootOk) {
        Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot
        Exit-Failure "Guest bootstrap did not successfully start"
    }

    # finalStatus must be success.
    if ($result.finalStatus -ne "success") {
        Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot
        Exit-Failure "Guest finalStatus is not success: $($result.finalStatus)"
    }

    if (-not $result.toolEvidence -or $result.toolEvidence.Count -eq 0) {
        Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot
        Exit-Failure "No toolEvidence present"
    }

    $prefix = "C:\outbox\"
    foreach ($artifact in $result.outputArtifacts) {
        $artifactPath = $artifact.path
        if (-not ($artifactPath -like "$prefix*")) {
            Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot
            Exit-Failure "Output artifact path outside C:\outbox: $artifactPath"
        }
        $rel = $artifactPath.Substring($prefix.Length)
        $hostPath = Join-Path $outboxHost $rel
        if (-not (Test-Path $hostPath)) {
            Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot
            Exit-Failure "Output artifact missing on host: $hostPath"
        }
        $actualHash = Get-Sha256 -Path $hostPath
        if ($actualHash -ne $artifact.hash) {
            Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot
            Exit-Failure "SHA-256 mismatch for $artifactPath (expected $($artifact.hash), actual $actualHash)"
        }
    }

    Write-Host "PHASE312 INTEGRATION SUCCESS"
    exit 0
} catch {
    Write-Host ("UNHANDLED ERROR: " + $_.Exception.Message)
    try { Save-Diagnostics -WsbPath $wsbPath -OutBoxHost $outboxHost -DiagnosticsRoot $diagnosticsRoot } catch {}
    exit 1
}


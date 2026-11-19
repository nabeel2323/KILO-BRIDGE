# Windows Configuration Guide

## Bridge root

The Bridge lives in C:\TAIF\KILO-BRIDGE. Relocate it by setting KILO_BRIDGE_ROOT before running any command:

    $env:KILO_BRIDGE_ROOT = "D:\kilo-bridge"
    node dist/cli.js init

## Configuration file

bridge.config.json is created by init. Its current relevant settings and defaults are:

| Setting | Default | Purpose |
|---|---|---|
| pollIntervalMs | 30000 | Background poll interval |
| defaultTaskTimeoutMs | 21600000 | Default task timeout |
| ghEnabled | false | GitHub integration prerequisite |
| kiloEnabled | false | Kilo integration prerequisite |
| workerEnabled | false | Existing generic worker gate |
| githubIntakeEnabled | false | Dedicated GitHub intake gate |
| githubIntakeAllowedRepositories | [] | Exact owner/repo allowlist; empty trusts no repository |
| sandboxExecutionEnabled | false | Generalized Windows Sandbox execution gate |
| sandboxKiloExePath | empty | Standalone kilo.exe path; KILO_SANDBOX_EXE is an environment fallback |
| sandboxProviderBaseUrl | empty | HTTPS or loopback HTTP OpenAI-compatible provider base URL |
| sandboxProviderApiKeyEnv | empty | Environment variable name holding the optional provider key |
| sandboxProviderModelId | empty | Upstream provider model identifier |
| sandboxProviderApiKeyHeader | Authorization | Upstream API-key header |
| sandboxProviderApiKeyPrefix | Bearer + space | API-key prefix |

Configuration updates use a cross-process lock and atomic file replacement. Do not edit bridge.config.json while Bridge services are active unless following a documented recovery procedure.

## Environment variables

| Variable | Purpose |
|---|---|
| KILO_BRIDGE_ROOT | Override the Bridge root directory |
| GH_BIN or KILO_GH_BIN | Full path to gh.exe if not on PATH |
| KILO_BIN | Existing Kilo CLI shim used by generic/manual execution |
| KILO_SANDBOX_EXE | Fallback path to standalone kilo.exe for Sandbox guests |
| Provider-specific variable | Secret value for the upstream provider, named by sandboxProviderApiKeyEnv |

The provider API key itself is not stored in bridge.config.json and is not copied into the guest. The Control Center stores only the environment-variable name and shows whether the variable is present. Set the secret through the Windows environment management mechanism used by the Bridge process; do not paste it into the browser UI, shell history, task Issue, or repository. Restart the Bridge process after changing the environment.

## Prepare the dedicated Sandbox runtime

Use the authenticated loopback Control Center Settings page to prepare:

- An absolute path to a standalone kilo.exe. The runner rejects .cmd shims, missing files, non-regular files, and symbolic links.
- An OpenAI-compatible provider base URL. HTTPS is required except HTTP on 127.0.0.1/localhost. URL credentials, query parameters, and fragments are rejected.
- An upstream model ID.
- The provider-key environment-variable name, optional header, and prefix.
- The GitHub/Kilo prerequisites and exact owner/repo allowlist.

When the executable field is blank, the current custom value is preserved. Use the clear-path checkbox to remove it and fall back to KILO_SANDBOX_EXE.

## Execution gates

workerEnabled, sandboxExecutionEnabled, and githubIntakeEnabled are three independent controls. All default false. The dispatcher sets generic workerEnabled=false even when a claim-bound Sandbox task is dispatched.

The Control Center can configure prerequisites and can disable execution gates. It currently rejects attempts to enable any execution gate until a real guest verification/attestation action exists and succeeds. Keep the gates false and do not change bridge.config.json manually to bypass this release control.

See Windows Sandbox Task Execution for mapped-folder details and the current runtime acceptance gap.

## PATH notes

- If GitHub CLI PATH changes after install, open a new terminal or set the executable path.
- Kilo and pnpm commonly use npm command shims; the generalized Sandbox runner specifically requires a standalone kilo.exe.
- Windows Sandbox requires the optional Containers-DisposableClientVM feature and an interactive desktop.

## Long paths

Worktree paths can get deep. If Windows path-length limits are reached, enable long paths using your organization's approved Windows policy and Git configuration.

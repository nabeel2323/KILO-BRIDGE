"use strict";

import fs from "node:fs";
import path from "node:path";
import { KiloBridgeApp } from "./app";
import { Worker } from "./components/worker";
import { GitHubProvider } from "./components/github";
import { BridgeConfigSchema, ensureBridgeConfig, updateBridgeConfig } from "./config";
import type { WorkerState, ProjectConfig, DoctorCheck } from "./types";
import { LocalKiloIntegration, type Scenario } from "./components/localKiloIntegration";
import type { SecurityProfileName } from "./components/security";
import { ControlCenterServer, createControlCenterSetupToken } from "./components/controlCenter";

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function print(text: string): void {
  process.stdout.write(text + "\n");
}

function err(text: string): void {
  process.stderr.write(text + "\n");
}

function printHelp(): void {
  print("Kilo Bridge V1.0 - Universal AI Development Coordinator");
  print("");
  print("Usage: kilo-bridge <command> [args] [--json]");
  print("");
  print("Commands:");
  print("  init                           Initialize Bridge (db, dirs, config)");
  print("  doctor                         Verify environment and tools");
  print("  configure set <key> <value>    Persist a bridge config key");
  print("  start                          Start the worker (mock mode)");
  print("  stop                           Stop the worker");
  print("  status                         List projects and state");
  print("  projects list                  List registered projects");
  print("  projects add <json>            Register a project");
  print("  projects validate <json>       Validate a project config");
  print("  projects enable <id>           Enable a project");
  print("  projects disable <id>          Disable a project");
  print("  projects inspect <id>          Inspect a project");
  print("  projects template <type>       Print a project config template");
  print("  github bootstrap <project>     Auth check + initialize labels");
  print("  github test <project>          Test GitHub authentication");
  print("  control-center setup           Generate one-time local browser setup token");
  print("  control-center start [port]    Start authenticated loopback Control Center");
  print("  tasks [project] [status]       List tasks");
  print("  task <id>                      Show a task");
  print("  task execute --project <id> --issue <number> --confirm-issue <number>");
  print("                                    Execute a specific GitHub issue (manual, one-shot)");
  print("  logs <id>                      Show task logs/verifications");
  print("  reports <id>                   Show task reports");
  print("  worker start [--dry-run] [--project <id>]  Run one worker poll");
  print("  integration local-kilo  Run local Kilo integration (scenario: read|write|edit|search)");
  print("  integration local-kilo [--scenario read|write|edit|search] [--profile smoke|integration-test|normal-coding] [--worktree <path>]");
  print("  worker stop                    Stop the worker");
  print("  verify --project <id>          Run independent verification");
  print("");
}

async function main(argv: string[]): Promise<number> {
  const app = new KiloBridgeApp();
  const bridgeRoot = process.env.KILO_BRIDGE_ROOT ?? "C:\\TAIF\\KILO-BRIDGE";
  const wantJson = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");

  // Handle --help / -h at root level only (when it's the command, not a subcommand arg).
  if (args[2] === "--help" || args[2] === "-h") {
    printHelp();
    return 0;
  }

  const cmd = args[2] ?? "help";
  const sub = args[3] ?? null;
  const rest = args.slice(4);

  try {
    switch (cmd) {
      case "help":
        printHelp();
        return 0;

      case "init": {
        const res = await app.init(bridgeRoot);
        if (!res.ok) { err(`init failed: ${res.error}`); return 1; }
        if (wantJson) printJson({ ok: true, bridgeRoot });
        else { print("Kilo Bridge initialized."); print(`Bridge root: ${bridgeRoot}`); print("Run 'kilo-bridge doctor' to verify the environment."); }
        return 0;
      }

      case "doctor": {
        await app.init(bridgeRoot);
        const res = await app.doctor({ json: wantJson });
        if (!res.ok) { err(`doctor failed: ${res.error}`); return 1; }
        const data = res.data as { checks: DoctorCheck[]; allOk: boolean; manualExecutionReady: boolean };
        if (wantJson) printJson(data);
        else {
          print("Kilo Bridge doctor:");
          let hasFail = false;
          let hasWarn = false;
          for (const c of data.checks) {
            const icon = c.status === "PASS" ? "[OK] " : c.status === "WARNING" ? "[WARN] " : "[FAIL] ";
            print(`  ${icon}${c.name}: ${c.condition}`);
            print(`    explanation: ${c.explanation}`);
            print(`    remediation: ${c.remediation}`);
            if (c.status === "FAIL") hasFail = true;
            if (c.status === "WARNING") hasWarn = true;
          }
          if (hasFail) { err("Some checks failed."); return 1; }
        if (data.manualExecutionReady) {
          print("Manual execution ready: yes");
        } else {
          print("Manual execution ready: no");
        }
        if (hasWarn) {
          print("Some warnings remain - review warnings above.");
        } else {
          print("All checks passed.");
        }
        }
        return 0;
      }

      case "configure": {
        await app.init(bridgeRoot);
        if (sub === "set") {
          const key = rest[0];
          const value = rest[1];
          if (!key || value === undefined) { err("usage: kilo-bridge configure set <key> <value>"); return 1; }
          const allowed = [
            "pollIntervalMs", "defaultTaskTimeoutMs", "ghEnabled", "kiloEnabled",
            "workerEnabled", "githubIntakeEnabled", "githubIntakeAllowedRepositories", "ghBin",
          ];
          if (!allowed.includes(key)) { err(`configure set failed: unknown key ${key}`); return 1; }
          const numKeys = ["pollIntervalMs", "defaultTaskTimeoutMs"];
          const boolKeys = ["ghEnabled", "kiloEnabled", "workerEnabled", "githubIntakeEnabled"];
          if (key === "ghBin") {
            if (!path.isAbsolute(value)) { err(`configure set failed: ghBin must be an absolute path, got: ${value}`); return 1; }
            if (!fs.existsSync(value)) { err(`configure set failed: ghBin executable not found: ${value}`); return 1; }
          }
          if (boolKeys.includes(key) && value !== "true" && value !== "false") {
            err(`configure set failed: ${key} must be true or false`);
            return 1;
          }
          let parsedValue: unknown;
          if (key === "githubIntakeAllowedRepositories") {
            try { parsedValue = JSON.parse(value); } catch {
              err("configure set failed: githubIntakeAllowedRepositories must be a JSON array of owner/repo strings");
              return 1;
            }
            if (!Array.isArray(parsedValue) || !parsedValue.every((entry) => typeof entry === "string")) {
              err("configure set failed: githubIntakeAllowedRepositories must be a JSON array of owner/repo strings");
              return 1;
            }
          } else {
            parsedValue = numKeys.includes(key) ? Number(value) : boolKeys.includes(key) ? value === "true" : value;
          }
          let validated: ReturnType<typeof BridgeConfigSchema.parse>;
          try {
            validated = updateBridgeConfig(bridgeRoot, (current) => ({ ...current, [key]: parsedValue }));
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            err(`configure set failed: ${detail}`);
            return 1;
          }
          if (wantJson) printJson({ ok: true, [key]: (validated as any)[key] });
          else print(`set ${key} = ${JSON.stringify((validated as any)[key])}`);
          return 0;
        }
        print("Configuration is stored in bridge.config.json under the Bridge directory.");
        return 0;
      }

      case "start": {
        await app.init(bridgeRoot);
        const res = await app.workerStartContinuous();
        if (!res.ok) { err(`start failed: ${res.error}`); return 1; }
        const data = res.data as { pid: number; projectId?: string };
        if (wantJson) printJson(data);
        else print(`Worker started (pid=${data.pid}, project=${data.projectId ?? "all"}).`);
        return 0;
      }

      case "stop": {
        await app.init(bridgeRoot);
        const res = await app.workerStop();
        if (!res.ok) { err(`stop failed: ${res.error}`); return 1; }
        print("Worker stop requested.");
        return 0;
      }

      case "status": {
        await app.init(bridgeRoot);
        const [projRes, stateRes] = await Promise.all([app.projectsList(), app.workerStatus()]);
        if (!projRes.ok) { err(`status failed: ${projRes.error}`); return 1; }
        if (!stateRes.ok) { err(`status failed: ${stateRes.error}`); return 1; }
        const data = projRes.data as Array<{ id: string; name: string; repository: string; state: string; localPath: string }>;
        const state = stateRes.data as WorkerState;
        const out = { worker: { running: state.running, pid: state.pid, workerId: state.workerId, heartbeat: state.heartbeat }, projects: data };
        if (wantJson) printJson(out);
        else {
          print(`Worker: ${state.running ? "RUNNING" : "STOPPED"} (pid=${state.pid ?? "n/a"}, workerId=${state.workerId ?? "n/a"}, heartbeat=${state.heartbeat ?? "n/a"})`);
          print("Projects:");
          for (const p of data) print(`  ${p.state === "active" ? "[active] " : "[disabled] "}${p.id} (${p.repository}) @ ${p.localPath}`);
          print(`Total: ${data.length}`);
        }
        return 0;
      }

      case "projects": {
        await app.init(bridgeRoot);
        if (sub === "list") {
          const res = app.projectsList();
          if (!res.ok) { err(res.error ?? "list failed"); return 1; }
          if (wantJson) printJson(res.data);
          else { for (const p of res.data as any[]) print(`${p.state === "active" ? "[active] " : "[disabled] "}${p.id} (${p.repository})`); }
          return 0;
        }
        if (sub === "add") {
          let input = rest[0];
          if (!input) { err("usage: kilo-bridge projects add <json-file|json>"); return 1; }
          let parsed: any;
          if (fs.existsSync(input)) {
            try { parsed = JSON.parse(fs.readFileSync(input, "utf8")); }
            catch (e) { err(`invalid JSON input: ${e}`); return 1; }
          } else {
            const raw = rest.join(" ");
            try { parsed = JSON.parse(raw); }
            catch (e) { err(`invalid JSON input: ${e}`); return 1; }
          }
          const res = app.projectsAdd(parsed);
          if (!res.ok) { err(`add failed: ${res.error}`); return 1; }
          if (wantJson) printJson(res.data);
          else print(`project added: ${res.data!.id}`);
          return 0;
        }
        if (sub === "validate") {
          let input = rest[0];
          if (!input) { err("usage: kilo-bridge projects validate <json-file|json>"); return 1; }
          if (input === "--help" || input === "-h") {
            print("Usage: kilo-bridge projects validate <json-file|json>");
            print("");
            print("Validate a project configuration JSON.");
            print("");
            print("Arguments:");
            print("  <json-file|json>  Path to a JSON file containing the project config,");
            print("                    or the JSON string itself.");
            print("");
            print("Examples:");
            print('  kilo-bridge projects validate ./my-project.json');
            print('  kilo-bridge projects validate \'{"id":"my-project","name":"My Project"}\'');
            return 0;
          }
          let parsed: any;
          if (fs.existsSync(input)) {
            try { parsed = JSON.parse(fs.readFileSync(input, "utf8")); }
            catch (e) { err(`invalid JSON input: ${e}`); return 1; }
          } else {
            const raw = rest.join(" ");
            try { parsed = JSON.parse(raw); }
            catch (e) { err(`invalid JSON input: ${e}`); return 1; }
          }
          const res = app.projectsValidate(parsed);
          if (!res.ok) { err(`validate failed: ${res.error}`); return 1; }
          if (wantJson) printJson(res.data);
          else print(`project config valid: ${res.data!.id}`);
          return 0;
        }
        if (sub === "enable") {
          const id = rest[0];
          if (!id) { err("usage: kilo-bridge projects enable <id>"); return 1; }
          const res = app.projectsEnable(id);
          if (!res.ok) { err(`enable failed: ${res.error}`); return 1; }
          print(`project ${id} enabled.`);
          return 0;
        }
        if (sub === "disable") {
          const id = rest[0];
          if (!id) { err("usage: kilo-bridge projects disable <id>"); return 1; }
          const res = app.projectsDisable(id);
          if (!res.ok) { err(`disable failed: ${res.error}`); return 1; }
          print(`project ${id} disabled.`);
          return 0;
        }
        if (sub === "inspect") {
          const id = rest[0];
          if (!id) { err("usage: kilo-bridge projects inspect <id>"); return 1; }
          const res = app.projectsInspect(id);
          if (!res.ok) { err(`inspect failed: ${res.error}`); return 1; }
          if (wantJson) printJson(res.data);
          else print(JSON.stringify(res.data, null, 2));
          return 0;
        }
        if (sub === "template") {
          const type = rest[0];
          if (!type) { err("usage: kilo-bridge projects template <type>"); return 1; }
          const res = app.projectsTemplate(type);
          if (!res.ok) { err(`template failed: ${res.error}`); return 1; }
          if (wantJson) printJson(res.data);
          else print(JSON.stringify(res.data, null, 2));
          return 0;
        }
        err("unknown projects subcommand. Use: list | add | validate | enable | disable | inspect | template");
        return 1;
      }

      case "control-center": {
        await app.init(bridgeRoot);
        if (sub === "setup") {
          try {
            const token = createControlCenterSetupToken(bridgeRoot);
            print("Control Center one-time setup token (shown once):");
            print(token);
            print("");
            print("Next: run 'kilo-bridge control-center start' and open the displayed loopback URL.");
            print("Do not share this token. It is not stored in plaintext.");
            app.store.close();
            return 0;
          } catch (error) {
            app.store.close();
            err(error instanceof Error ? error.message : String(error));
            return 1;
          }
        }
        if (sub === "start") {
          const requestedPort = rest[0] === undefined ? 4190 : Number(rest[0]);
          if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
            app.store.close();
            err("usage: kilo-bridge control-center start [port 0-65535]");
            return 1;
          }
          const controlCenter = new ControlCenterServer({
            bridgeRoot,
            store: app.store,
            registry: app.registry,
            host: "127.0.0.1",
            port: requestedPort,
            intakeStatus: () => app.githubIntakeStatus(),
            intakeStart: () => app.githubIntakeStartContinuous(),
            intakeStop: () => app.githubIntakeStop(),
            sandboxAttestation: app.sandboxRuntimeAttestation(),
          });
          const started = await controlCenter.start();
          print("Kilo Bridge Control Center is running.");
          print("URL: " + started.url);
          print("Binding: " + started.host + " (loopback only)");
          print("Press Ctrl+C in this terminal to stop the Control Center.");
          const shutdown = (): void => {
            void controlCenter.close().then(() => {
              app.store.close();
              process.exitCode = 0;
            }).catch((error) => {
              err("Control Center shutdown error: " + String(error));
              app.store.close();
              process.exitCode = 1;
            });
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
          return 0;
        }
        app.store.close();
        err("usage: kilo-bridge control-center setup | start [port]");
        return 1;
      }

      case "github": {
        await app.init(bridgeRoot);
        if (sub === "bootstrap") {
          const projectId = rest[0];
          if (!projectId) { err("usage: kilo-bridge github bootstrap <project>"); return 1; }
          const res = await app.githubBootstrap(projectId);
          if (!res.ok) { err(`bootstrap failed: ${res.error}`); return 1; }
          const data = res.data as { authenticated: boolean; user?: string; labels: any };
          print(`GitHub authenticated: ${data.authenticated}${data.user ? " as " + data.user : ""}`);
          print(`labels created: ${data.labels.data.created.length}, exists: ${data.labels.data.exists.length}`);
          return 0;
        }
        if (sub === "test") {
          const projectId = rest[0];
          if (!projectId) { err("usage: kilo-bridge github test <project>"); return 1; }
          const res = await app.githubTest(projectId);
          if (!res.ok) { err(`test failed: ${res.error}`); return 1; }
          print(`GitHub authenticated: ${res.data!.authenticated}`);
          return 0;
        }
        err("unknown github subcommand. Use: bootstrap | test");
        return 1;
      }

      case "tasks": {
        await app.init(bridgeRoot);
        const projectId = rest[0] ?? null;
        const status = rest[1] ?? null;
        const res = app.tasksList(projectId, status);
        if (!res.ok) { err(res.error ?? "tasks failed"); return 1; }
        if (wantJson) printJson(res.data);
        else { for (const t of res.data as any[]) print(`${t.status} #${t.issueNumber} ${t.title} (${t.projectId})`); }
        return 0;
      }

      case "task": {
        await app.init(bridgeRoot);
        if (sub === "execute") {
          const pIdx = args.indexOf("--project");
          const projectId = pIdx >= 0 ? args[pIdx + 1] : undefined;
          const iIdx = args.indexOf("--issue");
          const issueNumber = iIdx >= 0 ? parseInt(args[iIdx + 1], 10) : undefined;
          const cIdx = args.indexOf("--confirm-issue");
          const confirmIssue = cIdx >= 0 ? parseInt(args[cIdx + 1], 10) : undefined;
          const spIdx = args.indexOf("--security-profile");
          const securityProfile = (spIdx >= 0 ? args[spIdx + 1] : undefined) as "smoke" | "normal-coding" | undefined;
          if (!projectId || issueNumber === undefined || confirmIssue === undefined) {
            err("usage: kilo-bridge task execute --project <id> --issue <number> --confirm-issue <number> [--security-profile smoke|normal-coding]");
            return 1;
          }
          if (issueNumber !== confirmIssue) {
            err(`confirm-issue (${confirmIssue}) does not match issue (${issueNumber})`);
            return 1;
          }
          if (securityProfile && securityProfile !== "smoke" && securityProfile !== "normal-coding") {
            err(`invalid security-profile: ${securityProfile}. Use 'smoke' or 'normal-coding'.`);
            return 1;
          }
          const res = await app.taskExecute(projectId, issueNumber, { securityProfile });
          if (!res.ok) { err(`task execute failed: ${res.error}`); return 1; }
          if (wantJson) printJson(res.data);
          else print(JSON.stringify(res.data, null, 2));
          return 0;
        }
        const id = rest[0];
        if (!id) { err("usage: kilo-bridge task <id>"); return 1; }
        const res = app.taskGet(id);
        if (!res.ok) { err(res.error ?? "task failed"); return 1; }
        if (wantJson) printJson(res.data);
        else print(JSON.stringify(res.data, null, 2));
        return 0;
      }

      case "logs": {
        await app.init(bridgeRoot);
        const id = rest[0];
        if (!id) { err("usage: kilo-bridge logs <id>"); return 1; }
        const res = app.taskLogs(id);
        if (!res.ok) { err(res.error ?? "logs failed"); return 1; }
        if (wantJson) printJson(res.data);
        else print(JSON.stringify(res.data, null, 2));
        return 0;
      }

      case "reports": {
        await app.init(bridgeRoot);
        const id = rest[0];
        if (!id) { err("usage: kilo-bridge reports <id>"); return 1; }
        const res = app.taskReports(id);
        if (!res.ok) { err(res.error ?? "reports failed"); return 1; }
        if (wantJson) printJson(res.data);
        else print(JSON.stringify(res.data, null, 2));
        return 0;
      }

      case "worker": {
        await app.init(bridgeRoot);
        if (sub === "run") {
          // Internal: spawned by `start` to run continuous polling in a detached process.
          const continuous = args.includes("--continuous");
          const pIdx = args.indexOf("--project");
          const projectId = pIdx >= 0 ? args[pIdx + 1] : undefined;
          if (continuous) {
            const bridgeCfg = ensureBridgeConfig(bridgeRoot);
            if (!bridgeCfg.workerEnabled) { err("worker is disabled in bridge.config.json"); return 1; }
            const intervalMs = bridgeCfg.pollIntervalMs ?? 30_000;
            const worker = new Worker({
              store: app.store,
              registry: app.registry,
              logger: app.logger,
              bridgeRoot,
              config: {
                dataDir: path.join(bridgeRoot, "data"),
                dbPath: path.join(bridgeRoot, "data", "kilo-bridge.sqlite"),
                logsDir: path.join(bridgeRoot, "logs"),
                reportsDir: path.join(bridgeRoot, "reports"),
                worktreeRoot: "",
                pollIntervalMs: bridgeCfg.pollIntervalMs,
                defaultTaskTimeoutMs: bridgeCfg.defaultTaskTimeoutMs,
                ghEnabled: bridgeCfg.ghEnabled,
                kiloEnabled: bridgeCfg.kiloEnabled,
                workerEnabled: bridgeCfg.workerEnabled,
              },
              mode: "real",
              githubFactory: (p: ProjectConfig) => {
                const [owner, repo] = p.repository.split("/");
                return new GitHubProvider({ owner, repo });
              },
              kiloBin: process.env.KILO_BIN ?? "kilo",
              workerId: "bridge-worker",
            });
            await worker.startContinuous(intervalMs);
            return 0;
          }
          err("usage: kilo-bridge worker run --continuous [--project <id>]");
          return 1;
        }
        if (sub === "start") {
          const continuous = args.includes("--continuous");
          const once = args.includes("--once");
          const dryRun = args.includes("--dry-run");
          const pIdx = args.indexOf("--project");
          const projectId = pIdx >= 0 ? args[pIdx + 1] : undefined;
          // --dry-run without --continuous/--once runs a single dry-run poll.
          if (dryRun && !continuous && !once) {
            const res = await app.workerStart({ dryRun: true, projectId, once: true, mode: "dry-run" });
            if (!res.ok) { err(`worker failed: ${res.error}`); return 1; }
            const data = res.data as { mode: string; processed: number; results: any[] };
            if (wantJson) printJson(data);
            else { print(`Worker ${data.mode}: processed ${data.processed} project(s).`); for (const r of data.results) print(`  ${r.project}: discovered=${r.discovered} executed=${r.executed}`); }
            return 0;
          }
          if (continuous || once) {
            const res = await app.workerStart({ dryRun: dryRun, projectId, once: once || continuous, mode: dryRun ? "dry-run" : "mock" });
            if (!res.ok) { err(`worker failed: ${res.error}`); return 1; }
            const data = res.data as { mode: string; processed: number; results: any[] };
            if (wantJson) printJson(data);
            else { print(`Worker ${data.mode}: processed ${data.processed} project(s).`); for (const r of data.results) print(`  ${r.project}: discovered=${r.discovered} executed=${r.executed}`); }
            return 0;
          }
          // Default: spawn detached continuous worker.
          const res = await app.workerStartContinuous(projectId);
          if (!res.ok) { err(`worker start failed: ${res.error}`); return 1; }
          const data = res.data as { pid: number; projectId?: string };
          if (wantJson) printJson(data);
          else print(`Worker started (pid=${data.pid}, project=${data.projectId ?? "all"}).`);
          return 0;
        }
        if (sub === "stop") {
          const res = await app.workerStop();
          if (!res.ok) { err(`worker stop failed: ${res.error}`); return 1; }
          print("Worker stop requested.");
          return 0;
        }
        err("usage: kilo-bridge worker start [--continuous|--once|--dry-run] [--project <id>] [--json]");
        err("       kilo-bridge worker stop");
        err("       kilo-bridge worker run --continuous [--project <id>]");
        return 1;
      }

      case "integration": {
        await app.init(bridgeRoot);
        if (sub === "--help" || sub === "-h" || sub === null) {
          print("Usage: kilo-bridge integration local-kilo [--scenario read|write|edit|search] [--profile smoke|integration-test|normal-coding] [--worktree <path>]");
          print("");
          print("Run local Kilo integration against an isolated worktree.");
          print("");
          print("Options:");
          print("  --scenario     Integration scenario: read | write | edit | search (default: read)");
          print("  --profile      Test profile: smoke | integration-test | normal-coding (default: integration-test)");
          print("  --worktree     Path to the isolated worktree (default: synthetic worktree under bridge root)");
          return 0;
        }
        if (sub !== "local-kilo") {
          err(`unknown integration subcommand: ${sub}. Use: local-kilo`);
          return 1;
        }
        const sIdx = args.indexOf("--scenario");
        const scenario = (sIdx >= 0 ? args[sIdx + 1] : undefined) ?? "read";
        const pIdx = args.indexOf("--profile");
        const profile = (pIdx >= 0 ? args[pIdx + 1] : undefined) ?? "integration-test";
        const wIdx = args.indexOf("--worktree");
        let worktreePath = wIdx >= 0 ? args[wIdx + 1] : undefined;
        const validScenarios = ["read", "write", "edit", "search"];
        const validProfiles = ["smoke", "integration-test", "normal-coding"];
        if (!validScenarios.includes(scenario)) { err(`invalid scenario: ${scenario}. Use: ${validScenarios.join(", ")}`); return 1; }
        if (!validProfiles.includes(profile)) { err(`invalid profile: ${profile}. Use: ${validProfiles.join(", ")}`); return 1; }
        if (!worktreePath) {
          worktreePath = path.join(bridgeRoot, "worktrees", "integration-local-kilo");
        }
        if (!fs.existsSync(worktreePath)) {
          fs.mkdirSync(worktreePath, { recursive: true });
        }
        const integration = new LocalKiloIntegration({ bridgeRoot });
        const result = await integration.runProfile(worktreePath, profile as SecurityProfileName, { scenario: scenario as Scenario });
        if (wantJson) {
          printJson(result);
        } else {
          print(`executionId: ${result.executionId}`);
          print(`profile: ${result.profile}`);
          print(`scenario: ${scenario}`);
          print(`model: ${result.model}`);
          print(`providerEndpoint: ${result.providerEndpoint}`);
          print(`exitCode: ${result.exitCode}`);
          print(`finalStatus: ${result.finalStatus}`);
          print(`durationMs: ${result.durationMs}`);
          print(`toolInvocations: ${result.toolInvocations}`);
          print(`filesystemChanges: ${result.filesystemChanges}`);
          print(`stdout: ${result.stdout}`);
          print(`stderr: ${result.stderr}`);
        }
        return result.finalStatus === "COMPLETED" ? 0 : 1;
      }
      case "verify": {
        await app.init(bridgeRoot);
        const pIdx = args.indexOf("--project");
        const projectId = pIdx >= 0 ? args[pIdx + 1] : undefined;
        if (!projectId) { err("usage: kilo-bridge verify --project <id>"); return 1; }
        const res = await app.verifyProject(projectId);
        if (!res.ok) { err(`verify failed: ${res.error}`); return 1; }
        if (wantJson) printJson(res.data);
        else print(JSON.stringify(res.data, null, 2));
        return 0;
      }

      case "security": {
        await app.init(bridgeRoot);
        if (sub !== "test") { err("usage: kilo-bridge security test --profile smoke|normal-coding"); return 1; }
        const spIdx = args.indexOf("--profile");
        const profile = spIdx >= 0 ? args[spIdx + 1] : undefined;
        if (!profile) { err("usage: kilo-bridge security test --profile smoke|normal-coding"); return 1; }
        if (profile !== "smoke" && profile !== "normal-coding") { err(`invalid profile: ${profile}. Use 'smoke' or 'normal-coding'.`); return 1; }
        const res = await app.securityTest(profile);
        if (!res.ok) { err(`security test failed: ${res.error}`); return 1; }
        if (wantJson) printJson(res.data);
        else print(JSON.stringify(res.data, null, 2));
        return 0;
      }

      case "help":
        print("Kilo Bridge V1.0 - Universal AI Development Coordinator");
        print("");
        print("Usage: kilo-bridge <command> [args] [--json]");
        print("");
        print("Commands:");
        print("  init                           Initialize Bridge (db, dirs, config)");
        print("  doctor                         Verify environment and tools");
        print("  configure set <key> <value>    Persist a bridge config key");
        print("  start                          Start the worker (mock mode)");
        print("  stop                           Stop the worker");
        print("  status                         List projects and state");
        print("  projects list                  List registered projects");
        print("  projects add <json>            Register a project");
        print("  projects validate <json>       Validate a project config");
        print("  projects enable <id>           Enable a project");
        print("  projects disable <id>          Disable a project");
        print("  projects inspect <id>          Inspect a project");
        print("  projects template <type>       Print a project config template");
        print("  github bootstrap <project>     Auth check + initialize labels");
        print("  github test <project>          Test GitHub authentication");
        print("  control-center setup           Generate one-time local browser setup token");
        print("  control-center start [port]    Start authenticated loopback Control Center");
        print("  tasks [project] [status]       List tasks");
        print("  task <id>                      Show a task");
        print("  logs <id>                      Show task logs/verifications");
        print("  reports <id>                   Show task reports");
        print("  worker start [--dry-run] [--project <id>]  Run one worker poll");
        print("  verify --project <id>          Run independent verification");
        print("");
        return 0;

      default:
        err(`unknown command: ${cmd}`);
        return 1;
    }
  } catch (e) {
    err(`unexpected error: ${e}`);
    return 1;
  }
}

main(process.argv).then((code) => {
  process.exitCode = code;
  // Let the event loop drain naturally. On Windows/Node 26 a forced
  // process.exit() during child/handle teardown can trigger libuv async
  // handle assertions in test harnesses that spawn this CLI repeatedly.
});

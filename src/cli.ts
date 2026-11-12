"use strict";

import fs from "node:fs";
import path from "node:path";
import { KiloBridgeApp } from "./app";
import { ProjectRegistry } from "./components/registry";

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function print(text: string): void {
  process.stdout.write(text + "\n");
}

function err(text: string): void {
  process.stderr.write(text + "\n");
}

function readJsonInput(input: string): any {
  return fs.existsSync(input) ? JSON.parse(fs.readFileSync(input, "utf8")) : JSON.parse(input);
}

async function main(argv: string[]): Promise<number> {
  const app = new KiloBridgeApp();
  const bridgeRoot = process.env.KILO_BRIDGE_ROOT ?? "C:\\TAIF\\KILO-BRIDGE";

  const args = argv.slice(2);
  const jsonFlag = args.includes("--json");
  const positional = args.filter((a) => a !== "--json");
  const cmd = positional[0] ?? "help";
  const sub = positional[1] ?? null;
  const rest = positional.slice(2);

  const out = (human: () => void, data: unknown) => {
    if (jsonFlag) printJson(data);
    else human();
  };

  try {
    switch (cmd) {
      case "init": {
        const res = await app.init(bridgeRoot);
        if (!res.ok) { err(`init failed: ${res.error}`); return 1; }
        out(() => {
          print("Kilo Bridge initialized.");
          print(`Bridge root: ${bridgeRoot}`);
          print("Next: kilo-bridge doctor");
        }, { ok: true, bridgeRoot });
        return 0;
      }

      case "doctor": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        const res = await app.doctor();
        if (!res.ok) { err(`doctor failed: ${res.error}`); return 1; }
        const data = res.data!;
        out(() => {
          print("Kilo Bridge doctor:");
          for (const c of data.checks) print(`  ${c.ok ? "[OK]  " : "[FAIL]"} ${c.name}: ${c.detail}`);
          print(data.allOk ? "All checks passed." : "Some checks failed. Resolve them before enabling the worker.");
        }, data);
        return data.allOk ? 0 : 1;
      }

      case "configure": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        if (sub === "set") {
          const [key, value] = rest;
          if (!key || value === undefined) { err("usage: kilo-bridge configure set <key> <value>"); return 1; }
          const res = app.configureSet(key, value);
          if (!res.ok) { err(`configure failed: ${res.error}`); return 1; }
          out(() => print(`set ${key} = ${value}`), res.data);
          return 0;
        }
        const res = app.configureGet();
        if (!res.ok) { err(`configure failed: ${res.error}`); return 1; }
        out(() => {
          print(`Configuration file: ${path.join(bridgeRoot, "bridge.config.json")}`);
          printJson(res.data);
          print("Edit with: kilo-bridge configure set <key> <value>");
        }, res.data);
        return 0;
      }

      case "start": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        print("Starting Kilo Bridge worker (persistent). Press Ctrl+C to stop gracefully.");
        const res = await app.start();
        if (!res.ok) { err(`start failed: ${res.error}`); return 1; }
        print("Worker stopped.");
        return 0;
      }

      case "stop": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        const res = app.stop();
        if (!res.ok) { err(`stop failed: ${res.error}`); return 1; }
        out(() => print("Graceful shutdown requested. The worker exits after the current cycle."), { ok: true });
        return 0;
      }

      case "status": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        const worker = app.workerStatus();
        const projects = app.projectsList();
        const tasks = app.tasksList();
        if (!worker.ok || !projects.ok || !tasks.ok) { err("status failed"); return 1; }
        const counts: Record<string, number> = {};
        for (const t of tasks.data!) counts[t.status] = (counts[t.status] ?? 0) + 1;
        out(() => {
          print(`Worker: ${worker.data!.running ? `running (pid ${worker.data!.pid}, ${worker.data!.workerId})` : "not running"}`);
          print("Projects:");
          for (const p of projects.data!) print(`  [${p.state}] ${p.id} (${p.repository}) @ ${p.localPath}`);
          print(`Tasks by status: ${JSON.stringify(counts)}`);
        }, { worker: worker.data, projects: projects.data, taskCounts: counts });
        return 0;
      }

      case "projects": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        if (sub === "list") {
          const res = app.projectsList();
          if (!res.ok) { err(res.error!); return 1; }
          out(() => {
            for (const p of res.data!) print(`[${p.state}] ${p.id} — ${p.name} (${p.repository})`);
            print(`Total: ${res.data!.length}`);
          }, res.data);
          return 0;
        }
        if (sub === "add" || sub === "validate") {
          const input = rest[0];
          if (!input) { err(`usage: kilo-bridge projects ${sub} <json-file|json>`); return 1; }
          let parsed: any;
          try { parsed = readJsonInput(input); } catch (e) { err(`invalid JSON input: ${e}`); return 1; }
          const res = sub === "add" ? app.projectsAdd(parsed) : app.projectsValidate(parsed);
          if (!res.ok) { err(`${sub} failed: ${res.error}`); return 1; }
          out(() => print(sub === "add" ? `project added: ${res.data!.id}` : `project config valid: ${res.data!.id}`), res.data);
          return 0;
        }
        if (sub === "enable" || sub === "disable") {
          const id = rest[0];
          if (!id) { err(`usage: kilo-bridge projects ${sub} <id>`); return 1; }
          const res = sub === "enable" ? app.projectsEnable(id) : app.projectsDisable(id);
          if (!res.ok) { err(`${sub} failed: ${res.error}`); return 1; }
          out(() => print(`project ${id} ${sub}d.`), { ok: true, id });
          return 0;
        }
        if (sub === "inspect") {
          const id = rest[0];
          if (!id) { err("usage: kilo-bridge projects inspect <id>"); return 1; }
          const res = app.projectsInspect(id);
          if (!res.ok) { err(`inspect failed: ${res.error}`); return 1; }
          printJson(res.data);
          return 0;
        }
        if (sub === "template") {
          const type = rest[0] ?? "node";
          const tpl = ProjectRegistry.template(type);
          printJson(tpl);
          return 0;
        }
        err("unknown projects subcommand. Use: list | add | validate | enable | disable | inspect | template");
        return 1;
      }

      case "github": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        const projectId = rest[0] ?? "scs-platform";
        if (sub === "bootstrap") {
          const res = await app.githubBootstrap(projectId);
          if (!res.ok) { err(`bootstrap failed: ${res.error}`); return 1; }
          out(() => {
            print(`GitHub authenticated as ${res.data!.user ?? "unknown"}`);
            print(`labels created: ${res.data!.labels.created.length}, already present: ${res.data!.labels.exists.length}`);
          }, res.data);
          return 0;
        }
        if (sub === "test") {
          const res = await app.githubTest(projectId);
          if (!res.ok) { err(`test failed: ${res.error}`); return 1; }
          out(() => {
            print(`GitHub authenticated: ${res.data!.authenticated}${res.data!.user ? " as " + res.data!.user : ""}`);
            if (res.data!.rateLimit) print(`API rate limit: ${res.data!.rateLimit.remaining}/${res.data!.rateLimit.limit} remaining`);
          }, res.data);
          return res.data!.authenticated ? 0 : 1;
        }
        err("unknown github subcommand. Use: bootstrap | test");
        return 1;
      }

      case "tasks": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        const res = app.tasksList(rest[0], rest[1]);
        if (!res.ok) { err(res.error!); return 1; }
        out(() => {
          if (res.data!.length === 0) { print("No tasks."); return; }
          for (const t of res.data!) {
            print(`${t.id}  #${t.issueNumber}  [${t.status}]  ${t.projectId}  attempt ${t.attempt}  ${t.title}`);
          }
        }, res.data);
        return 0;
      }

      case "task": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        const id = rest[0];
        if (!id) { err("usage: kilo-bridge task <id>"); return 1; }
        const res = app.taskGet(id);
        if (!res.ok) { err(res.error!); return 1; }
        if (!res.data) { err(`task ${id} not found`); return 1; }
        out(() => {
          const t = res.data!.task;
          print(`Task ${t.id}`);
          print(`  Issue:    #${t.issueNumber} ${t.issueUrl}`);
          print(`  Project:  ${t.projectId}`);
          print(`  Status:   ${t.status} (attempt ${t.attempt})`);
          print(`  Author:   ${t.author}`);
          print(`  Branch:   ${t.featureBranch ?? "n/a"}`);
          print(`  Worktree: ${t.worktreePath ?? "n/a"}`);
          print(`  Base SHA: ${t.baseSha ?? "n/a"}`);
          print("  Transitions:");
          for (const tr of res.data!.transitions) print(`    ${tr.createdAt}  ${tr.fromStatus ?? "(new)"} -> ${tr.toStatus}  ${tr.reason ?? ""}`);
        }, res.data);
        return 0;
      }

      case "logs": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        const id = rest[0];
        if (!id) { err("usage: kilo-bridge logs <id>"); return 1; }
        const res = app.taskLogs(id);
        if (!res.ok) { err(res.error!); return 1; }
        out(() => {
          print("Executions:");
          for (const e of res.data!.executions) {
            print(`  ${e.id} attempt ${e.attempt} [${e.status}] exit ${e.exitCode ?? "n/a"} ${e.durationMs ?? 0}ms session ${e.kiloSessionId ?? "n/a"}`);
            if (e.errorMessage) print(`    error: ${e.errorMessage}`);
          }
          print("Verifications:");
          for (const v of res.data!.verifications) {
            print(`  ${v.command} ${v.args.join(" ")} → exit ${v.exitCode ?? "n/a"} ${v.passed === true ? "PASS" : v.passed === false ? "FAIL" : "n/a"}`);
          }
        }, res.data);
        return 0;
      }

      case "reports": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        const id = rest[0];
        if (!id) { err("usage: kilo-bridge reports <id>"); return 1; }
        const res = app.taskReports(id);
        if (!res.ok) { err(res.error!); return 1; }
        out(() => {
          if (res.data!.length === 0) { print("No reports."); return; }
          for (const r of res.data!) {
            print(`${r.createdAt}  [${r.status}]  ${r.reportPath}${r.issueCommentId ? `  (comment ${r.issueCommentId})` : ""}`);
          }
        }, res.data);
        return 0;
      }

      case "worker": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        if (sub !== "start") { err("usage: kilo-bridge worker start [--dry-run] [--mock] [--project <id>]"); return 1; }
        const dryRun = rest.includes("--dry-run");
        const mock = rest.includes("--mock");
        const pIdx = rest.indexOf("--project");
        const projectId = pIdx >= 0 ? rest[pIdx + 1] : undefined;
        const res = await app.workerStart({ dryRun, projectId, mock });
        if (!res.ok) { err(`worker failed: ${res.error}`); return 1; }
        out(() => {
          print(`Worker poll complete (mode: ${res.data!.mode}).`);
          for (const r of res.data!.results) {
            print(`  ${r.project}: discovered=${r.discovered} executed=${r.executed} corrections=${r.corrections} published=${r.published}${r.skipped ? ` skipped: ${r.skipped}` : ""}`);
            for (const rej of r.rejected) print(`    rejected #${rej.issue}: ${rej.reason}`);
            for (const e of r.errors) print(`    error: ${e}`);
          }
        }, res.data);
        return 0;
      }

      case "verify": {
        const init = await app.init(bridgeRoot);
        if (!init.ok) { err(`init failed: ${init.error}`); return 1; }
        const pIdx = rest.indexOf("--project");
        const projectId = pIdx >= 0 ? rest[pIdx + 1] : (sub === "--project" ? rest[0] : sub) ?? "scs-platform";
        const res = await app.verifyProject(projectId);
        if (!res.ok) { err(`verify failed: ${res.error}`); return 1; }
        out(() => {
          if (res.data!.message) { print(res.data!.message); return; }
          print(`Verification for task ${res.data!.taskId}:`);
          for (const r of res.data!.results) {
            print(`  ${r.name} → exit ${r.exitCode ?? "n/a"} ${r.passed ? "PASS" : "FAIL"}`);
          }
        }, res.data);
        return 0;
      }

      case "help":
      default:
        print("Kilo Bridge V1.0 - Universal AI Development Coordinator");
        print("");
        print("Usage: kilo-bridge <command> [args] [--json]");
        print("");
        print("Commands:");
        print("  init                           Initialize Bridge (db, dirs, config)");
        print("  doctor                         Verify environment, tools and authentication");
        print("  configure [set <key> <value>]  Show or update bridge configuration");
        print("  start                          Start the persistent worker (requires workerEnabled)");
        print("  stop                           Request graceful worker shutdown");
        print("  status                         Worker state, projects, task counts");
        print("  projects list                  List registered projects");
        print("  projects add <json-file|json>  Register a project");
        print("  projects validate <json>       Validate a project config");
        print("  projects enable <id>           Enable a project");
        print("  projects disable <id>          Disable a project");
        print("  projects inspect <id>          Show project config and security policy");
        print("  projects template <type>       Print a config template (node|laravel|django|odoo|flutter|other)");
        print("  github bootstrap [project]     Auth check + initialize Kilo labels");
        print("  github test [project]          Test GitHub authentication and rate limit");
        print("  tasks [project] [status]       List tasks");
        print("  task <id>                      Show a task and its transitions");
        print("  logs <id>                      Show executions and verification results");
        print("  reports <id>                   Show implementation reports");
        print("  worker start [--dry-run] [--mock] [--project <id>]   Run one worker poll");
        print("  verify --project <id>          Re-run independent verification");
        print("");
        print("Global flags: --json (structured output for automation)");
        return cmd === "help" ? 0 : 1;
    }
  } catch (e) {
    err(`unexpected error: ${e}`);
    return 1;
  }
}

// Set exitCode and let the event loop drain: process.exit() during pending
// pipe writes triggers a libuv assertion on Windows (UV_HANDLE_CLOSING).
main(process.argv).then((code) => {
  process.exitCode = code;
});
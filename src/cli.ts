"use strict";

import fs from "node:fs";
import { KiloBridgeApp } from "./app";

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function print(text: string): void {
  process.stdout.write(text + "\n");
}

function err(text: string): void {
  process.stderr.write(text + "\n");
}

async function main(argv: string[]): Promise<number> {
  const app = new KiloBridgeApp();
  const bridgeRoot = process.env.KILO_BRIDGE_ROOT ?? "C:\\TAIF\\KILO-BRIDGE";

  const cmd = argv[2] ?? "help";
  const sub = argv[3] ?? null;
  const rest = argv.slice(4);

  try {
    switch (cmd) {
      case "init": {
        const res = await app.init(bridgeRoot);
        if (!res.ok) { err(`init failed: ${res.error}`); return 1; }
        print("Kilo Bridge initialized.");
        print(`Bridge root: ${bridgeRoot}`);
        print("Run 'kilo-bridge doctor' to verify the environment.");
        return 0;
      }

      case "doctor": {
        await app.init(bridgeRoot);
        const res = await app.doctor();
        if (!res.ok) { err(`doctor failed: ${res.error}`); return 1; }
        const data = res.data as { checks: Array<{ name: string; ok: boolean; detail: string }> };
        print("Kilo Bridge doctor:");
        for (const c of data.checks) {
          print(`  ${c.ok ? "[OK] " : "[FAIL] "}${c.name}: ${c.detail}`);
        }
        const allOk = data.checks.every((c) => c.ok);
        if (!allOk) {
          err("Some checks failed. Install missing tools and re-run doctor.");
          return 1;
        }
        print("All checks passed.");
        return 0;
      }

      case "configure": {
        await app.init(bridgeRoot);
        print("Configuration is stored in bridge.config.json under the Bridge directory.");
        print("Edit it directly or set KILO_BRIDGE_ROOT to relocate the Bridge.");
        return 0;
      }

      case "start": {
        await app.init(bridgeRoot);
        const res = await app.workerStart({ dryRun: false });
        if (!res.ok) { err(`start failed: ${res.error}`); return 1; }
        print("Worker start completed.");
        printJson(res.data);
        return 0;
      }

      case "stop": {
        print("Worker stop: graceful shutdown requested (no persistent worker running in V1 dry-run mode).");
        return 0;
      }

      case "status": {
        await app.init(bridgeRoot);
        const res = app.projectsList();
        if (!res.ok) { err(`status failed: ${res.error}`); return 1; }
        const data = res.data as Array<{ id: string; name: string; repository: string; state: string; localPath: string }>;
        print("Projects:");
        for (const p of data) {
          print(`  ${p.state === "active" ? "[active] " : "[disabled] "}${p.id} (${p.repository}) @ ${p.localPath}`);
        }
        print(`Total: ${data.length}`);
        return 0;
      }

      case "projects": {
        await app.init(bridgeRoot);
        if (sub === "list") {
          const res = app.projectsList();
          if (!res.ok) { err(res.error ?? "list failed"); return 1; }
          const data = res.data as Array<{ id: string; name: string; repository: string; state: string; localPath: string }>;
          printJson(data);
          return 0;
        }
        if (sub === "add") {
          // Expect a JSON file path or inline JSON
          const input = rest[0];
          if (!input) { err("usage: kilo-bridge projects add <json-file|json>"); return 1; }
          let parsed: any;
          try {
            parsed = fs.existsSync(input) ? JSON.parse(fs.readFileSync(input, "utf8")) : JSON.parse(input);
          } catch (e) { err(`invalid JSON input: ${e}`); return 1; }
          const res = app.projectsAdd(parsed);
          if (!res.ok) { err(`add failed: ${res.error}`); return 1; }
          print(`project added: ${res.data!.id}`);
          return 0;
        }
        if (sub === "validate") {
          const input = rest[0];
          if (!input) { err("usage: kilo-bridge projects validate <json-file|json>"); return 1; }
          let parsed: any;
          try {
            parsed = fs.existsSync(input) ? JSON.parse(fs.readFileSync(input, "utf8")) : JSON.parse(input);
          } catch (e) { err(`invalid JSON input: ${e}`); return 1; }
          const res = app.projectsValidate(parsed);
          if (!res.ok) { err(`validate failed: ${res.error}`); return 1; }
          print(`project config valid: ${res.data!.id}`);
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
        err("unknown projects subcommand. Use: list | add | validate | disable");
        return 1;
      }

      case "github": {
        await app.init(bridgeRoot);
        if (sub === "bootstrap") {
          const projectId = rest[0] ?? "scs-platform";
          const res = await app.githubBootstrap(projectId);
          if (!res.ok) { err(`bootstrap failed: ${res.error}`); return 1; }
          const data = res.data as { authenticated: boolean; user?: string; labels: any };
          print(`GitHub authenticated: ${data.authenticated}${data.user ? " as " + data.user : ""}`);
          print(`labels created: ${data.labels.data.created.length}, exists: ${data.labels.data.exists.length}`);
          return 0;
        }
        if (sub === "test") {
          const projectId = rest[0] ?? "scs-platform";
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
        printJson(res.data);
        return 0;
      }

      case "task": {
        await app.init(bridgeRoot);
        const id = rest[0];
        if (!id) { err("usage: kilo-bridge task <id>"); return 1; }
        const res = app.taskGet(id);
        if (!res.ok) { err(res.error ?? "task failed"); return 1; }
        printJson(res.data);
        return 0;
      }

      case "logs": {
        await app.init(bridgeRoot);
        const id = rest[0];
        if (!id) { err("usage: kilo-bridge logs <id>"); return 1; }
        const res = app.taskLogs(id);
        if (!res.ok) { err(res.error ?? "logs failed"); return 1; }
        printJson(res.data);
        return 0;
      }

      case "reports": {
        await app.init(bridgeRoot);
        const id = rest[0];
        if (!id) { err("usage: kilo-bridge reports <id>"); return 1; }
        const res = app.taskReports(id);
        if (!res.ok) { err(res.error ?? "reports failed"); return 1; }
        printJson(res.data);
        return 0;
      }

      case "worker": {
        await app.init(bridgeRoot);
        if (sub !== "start") { err("usage: kilo-bridge worker start [--dry-run] [--project <id>]"); return 1; }
        const dryRun = rest.includes("--dry-run");
        const pIdx = rest.indexOf("--project");
        const projectId = pIdx >= 0 ? rest[pIdx + 1] : undefined;
        const res = await app.workerStart({ dryRun, projectId, once: true });
        if (!res.ok) { err(`worker failed: ${res.error}`); return 1; }
        printJson(res.data);
        return 0;
      }

      case "verify": {
        await app.init(bridgeRoot);
        const pIdx = rest.indexOf("--project");
        const projectId = pIdx >= 0 ? rest[pIdx + 1] : "scs-platform";
        const res = await app.verifyProject(projectId);
        if (!res.ok) { err(`verify failed: ${res.error}`); return 1; }
        printJson(res.data);
        return 0;
      }

      case "help":
      default:
        print("Kilo Bridge V1.0 - Universal AI Development Coordinator");
        print("");
        print("Usage: kilo-bridge <command> [args]");
        print("");
        print("Commands:");
        print("  init                           Initialize Bridge (db, dirs, config)");
        print("  doctor                         Verify environment and tools");
        print("  configure                      Show configuration info");
        print("  start                          Start the worker (requires worker enabled)");
        print("  stop                           Stop the worker");
        print("  status                         List projects and state");
        print("  projects list                  List registered projects");
        print("  projects add <json>            Register a project");
        print("  projects validate <json>       Validate a project config");
        print("  projects disable <id>          Disable a project");
        print("  github bootstrap <project>     Auth check + initialize labels");
        print("  github test <project>          Test GitHub authentication");
        print("  tasks [project] [status]       List tasks");
        print("  task <id>                      Show a task");
        print("  logs <id>                      Show task logs/verifications");
        print("  reports <id>                   Show task reports");
        print("  worker start [--dry-run] [--project <id>]  Run one worker poll");
        print("  verify --project <id>          Run independent verification");
        print("");
        return 0;
    }
  } catch (e) {
    err(`unexpected error: ${e}`);
    return 1;
  }
}

function fsExists(p: string): boolean {
  return fs.existsSync(p);
}

main(process.argv).then((code) => process.exit(code));

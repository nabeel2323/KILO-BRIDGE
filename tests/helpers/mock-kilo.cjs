"use strict";
// Mock Kilo CLI for tests. Fixture-driven, records every call.
// Env: MOCK_KILO_FIXTURES = fixtures JSON path, MOCK_KILO_CALLS = call log path.
const fs = require("fs");
const path = require("path");

const fixturesPath = process.env.MOCK_KILO_FIXTURES;
const callsPath = process.env.MOCK_KILO_CALLS;
const fixtures = fixturesPath && fs.existsSync(fixturesPath)
  ? JSON.parse(fs.readFileSync(fixturesPath, "utf8"))
  : {};

const argv = process.argv.slice(2);
if (callsPath) {
  fs.appendFileSync(callsPath, JSON.stringify({ argv, cwd: process.cwd() }) + "\n");
}

function out(text) { process.stdout.write(text + "\n"); }
function fail(code, stderr) { process.stderr.write(stderr + "\n"); process.exit(code); }

const cmd = argv[0];

if (cmd === "--version") {
  out(fixtures.version || "7.8.27-mock");
  process.exit(0);
}

if (cmd === "run" && argv.includes("--help")) {
  out(fixtures.help || "Options:\n  --auto\n  --format\n  --dir\n  --title\n  --model\n  --agent\n");
  process.exit(0);
}

if (cmd === "auth" && argv[1] === "list") {
  out(fixtures.auth || "2 credentials");
  process.exit(0);
}

if (cmd === "models") {
  out(fixtures.models || "kilo/mock-model\nkilo/other-model");
  process.exit(0);
}

if (cmd === "agent" && argv[1] === "list") {
  out(fixtures.agents || "build\nplan\ngeneral");
  process.exit(0);
}

if (cmd === "config" && argv[1] === "check") {
  if (fixtures.configCheckError) fail(1, fixtures.configCheckError);
  out("config ok");
  process.exit(0);
}

if (cmd === "run") {
  const run = fixtures.run || {};
  const dirIdx = argv.indexOf("--dir");
  const dir = dirIdx >= 0 ? argv[dirIdx + 1] : process.cwd();
  const message = argv[argv.length - 1];

  const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");

  emit({ type: "session.started", session_id: run.sessionId || "mock-session-1", timestamp: new Date().toISOString() });
  emit({ type: "message.part.updated", properties: { part: { type: "reasoning", text: "private chain of thought SHOULD NOT BE STORED" } } });
  if (run.createFile) {
    fs.writeFileSync(path.join(dir, run.createFile.name), run.createFile.content, "utf8");
    emit({ type: "tool.executed", properties: { tool: "write", file: run.createFile.name } });
  }
  const finalText = run.finalText || "Mock task completed.";
  emit({ type: "message.part.updated", properties: { part: { type: "text", text: finalText } } });
  emit({ type: "session.completed", session_id: run.sessionId || "mock-session-1", exitCode: run.exitCode ?? 0 });

  if (run.hangMs) {
    setTimeout(() => process.exit(run.exitCode ?? 0), run.hangMs);
    return; // stay alive; do not fall through to the unsupported-command exit
  }
  process.exit(run.exitCode ?? 0);
}

fail(1, `mock kilo: unsupported command ${argv.join(" ")}`);
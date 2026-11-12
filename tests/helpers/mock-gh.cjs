"use strict";
// Mock GitHub CLI for tests. Fixture-driven, records every call.
// Env: MOCK_GH_FIXTURES = path to fixtures JSON, MOCK_GH_CALLS = call log path.
const fs = require("fs");

const fixturesPath = process.env.MOCK_GH_FIXTURES;
const callsPath = process.env.MOCK_GH_CALLS;
const fixtures = fixturesPath && fs.existsSync(fixturesPath)
  ? JSON.parse(fs.readFileSync(fixturesPath, "utf8"))
  : {};

const argv = process.argv.slice(2);
let stdin = "";
try {
  if (!process.stdin.isTTY) stdin = fs.readFileSync(0, "utf8");
} catch { /* no stdin */ }

if (callsPath) {
  fs.appendFileSync(callsPath, JSON.stringify({ argv, stdin: stdin || undefined }) + "\n");
}

function out(text) { process.stdout.write(text); }
function errOut(text) { process.stderr.write(text); }
function fail(code, stderr) { errOut(stderr); process.exit(code); }

function findApi(endpoint, method) {
  const decoded = decodeURIComponent(endpoint);
  const api = fixtures.api || {};
  const errors = fixtures.apiErrors || {};
  const key = `${method} ${decoded}`;
  if (errors[key]) return { error: errors[key] };
  if (errors[decoded] && method === "GET") return { error: errors[decoded] };
  if (key in api) return { data: api[key] };
  if (method === "GET" && decoded in api) return { data: api[decoded] };
  return null;
}

const cmd = argv[0];

if (cmd === "--version") {
  out("gh version 2.103.3 (mock)\n");
  process.exit(0);
}

if (cmd === "auth" && argv[1] === "status") {
  const auth = fixtures.auth || { authenticated: false };
  if (auth.authenticated) {
    errOut(`github.com\n  ✓ Logged in as ${auth.user || "mock-user"}\n`);
    process.exit(0);
  }
  fail(1, "You are not logged into any GitHub hosts. Run gh auth login to authenticate.");
}

if (cmd === "api") {
  const method = argv.includes("-X") ? argv[argv.indexOf("-X") + 1] : "GET";
  // Endpoint = first positional arg after flags and their values.
  let endpoint = null;
  const valueFlags = new Set(["-X", "--method", "--input", "-f", "-F", "--jq", "-t"]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    endpoint = a;
    break;
  }
  const found = findApi(endpoint, method);
  if (found && found.error) fail(found.error.code || 1, found.error.stderr || "mock error");
  if (found) {
    out(JSON.stringify(found.data));
    process.exit(0);
  }
  // Generic write responses
  if (method === "POST" && /\/issues\/\d+\/comments$/.test(endpoint)) {
    const body = stdin ? JSON.parse(stdin) : {};
    const id = (fixtures.nextCommentId = (fixtures.nextCommentId || 1000) + 1);
    out(JSON.stringify({ id, body: body.body, user: { login: "mock-bot" }, created_at: new Date().toISOString() }));
    process.exit(0);
  }
  if (method === "POST" && /\/labels$/.test(endpoint)) {
    const nameArg = argv.find((a) => a.startsWith("name="));
    out(JSON.stringify({ name: nameArg ? nameArg.slice(5) : "mock-label" }));
    process.exit(0);
  }
  if (method === "DELETE") {
    out("");
    process.exit(0);
  }
  fail(1, `mock gh: no fixture for ${method} ${endpoint} (404 Not Found)`);
}

if (cmd === "pr" && argv[1] === "create") {
  const pr = fixtures.prCreate || { url: "https://github.com/mock/repo/pull/1" };
  if (pr.error) fail(1, pr.error);
  out(pr.url + "\n");
  process.exit(0);
}

fail(1, `mock gh: unsupported command ${argv.join(" ")}`);
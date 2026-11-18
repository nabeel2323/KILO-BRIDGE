'use strict';

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 1024 * 1024;
const LOG_FILE = path.join(__dirname, "provider.log");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

const FIXTURE_INITIAL_CONTENT = {
  "read.txt": "Kilo Bridge deterministic read content.\nLine 2: synthetic file data.\n",
  "write-target.txt": "",
  "edit-target.txt": "original text to replace\nkeep this line\n",
  "glob-test.ts": "export const x = 1;\n",
  "glob-test.js": "const x = 1;\n",
  "glob-data.json": "{\n  \"key\": \"value\"\n}\n",
  "grep-target.txt": "some text\nPHASE312_GREP_MARKER here\nmore text\n",
};

function ensureFixtures() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [name, content] of Object.entries(FIXTURE_INITIAL_CONTENT)) {
    fs.writeFileSync(path.join(FIXTURES_DIR, name), content, "utf8");
  }
}

ensureFixtures();

function parseCliPort(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const v = Number(argv[i + 1]);
      return Number.isFinite(v) ? Math.max(0, v) : 0;
    }
    const m = a.match(/^--port=(\d+)$/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

const cliPort = parseCliPort(process.argv);
const envPort = Number(process.env.PORT);
const PORT = Number.isFinite(cliPort)
  ? cliPort
  : Number.isFinite(envPort) && envPort >= 0
    ? envPort
    : 0;

const ALLOWED_TOOLS = new Set([
  "read", "glob", "grep", "edit", "write", "apply_patch", "bash",
  "external_directory", "lsp", "todoread", "todowrite", "webfetch",
  "task", "websearch", "skill", "native_tool_execute",
]);

const PREDETERMINED_ARGS = {
  read: { filePath: path.join(FIXTURES_DIR, "read.txt") },
  glob: { pattern: "**/*.{ts,js,json}" },
  grep: { pattern: "PHASE312_GREP_MARKER", path: FIXTURES_DIR },
  edit: {
    filePath: path.join(FIXTURES_DIR, "edit-target.txt"),
    oldString: "original text to replace",
    newString: "replacement text",
  },
  write: {
    filePath: path.join(FIXTURES_DIR, "write-target.txt"),
    content: "Kilo Bridge deterministic write content.\nLine 2: written by local provider.\n",
  },
  apply_patch: {
    diff: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
  },
  bash: { command: "echo deterministic" },
  external_directory: { path: path.join(FIXTURES_DIR, "external") },
  lsp: { filePath: path.join(FIXTURES_DIR, "file.ts"), query: "go-to-definition" },
  todoread: {},
  todowrite: {
    todos: [
      { content: "deterministic task one", status: "in_progress", priority: 2 },
      { content: "deterministic task two", status: "pending", priority: 1 },
    ],
  },
  webfetch: { url: "https://example.com" },
  task: {
    description: "deterministic subagent task",
    subagent_type: "general",
    prompt: "Perform the deterministic task.",
  },
  websearch: { query: "deterministic search query" },
  skill: { name: "read" },
  native_tool_execute: { tool: "read", path: "target.md" },
};

function sanitize(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let s = value;
    s = s.replace(/(["'"\s]*?)(?:[A-Za-z0-9+/=]{20,})(["'"\s]*?)/g, "$1[REDACTED]$2");
    return s.length > 200 ? s.slice(0, 200) + "...[TRUNCATED]" : s;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const lower = String(key).toLowerCase();
      if (
        lower.includes("key") ||
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.includes("password") ||
        lower.includes("authorization") ||
        lower.includes("api_key")
      ) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = sanitize(val);
      }
    }
    return out;
  }
  return value;
}

function log(message) {
  const line = new Date().toISOString() + " " + message + "\n";
  fs.appendFileSync(LOG_FILE, line);
}

function uuid() {
  return crypto.randomUUID().replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

// Kilo's @ai-sdk/openai-compatible adapter sends user/assistant content as an
// array of typed text parts, e.g. [{type:"text", text:"..."}, ...]. Older
// providers only handled string content. Flatten to a plain string so scenario
// keyword matching works regardless of the content shape.
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Response builders (non-streaming)
// ---------------------------------------------------------------------------

function buildChatCompletion(model, choices) {
  return {
    id: "chatcmpl_" + uuid(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function buildToolCallResponse(model, toolName, args) {
  return buildChatCompletion(model, [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_" + uuid(),
            type: "function",
            function: { name: toolName, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ]);
}

function buildFinalResponse(model, content) {
  return buildChatCompletion(model, [
    { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
  ]);
}

// ---------------------------------------------------------------------------
// Streaming response builders (OpenAI Chat Completions SSE)
// ---------------------------------------------------------------------------

// Kilo 7.8.27 bundles @ai-sdk/openai-compatible@2.0.54 which requests streaming
// (stream:true, stream_options.include_usage:true) and parses the response as
// Server-Sent Events. Each event is `data: <json>\n\n`; the stream terminates
// with `data: [DONE]\n\n`.
//
// Chunk contract required by the bundled adapter:
//   - choices[].delta.content must be a string or null (never an array) — see
//     Kilo-Org/kilocode#15344 (typed content parts crash the bundled parser).
//   - tool_calls[] deltas carry index, stable id (first fragment only),
//     type:"function" (first fragment only), function.name (first fragment) and
//     function.arguments (incremental string fragments).
//   - A terminal chunk carries finish_reason:"tool_calls" or "stop".

function sseChunk(model, delta, finishReason, usage) {
  const chunk = {
    id: "chatcmpl_" + uuid(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function buildToolCallStreamChunks(model, toolName, args, includeUsage) {
  const chunks = [];
  const toolCallId = "call_" + uuid();
  const argsJson = JSON.stringify(args);

  const push = (delta, finishReason) => chunks.push(sseChunk(model, delta, finishReason));

  // 1. Assistant role announcement.
  push({ role: "assistant", content: null }, null);
  // 2. Tool call header: index + id + type + name.
  push(
    {
      tool_calls: [
        { index: 0, id: toolCallId, type: "function", function: { name: toolName, arguments: "" } },
      ],
    },
    null,
  );
  // 3. Tool call arguments fragment (full JSON as one incremental piece).
  push({ tool_calls: [{ index: 0, function: { arguments: argsJson } }] }, null);
  // 4. Terminal finish_reason: tool_calls.
  push({}, "tool_calls");
  // 5. Optional usage chunk (choices: [] + usage, as OpenAI does).
  if (includeUsage) chunks.push({ id: "chatcmpl_" + uuid(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage: ZERO_USAGE });

  return chunks;
}

function buildFinalStreamChunks(model, content, includeUsage) {
  const chunks = [];
  chunks.push(sseChunk(model, { role: "assistant", content }, null));
  chunks.push(sseChunk(model, {}, "stop"));
  if (includeUsage) chunks.push({ id: "chatcmpl_" + uuid(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage: ZERO_USAGE });
  return chunks;
}

// ---------------------------------------------------------------------------
// Scenario selection
// ---------------------------------------------------------------------------

const SCENARIO_KEYWORDS = [
  { name: "grep", re: /\bgrep\b/i },
  { name: "glob", re: /\bglob\b/i },
  { name: "edit", re: /\b(?:edit|replace)\b/i },
  { name: "write", re: /\bwrite\b/i },
  { name: "read", re: /\bread\b/i },
];

const SCENARIO_HANDLERS = {
  read: {
    args: () => ({ ...PREDETERMINED_ARGS.read }),
    execute: (args) => {
      const content = fs.readFileSync(args.filePath, "utf8");
      return { filePath: args.filePath, content, bytes: Buffer.byteLength(content, "utf8") };
    },
    final: (args, result) => "Read " + result.filePath + " (" + result.bytes + " bytes):\n" + result.content,
  },
  write: {
    args: () => ({ ...PREDETERMINED_ARGS.write }),
    execute: (args) => {
      fs.writeFileSync(args.filePath, args.content, "utf8");
      const written = fs.readFileSync(args.filePath, "utf8");
      return { filePath: args.filePath, bytes: Buffer.byteLength(written, "utf8") };
    },
    final: (args, result) => "Wrote " + result.filePath + " (" + result.bytes + " bytes).",
  },
  edit: {
    args: () => ({ ...PREDETERMINED_ARGS.edit }),
    execute: (args) => {
      let content = fs.readFileSync(args.filePath, "utf8");
      const replaced = content.includes(args.oldString);
      content = content.replace(args.oldString, args.newString);
      fs.writeFileSync(args.filePath, content, "utf8");
      return { filePath: args.filePath, replaced };
    },
    final: (args, result) =>
      "Edited " + result.filePath + ": " + (result.replaced ? "replaced old string with new string" : "old string not found") + ".",
  },
  glob: {
    args: () => ({ ...PREDETERMINED_ARGS.glob }),
    execute: (args) => {
      const matches = globFiles(FIXTURES_DIR, args.pattern);
      return { dir: FIXTURES_DIR, pattern: args.pattern, matches };
    },
    final: (args, result) => "Glob " + result.pattern + " in " + result.dir + ": " + result.matches.join(", "),
  },
  grep: {
    args: () => ({ ...PREDETERMINED_ARGS.grep }),
    execute: (args) => {
      const matches = grepFiles(args.path, args.pattern);
      return { path: args.path, pattern: args.pattern, matches };
    },
    final: (args, result) => "Grep " + result.pattern + " in " + result.path + ": " + JSON.stringify(result.matches),
  },
};

// Sequence of pending tool names for the current scenario. "search" needs two
// sequential tool calls (grep then glob), so a queue is used.
let pendingQueue = [];

function selectTools(content, advertisedTools) {
  const text = extractText(content);
  const allowed = [];
  for (const t of advertisedTools) {
    if (ALLOWED_TOOLS.has(t) && !allowed.includes(t)) {
      allowed.push(t);
    }
  }
  if (/\bgrep\b/i.test(text) && allowed.includes("grep") && SCENARIO_HANDLERS.grep) {
    return { tools: ["grep", "glob"] };
  }
  for (const { name, re } of SCENARIO_KEYWORDS) {
    if (re.test(text) && allowed.includes(name) && SCENARIO_HANDLERS[name]) {
      return { tools: [name] };
    }
  }
  for (const name of allowed) {
    if (SCENARIO_HANDLERS[name]) return { tools: [name] };
  }
  for (const name of allowed) {
    return { tools: [name] };
  }
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function patternToRegex(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (pattern[i] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "{") {
      const j = pattern.indexOf("}", i);
      if (j === -1) {
        re += "\\{";
        i++;
        continue;
      }
      const alts = pattern.slice(i + 1, j).split(",").map(escapeRegExp);
      re += "(?:" + alts.join("|") + ")";
      i = j + 1;
    } else {
      re += escapeRegExp(c);
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

function globFiles(dir, pattern) {
  const regex = patternToRegex(pattern);
  const matches = [];
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, fullPath).split(path.sep).join("/");
    if (regex.test(rel)) matches.push(rel);
  }
  return matches.sort();
}

function grepFiles(dir, pattern) {
  const matches = [];
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(entry.parentPath, entry.name);
    let text;
    try {
      text = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(pattern)) {
        matches.push({ file: path.relative(dir, fullPath).split(path.sep).join("/"), line: i + 1, text: lines[i] });
      }
    }
  }
  return matches;
}

function handleToolResult(lastMessage) {
  const toolContent = extractText(lastMessage.content);
  let resultText = "Task complete.";
  if (pendingQueue.length > 0) {
    const tool = pendingQueue.shift();
    if (SCENARIO_HANDLERS[tool]) {
      try {
        const args = { ...PREDETERMINED_ARGS[tool] };
        const result = SCENARIO_HANDLERS[tool].execute(args);
        resultText = SCENARIO_HANDLERS[tool].final(args, result);
      } catch (err) {
        resultText = "Tool " + tool + " error: " + sanitize(String(err && err.message));
      }
    }
  } else if (toolContent) {
    resultText = "Tool result: " + sanitize(toolContent);
  }
  if (toolContent && !resultText.includes("Tool result:")) {
    resultText += "\nTool result: " + sanitize(toolContent);
  }
  return resultText;
}

function validateRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new Error("model must be a non-empty string");
  }
  if (!Array.isArray(body.messages)) {
    throw new Error("messages must be an array");
  }
  for (const msg of body.messages) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      throw new Error("each message must be an object");
    }
    if (typeof msg.role !== "string" || !["system", "user", "assistant", "tool"].includes(msg.role)) {
      throw new Error("invalid message role");
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error("tools must be an array");
    for (const t of body.tools) {
      if (t === null || typeof t !== "object" || Array.isArray(t)) {
        throw new Error("each tool must be an object");
      }
      if (t.type !== "function") {
        throw new Error("tool type must be function");
      }
      if (t.function === null || typeof t.function !== "object" || Array.isArray(t.function)) {
        throw new Error("tool function must be an object");
      }
      if (typeof t.function.name !== "string") {
        throw new Error("tool function name must be a string");
      }
      if (t.function.parameters !== undefined && (t.function.parameters === null || typeof t.function.parameters !== "object" || Array.isArray(t.function.parameters))) {
        throw new Error("tool function parameters must be an object");
      }
    }
  }
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (typeof tc === "string") {
      if (!["none", "required", "auto"].includes(tc)) throw new Error("invalid tool_choice");
    } else if (tc === null || typeof tc !== "object" || Array.isArray(tc)) {
      throw new Error("invalid tool_choice");
    }
  }
  return body;
}

function getAdvertisedTools(body) {
  if (!Array.isArray(body.tools)) return [];
  return body.tools
    .map((t) => (t && t.function ? t.function.name : undefined))
    .filter((n) => typeof n === "string");
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  let timedOut = false;
  let sent = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (sent) return;
    sent = true;
    try {
      req.destroy();
    } catch {}
    sendJson(408, { error: "Request timeout" });
    log("408 timeout");
  }, REQUEST_TIMEOUT_MS);
  const clearTimer = () => clearTimeout(timer);
  res.on("finish", clearTimer);
  res.on("close", clearTimer);
  req.on("error", () => {
    if (!sent) {
      sent = true;
      clearTimer();
    }
  });

  const sendJson = (status, obj) => {
    if (sent) return false;
    sent = true;
    clearTimer();
    const bodyStr = JSON.stringify(obj);
    try {
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) });
      res.end(bodyStr);
    } catch {}
    return true;
  };

  // Write a sequence of SSE chunks and terminate with `data: [DONE]`.
  const sendSse = (chunks, meta) => {
    if (sent) return false;
    sent = true;
    clearTimer();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const chunk of chunks) {
      const payload = JSON.stringify(chunk);
      res.write("data: " + payload + "\n\n");
      log("SSE EVENT " + meta + " " + payload);
    }
    res.write("data: [DONE]\n\n");
    log("SSE [DONE] " + meta);
    res.end();
    return true;
  };

  let urlPath = "";
  try {
    urlPath = new URL(req.url || "", "http://" + HOST).pathname;
  } catch {}

  if (req.method === "GET" && urlPath === "/health") {
    return sendJson(200, { status: "healthy" });
  }
  if (req.method !== "POST") {
    return sendJson(405, { error: "Method not allowed" });
  }
  if (urlPath !== "/v1/chat/completions") {
    return sendJson(404, { error: "Not found" });
  }

  let received = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    if (sent) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      return sendJson(413, { error: "Request entity too large" });
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (timedOut || sent) return;
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      return sendJson(400, { error: "Invalid JSON" });
    }
    try {
      validateRequest(body);
    } catch (err) {
      return sendJson(400, { error: sanitize(err.message) });
    }

    log("REQUEST body=" + JSON.stringify(sanitize(body)));

    const model = body.model;
    const messages = body.messages;
    const advertisedTools = getAdvertisedTools(body);
    const last = messages[messages.length - 1];
    const lastRole = last ? last.role : undefined;
    const lastText = last ? extractText(last.content) : "";
    const streamRequested = body.stream === true;
    const includeUsage = !!(body.stream_options && body.stream_options.include_usage);

    log(
      "REQUEST model=" +
        sanitize(model) +
        " stream=" +
        streamRequested +
        " includeUsage=" +
        includeUsage +
        " tool_choice=" +
        sanitize(body.tool_choice) +
        " tools=" +
        JSON.stringify(advertisedTools) +
        " lastRole=" +
        sanitize(String(lastRole)) +
        " lastText=" +
        JSON.stringify(sanitize(lastText)),
    );

    if (lastRole === "tool") {
      // Tool result round-trip: run pending tool (if any), else final answer.
      const resultText = handleToolResult(last);
      if (pendingQueue.length > 0) {
        const nextTool = pendingQueue.shift();
        const args = { ...(PREDETERMINED_ARGS[nextTool] || {}) };
        log("RESPONSE tool_call=" + nextTool + " stream=" + streamRequested);
        if (streamRequested) {
          return sendSse(buildToolCallStreamChunks(model, nextTool, args, includeUsage), "tool_call:" + nextTool);
        }
        return sendJson(200, buildToolCallResponse(model, nextTool, args));
      }
      log("RESPONSE final content_len=" + resultText.length + " stream=" + streamRequested);
      if (streamRequested) {
        return sendSse(buildFinalStreamChunks(model, resultText, includeUsage), "final");
      }
      return sendJson(200, buildFinalResponse(model, resultText));
    }

    let streamAction = null;
    if (lastRole === "user") {
      if (body.tool_choice === "none") {
        streamAction = { kind: "final", content: "Task complete." };
      } else {
        const selection = selectTools(lastText, advertisedTools);
        if (selection) {
          pendingQueue = [...selection.tools];
          const firstTool = pendingQueue.shift();
          const args = { ...(PREDETERMINED_ARGS[firstTool] || {}) };
          streamAction = { kind: "tool_call", tool: firstTool, args };
        } else {
          streamAction = { kind: "final", content: "Task complete." };
        }
      }
    } else {
      streamAction = { kind: "final", content: "Task complete." };
    }

    if (streamAction.kind === "tool_call") {
      log("RESPONSE tool_call=" + streamAction.tool + " stream=" + streamRequested);
      if (streamRequested) {
        return sendSse(buildToolCallStreamChunks(model, streamAction.tool, streamAction.args, includeUsage), "tool_call:" + streamAction.tool);
      }
      return sendJson(200, buildToolCallResponse(model, streamAction.tool, streamAction.args));
    }

    log("RESPONSE final content_len=" + streamAction.content.length + " stream=" + streamRequested);
    if (streamRequested) {
      return sendSse(buildFinalStreamChunks(model, streamAction.content, includeUsage), "final");
    }
    return sendJson(200, buildFinalResponse(model, streamAction.content));
  });
});

function shutdown() {
  log("SIGTERM/SIGINT received, shutting down...");
  server.close(() => {
    log("Server closed gracefully");
    process.exit(0);
  });
  const forced = setTimeout(() => {
    log("Forced exit after shutdown timeout");
    process.exit(1);
  }, 5000);
  forced.unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

let actualPort;
server.on("listening", () => {
  const addr = server.address();
  actualPort = typeof addr === "string" ? undefined : addr.port;
  process.stdout.write("[local-provider] actual port: " + actualPort + "\n");
  log("Listening on " + HOST + ":" + actualPort);
});

server.listen(PORT, HOST, () => {
  log("Server listening on " + HOST + ":" + PORT);
});

module.exports = { server, buildToolCallResponse, PREDETERMINED_ARGS, ALLOWED_TOOLS };
Object.defineProperty(module.exports, "actualPort", { enumerable: true, get: () => actualPort });

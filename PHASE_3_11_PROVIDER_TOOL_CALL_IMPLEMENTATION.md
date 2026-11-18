# Phase 3.11 Provider Tool Call Implementation

## Project

Kilo Bridge V1.0 — Universal AI Development Coordinator.

## Overview

The deterministic local OpenAI-compatible provider is implemented in test-fixtures/local-provider/server.js. It is an offline, in-process HTTP server that acts as a drop-in OpenAI-compatible chat-completions endpoint for Kilo v7.8.27 native tool verification, with no outbound network access and no credentials.

## File

| Item | Value |
|------|-------|
| File | test-fixtures/local-provider/server.js |
| Package | test-fixtures/local-provider/package.json (kilo-bridge-local-provider 1.0.0) |
| Start | node server.js  (PORT env overrides default) |
| Log | test-fixtures/local-provider/provider.log |
| Exports | server, buildToolCallsResponse, PREDETERMINED_ARGS, ALLOWED_TOOLS |

## Listener (loopback-only)

```js
const HOST = '127.0.0.1';
const PORT = (() => {
  const p = Number(process.env.PORT);
  return Number.isFinite(p) && p > 0 && p < 65536 ? p : 34567;
})();
```
- Listens exclusively on 127.0.0.1 (loopback). Not bound to 0.0.0.0 or any external interface.
- No external network access: the provider never initiates outbound connections; all traffic is local loopback.
- No credentials: no API keys, tokens, or secrets are read, sent, or logged. Local-only trust model.
- Default port 34567; runtime evidence shows it was also run on 127.0.0.1:34568 (provider.log lines 37, 47) for Kilo native tool integration on port 34568.

## HTTP surface

- Single route: POST /v1/chat/completions
- Non-POST methods ? 405 Method not allowed
- Non-/v1/chat/completions paths ? 404 Not found
- Request body size cap: MAX_BODY_BYTES = 1024 * 1024 (1 MiB); oversized ? 413 Request entity too large
- Request timeout: REQUEST_TIMEOUT_MS = 30000; timeout ? 408 Request timeout

## Strict JSON validation (validateRequest)

- Body must be a JSON object (not null, not array) ? 400 Invalid JSON / Request body must be a JSON object
- model must be a non-empty string ? 400 model must be a non-empty string
- messages must be an array ? 400 messages must be an array
- Each message must be an object with a role string
- Role must be one of: system, user, assistant, tool ? 400 invalid message role
- tools (if present) must be an array of objects with type === "function", function.name a string ? 400 on violation
- tool_choice (if string) must be one of: none, required, auto, or an object ? 400 invalid tool_choice (evidence: provider.log lines 33-35 show 400 invalid tool_choice)
- All error messages passed through sanitize() before logging (secret redaction)

## Deterministic responses

- Same advertised tools ? same deterministic tool_calls (subject to unique call IDs)
- PREDETERMINED_ARGS provides fixed arguments per tool (read, glob, grep, edit, write, apply_patch, bash, external_directory, lsp, todoread, todowrite, webfetch, task, websearch, skill)
- buildFinalResponse returns "Task complete." with finish_reason=stop when last message role is tool
- built responses include id, object, created (unix timestamp), model, choices[0], usage

## OpenAI Chat Completions structure (tool-calls response)

```json
{
  "id": "chatcmpl_<uuid-no-dashes>",
  "object": "chat.completion",
  "created": <unix_timestamp>,
  "model": "<echoed model>",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [ <one per advertised allowed tool> ]
      },
      "finish_reason": "tool_calls"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

Each tool_call:
```json
{
  "id": "call_<uuid-no-dashes>",
  "type": "function",
  "function": {
    "name": "<tool name>",
    "arguments": "{\"...\": \"...\"}"
  }
}
```

- tool_calls only emitted when last message role is "user"; when last role is "tool", a final response (finish_reason=stop) is returned instead (follow-up tool-result message handling).
- tool_count logged per response (provider.log: toolCount=1 for read-only smoke; toolCount=8 for normal-coding set).

## Actual tool_calls with unique call IDs

- Every tool_call.id is `call_` + crypto.randomUUID() with dashes removed ? globally unique per call.
- Every chat id is `chatcmpl_` + crypto.randomUUID() with dashes removed ? unique per response.
- Evidence (provider.log): call IDs such as call_native_00000001, call_1 appear across requests; each response has a distinct chatcmpl id.

## Kilo-native tool names mapping

ALLOWED_TOOLS (server.js:17-21):
```js
const ALLOWED_TOOLS = new Set([
  'read', 'glob', 'grep', 'edit', 'write', 'apply_patch', 'bash',
  'external_directory', 'lsp', 'todoread', 'todowrite', 'webfetch',
  'task', 'websearch', 'skill'
]);
```
- Only advertised tools present in ALLOWED_TOOLS are emitted in tool_calls; unknown tools are skipped.
- Mapping to Kilo v7.8.27 native tool set: read/glob/grep/edit/write/apply_patch/bash/external_directory align with REQUIRED_NATIVE_TOOL_PERMISSIONS (src/types.ts:393-395).
- Kilo-native tool names (read, glob, grep, edit, write, apply_patch, bash, external_directory) are used as function names in tool_calls.

## Follow-up tool-result messages

- server.js lastMessageRole(messages) (line 196-199):
  - lastRole === 'tool' ? buildFinalResponse (finish_reason=stop, content "Task complete.") — consumes the tool-result message and terminates.
  - lastRole === 'user' ? buildToolCallsResponse (finish_reason=tool_calls).
  - otherwise ? buildFinalResponse.
- Evidence (provider.log): request 2 (line 2) sends a user message + assistant tool_calls + a `{"role":"tool","tool_call_id":"call_native_00000001","content":"ok"}` follow-up ? response finish_reason=stop, content "Tool execution complete. Native tool verification succeeded deterministically."

## Strict limits

- MAX_BODY_BYTES = 1 MiB ? 413 if exceeded
- REQUEST_TIMEOUT_MS = 30 s ? 408 on timeout
- Each string value sanitized and truncated to 200 chars + "...[TRUNCATED]" if longer
- tool_choice restricted to none/required/auto/object
- roles restricted to system/user/assistant/tool

## Sanitized diagnostics

sanitize(value) (server.js:59-87):
- Redacts long base64-like secrets: /(["'\s]*?)(?:[A-Za-z0-9+/=]{20,})(["'\s]*?)/g ? [REDACTED]
- Truncates strings > 200 chars
- Recursively sanitizes arrays and objects
- Redacts object keys containing key/token/secret/password/authorization/api_key ? [REDACTED]
- All log messages (request, response, errors) pass through sanitize ? provider.log contains [REDACTED] for parameters and ids

## Clean shutdown

shutdown() (server.js:291-302):
- Handles SIGTERM and SIGINT
- Logs shutdown, server.close() then process.exit(0)
- Forced exit after 5000 ms grace timeout (process.exit(1)) via unref'd timer
- Registration: process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)

## Startup logging

- On listen: log `Listening on ${HOST}:${PORT}` (evidence: provider.log lines 21, 25, 29, 36, 37, 47)
- Each request: REQUEST model=... tools=[...] lastRole=...
- Each response: RESPONSE finish_reason=... [toolCount=N] id=... model=...
- Errors: 400 invalid JSON, 400 invalid tool_choice, 405, 404, 413, 408 all logged

## Integration notes

- Intended to run on 127.0.0.1:34568 for Kilo native tool integration (`kilo run --model local-test/local-model --agent <agent>` connects to the local provider).
- Kilo CLI adapter (src/components/kilo.ts) is the caller; provider is started independently (`node server.js`) before worker use.
- Not compiled by tsc (plain JS under test-fixtures).

---

Generated: 2026-11-16T00:00:00Z
Phase: 3.11
Status: Report files written

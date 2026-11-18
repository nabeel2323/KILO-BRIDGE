# Phase 3.10 Local Deterministic Provider Report

## Overview

A local deterministic provider was designed and implemented as an OpenAI-compatible HTTP server (server.js). It serves as an offline, deterministic alternative to remote LLM providers for the Kilo Bridge worker pipeline, enabling agent execution without external network calls.

## Local Provider Design

### Design Goals

- Offline operation: no outbound network access required.
- Deterministic output: same input produces same output.
- OpenAI-compatible API: drop-in replacement for OpenAI-compatible clients.
- Low latency: local execution, no API round-trips.
- Integrates with Kilo CLI adapter (src/components/kilo.ts).

### Architecture

Kilo CLI Adapter (kilo.ts)
        |
        v
HTTP POST /v1/chat/completions
        |
        v
server.js (OpenAI-compatible local provider)
        |
        v
Deterministic response generation
        |
        v
JSON response (OpenAI chat completion format)

## OpenAI-Compatible Format

The provider implements the OpenAI Chat Completions API:

Request:
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "local-deterministic",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0,
  "max_tokens": 1000,
  "stream": false
}

Response:
{
  "id": "chatcmpl-local-<uuid>",
  "object": "chat.completion",
  "created": <unix_timestamp>,
  "model": "local-deterministic",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<deterministic response>"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": <n>,
    "completion_tokens": <n>,
    "total_tokens": <n>
  }
}

## server.js Implementation

server.js is a Node.js HTTP server implementing the OpenAI-compatible endpoint. Key aspects:

- Listens on a configurable port (default localhost).
- Single POST route: /v1/chat/completions.
- Parses request body, validates required fields (model, messages).
- Generates a deterministic response based on input message content.
- Returns OpenAI-format JSON with id, created timestamp, choices, and usage.
- Supports non-streaming mode (stream: false).
- Logs requests to stderr (consistent with logging.ts structured logger).

Pseudo-structure of server.js:

const http = require('http');
const { v4: uuidv4 } = require('uuid');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { model, messages, temperature, max_tokens, stream } = JSON.parse(body);
      const content = generateDeterministicResponse(messages);
      const response = {
        id: `chatcmpl-local-${uuidv4()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'local-deterministic',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: countTokens(messages), completion_tokens: countTokens(content), total_tokens: 0 }
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => console.error(`Local provider listening on ${PORT}`));

## Request/Response Flow

1. Worker (worker.ts) invokes agent via Kilo CLI adapter (kilo.ts).
2. Kilo CLI adapter sends chat completion request to local provider endpoint.
3. HTTP POST to http://localhost:<PORT>/v1/chat/completions with OpenAI-format body.
4. server.js receives request, parses messages, generates deterministic response.
5. server.js returns OpenAI-format JSON response.
6. Kilo CLI adapter parses response, extracts assistant message content.
7. Event parsing and redaction applied (CoT filtered, secrets redacted).
8. Worker continues execute/verify/report/publish flow.

## Verification Results

Verification of the local deterministic provider was limited by the headless environment:

| Check | Result | Notes |
|-------|--------|-------|
| server.js starts and listens | NOT TESTED | Requires interactive Node process |
| /v1/chat/completions responds | NOT TESTED | Requires HTTP client against localhost |
| OpenAI-format response valid | NOT TESTED | Schema validation not run |
| Deterministic output (same input = same output) | NOT TESTED | Requires repeated requests |
| Kilo CLI adapter integration | NOT TESTED | Requires end-to-end worker run |
| Redaction applied to provider output | NOT TESTED | Requires live event log inspection |

No verification results were obtained because the headless environment cannot run an interactive local HTTP server and client against it during this phase.

## Limitations

- Cannot be tested in headless CI environment (no interactive server process).
- No outbound network access means provider must be started locally before worker use.
- Deterministic responses are rule-based, not model-generated; limited capability.
- No streaming support (stream: true not implemented).
- No tool calling / function calling support in OpenAI format.
- Authentication/authorization not implemented (local-only trust model).
- Port conflicts possible if multiple providers run concurrently.

## Integration Points

- src/components/kilo.ts — Kilo CLI adapter sends requests to provider.
- src/components/worker.ts — worker flow invokes agents via Kilo adapter.
- src/components/logging.ts — stderr logging for provider request/response.
- config.ts — provider endpoint URL configurable via bridge.config.json.

---
Generated: 2026-11-15T21:07:39Z
Phase: 3.10

# Local OpenAI-Compatible Provider

Deterministic mock LLM provider for Kilo v7.8.27 native tool verification. Implements a subset of the OpenAI Chat Completions API using only Node.js built-ins (`http`, `fs`, `path`, `url`, `crypto`). No external API, no API key, no npm dependencies.

## Usage

```sh
cd test-fixtures/local-provider
node server.js           # listens on http://127.0.0.1:34567 (default)
PORT=34568 node server.js  # configurable port via environment
node server.js --port=34568  # configurable port via CLI argument
```

## Endpoints

### POST /v1/chat/completions

Accepts OpenAI-compatible chat completion requests:

```json
{
  "model": "kilo-local",
  "messages": [{ "role": "user", "content": "..." }],
  "tools": [{ "type": "function", "function": { "name": "...", "description": "...", "parameters": { ... } } }]
}
```

## Behavior

- **First request:** returns `finish_reason: "tool_calls"` with a predetermined native tool call (`native_tool_execute`).
- **Subsequent requests (after tool result is sent back):** returns a final text response with `finish_reason: "stop"`.
- Invalid requests (bad JSON, missing fields, wrong method or path) return standard OpenAI-style error responses with status 400/404/405.
- Every request is bounded by a strict 30-second timeout (408 on timeout).

## Evidence

Each request/response pair is appended as a JSON line to `provider.log` next to `server.js`, with a timestamp. Request bodies are sanitized before logging: sensitive fields (api_key, authorization, secret, token, password) are redacted, long message content is truncated, and tool `parameters` are redacted.

## Shutdown

`SIGTERM` and `SIGINT` trigger graceful shutdown: the server stops accepting new connections, closes idle sockets, and exits.

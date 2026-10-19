---
Title: Module fixtures/mcp-servers
Version: 1.0.0
Type: component
Status: accepted
Summary: "`fixtures/mcp-servers` groups 2 file(s). Exposes 4 public symbol(s)."
---
```markdown
---
Title: Module fixtures/mcp-servers
Version: 1.0.0
Type: component
Status: accepted
Summary: "`fixtures/mcp-servers` groups 2 file(s). Exposes 4 public symbol(s)."
---

# Module fixtures/mcp-servers

## Summary

`fixtures/mcp-servers` supplies stand-ins for MCP servers so tests can exercise real transports without live third-party services. It has two parts: a loopback streamable-HTTP server that records every request it receives, and a stdio echo server that runs as a child process. It exposes 4 public symbols and groups 2 files.

## Overview

This module owns the local MCP server stand-ins used by tests and development. Its main piece, `http-server.ts`, runs a real HTTP MCP endpoint on a loopback port, so the transport under test is the transport that ships, and it keeps a record of every request for the test to inspect. `echo-server.ts` is the stdio counterpart: a small MCP server that a client launches as a process.

## How it works

`http-server.ts` is built on `Bun.serve` with `port: 0`, so the OS picks a free loopback port, and `startMockHttpMcpServer` returns a `MockHttpMcpServer` whose `url` is `http://127.0.0.1:<port>/mcp`. The JSON-RPC handling is hand-rolled rather than taken from the MCP SDK's server half, because the client under test loads the SDK and a shared framing bug would cancel out on both sides. Every request is recorded as a `RecordedRequest` (method, path, lowercased headers, parsed body) before any option is applied, so a test can see what arrived even when the server refuses it.

The fetch handler applies the per-instance `MockOptions` in a fixed order: delay, auth check, redirects, forced status, non-MCP HTML page, then dispatch. Notifications (no `id`) get a 202 with no body. `initialize`, `tools/list` and `tools/call` get MCP results, and `tools/call` treats `big` and `boom` as special tool names; any other method gets a JSON-RPC `-32601` error. With `sse` set, the same JSON-RPC message is sent as one `text/event-stream` event instead of a JSON body.

`echo-server.ts` is a Bun script that speaks newline-delimited JSON-RPC over stdin and stdout. It queues incoming lines on a promise chain, so requests are handled one at a time, as many real stdio servers behave. Its fixed tools are `echo`, `write_note`, `big` (a 40,000-character payload) and `boom` (an `isError` result), plus `hold` when `ECHO_SERVER_HOLD_TOOL=1`. Other behaviour is switched by `ECHO_SERVER_*` environment variables. On start it writes a terminal-control banner to stderr, so a test can confirm that a hostile server's stderr is not shown to the operator.

### Public API

| Symbol | Description |
|--------|-------------|
| `startMockHttpMcpServer` | Starts a mock HTTP MCP server. |
| `MockOptions` | Configuration options for the mock server. |
| `MockHttpMcpServer` | Represents the running mock server instance. |
| `RecordedRequest` | Captured request data from the mock server. |

Callers pass `MockOptions` to select behaviour per instance: `failWith` and `notMcp` for HTTP errors and non-MCP pages, `requireAuth` for a 401 unless the Authorization header matches, `delayMs` to exercise a handshake timeout, `sse` for event-stream responses, and `redirectTo` or `redirectSseTo` for a 307 on every request or on the SSE GET only. The returned `MockHttpMcpServer` is used as a local endpoint, and tests read `requests()` to assert on what the client sent.

## Key concepts

- **MCP fixture** — A test resource that stands in for an MCP server, so the code under test runs its real transport against something controllable.

- **Mock HTTP MCP server** — The instance returned by `startMockHttpMcpServer`: a real `Bun.serve` listener on 127.0.0.1. `stop()` closes it without waiting for in-flight requests, so a deliberately hanging handshake cannot stall teardown.

- **Mock options** — `MockOptions`, the per-instance switches for status codes, auth, delay, SSE and redirects. Without a `tools` option the server advertises two tools, `search` and `create_ticket`.

- **Recorded request** — `RecordedRequest`, the captured method, path, lowercased headers and parsed body. Tests assert on these to show what crossed the wire.

- **Stdio echo server** — `echo-server.ts`, a child process rather than an imported module. The graph shows no importers, and its header comments tie it to the stdio and process tests, so it appears to be run by path, not imported.

- **Fixture environment hooks** — The `ECHO_SERVER_*` variables, which expose the process pid, a hashed probe value, the presence of one variable, a one-time failure, and leak or hold behaviour to tests.

## Main flows

### Starting and stopping the HTTP mock

1. A test calls `startMockHttpMcpServer(options)`, which starts `Bun.serve` on port 0 and returns the `url`.
2. The client under test connects to that URL.
3. `stop()` calls `server.stop(true)`, which closes without waiting for in-flight requests.

### Serving one request

The fetch handler reads the body, parses it as JSON (keeping the raw text if it is not JSON), and pushes a `RecordedRequest`. It then applies the options in order: delay, `requireAuth`, `redirectTo`, `redirectSseTo` for GET, `failWith`, `notMcp`. A notification gets 202. Otherwise `initialize`, `tools/list` or `tools/call` is answered, and `tools/call` returns the `big` payload, a `boom` error result, or a `remote:<name>:<arguments>` text reply.

### Driving the stdio echo server

The client spawns `echo-server.ts` as a child process. On each stdin chunk the server splits complete lines, queues each on a promise chain, and answers in order. The `hold` tool writes its `started` file and polls until the `release` file exists, which blocks every other request in the meantime. Closing stdin exits the process unless `ECHO_SERVER_IGNORE_EOF=1`, in which case only a signal stops it.

### Integration with `src/mcp-servers`

The `src/mcp-servers` module depends on this fixture module through four imports. These fixtures support the real MCP server code paths—likely for testing, local validation, or developer workflows.

---

## Reference

_Extracted by `keryx wiki collect`; regenerated by `--force`._

### Public API

- `RecordedRequest`
- `MockHttpMcpServer`
- `MockOptions`
- `startMockHttpMcpServer`

### Key files

| File | Importers | Imports |
|------|-----------|---------|
| `fixtures/mcp-servers/http-server.ts` | 4 | 0 |
| `fixtures/mcp-servers/echo-server.ts` | 0 | 0 |

### Depended on by

- `src/mcp-servers` (4 imports)

### Graph signals

- Files: 2
- Cross-module imports: 0

## Related Wiki

- [Wiki Index](../index.md)
- [Module src/mcp-servers](src-mcp-servers.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections enriched by the gdwiki workflow.
```

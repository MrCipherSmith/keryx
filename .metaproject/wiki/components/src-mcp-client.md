---
Title: Module src/mcp-client
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/mcp-client` groups 10 file(s). Depends on `src/lib`, `src/harness/external`. Exposes 20 public symbol(s)."
---
```markdown
---
Title: Module src/mcp-client
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/mcp-client` is the client-side facade for MCP server integrations. It bundles the files used to connect to Codex, HTTP, and stdio MCP servers, convert MCP messages into application-friendly shapes, and manage elicitation prompts that require an approve or deny decision."
---

# Module src/mcp-client

## Summary

`src/mcp-client` is the client-side facade for MCP server integrations. It bundles the files used to connect to Codex, HTTP, and stdio MCP servers, convert MCP messages into application-friendly shapes, and manage elicitation prompts that require an approve or deny decision.

## Overview

The module owns client-side MCP behavior rather than server implementations. It centralizes three responsibilities:

- **Connection management**: Opening MCP connections through SDK-backed helpers such as `connectCodexMcpClient`, `connectStdioMcpServer`, and `connectHttpMcpServer`. The SDK is loaded lazily, so a missing SDK surfaces as `McpClientSdkMissingError` rather than an import failure at startup.
- **Type normalization**: Converting tool metadata into the stable `McpToolDescriptor` shape, and exposing `McpServerConnection` as the transport-neutral connection that stdio and HTTP servers both return.
- **Elicitation handling**: Turning a server's approval prompt (`elicitation/create`) into a pending record, correlating it with Codex's own `codex/event` decision vocabulary, and building the approve or deny response.

### Dependencies

`src/mcp-client` depends on:
- `src/lib` for shared utilities; `elicitation.ts` imports `src/lib/command-risk` to classify commands
- `src/harness/external`, which the graph reports as a dependency but which the source files read only mention in comments

### Consumers

This module is consumed by `src/mcp-servers`, `src/commands`, `src/tui`, and other harness-related code that needs a stable client API for MCP server interactions.

## How it works

The module is organized around four layers:

### Connection entry points

`client.ts` exposes connection helpers and error types. Callers use these to open Codex, stdio, or HTTP MCP connections.

| Helper | Purpose |
|--------|---------|
| `connectCodexMcpClient` | Opens a Codex-backed MCP connection |
| `connectStdioMcpServer` | Opens a stdio-based MCP connection |
| `connectHttpMcpServer` | Opens an HTTP-based MCP connection |
| `buildCodexMcpServerArgv` | Shapes arguments for Codex-backed servers |
| `McpClientSdkMissingError` | Signals missing external SDK prerequisites |

`client.ts` is the only file that loads `@modelcontextprotocol/sdk`, and it does so through separate loaders (`loadCoreSdk`, `loadHttpSdk`, `loadSdk`). Each loader fails independently, so a stdio server does not stop working because the HTTP transport module moved. The Codex path is the only one that reaches into `Protocol.prototype`: it registers the `elicitation/create` handler through the base class to keep the vendor fields the SDK's own `Client` would strip. The stdio and HTTP paths install no such handler. Both bound the handshake and close the transport on timeout or abort, so a timed-out child process is killed rather than left behind. The HTTP path also refuses redirects and rejects empty credential headers.

### Type contract

`types.ts` holds the shapes for the Codex specialist and the raw wire, with no SDK import:

- `McpClientConnection` - the Codex connection, which adds `onElicitation` and `onCodexEvent` on top of `callTool` and `close`
- `McpClientPort` - the injected seam that tests substitute for the real connect function
- `McpToolCallOutcome` - `result`, `timeout` or `error`; a call always resolves rather than throwing, so a slow server is not reported like a refusing one
- `RawElicitationRequest`, `RawCodexEventNotification` and `ElicitationResponsePayload` - the unparsed request, the decoded `codex/event`, and the `{action, decision}` reply

`client.ts` declares `McpServerConnection` and `McpToolDescriptor`. Keeping the two connection types separate means a user-configured server is never offered the elicitation hooks.

### Wire mapping

`wire.ts` parses raw JSON-RPC messages, already decoded from JSON, into the module's types. It never throws and needs no SDK. It exists because the SDK's Zod schema strips unknown keys such as `codex_call_id`, so the raw message has to be read before any schema sees it. `parseElicitationCreateRequest` keeps every non-standard param in `vendor`, and `parseCodexEventNotification` unpacks `params.msg`.

### Elicitation adapter

`elicitation.ts` contains the core logic for MCP elicitation:

- `toPendingElicitation` - converts a raw request into a `PendingElicitation`, reading `codex_call_id` from `vendor`
- `correlateElicitation` - matches the call id against a recent `exec_approval_request` `codex/event` and returns the `available_decisions` vocabulary, or `uncorrelated`
- `pickApproveDecision` / `pickDenyDecision` - choose a verdict from that vocabulary. The approve value is `approved` when present, and the deny value prefers `abort`
- `buildElicitationResponse` - builds the reply. An uncorrelated request, or an unrecognised vocabulary, is declined without a `decision` field
- `classifyElicitationRisk` - the risk seam. It reuses `isDestructiveCommand` and `touchesAgentCredentials` from `src/lib/command-risk` on the unwrapped command text, and escalates every `patch-approval` elicitation to destructive
- `describeElicitationPrompt` - turns an approval request into a readable message and command for the operator prompt

### Command parsing helpers

`extractCodexCommand` and `unwrapShellWrappedCommand` support interpreting command-shaped values that appear in Codex or MCP flows.

## Key concepts

### McpServerConnection

A public representation of an established MCP server connection. Consumers use this shape to interact with a server without depending on transport internals.

### McpToolDescriptor

A normalized description of a tool provided by an MCP server. The `toToolDescriptors` function converts raw MCP tool data into this shape for use by commands, TUI views, and MCP server-facing logic. Entries without a string name are dropped, because a tool with no name cannot be called. `annotations` is kept as a sibling of `inputSchema`, as the protocol places it.

### McpClientConnection

The live connection to a Codex `mcp-server` child. Unlike `McpServerConnection`, it carries the elicitation and `codex/event` hooks, so only the Codex path uses it.

### Codex MCP client

The Codex-backed connection path includes:

- `connectCodexMcpClient` - spawns the child, registers the elicitation handler and completes the handshake
- `buildCodexMcpServerArgv` - returns `["codex", "mcp-server"]`
- `codexMcpClientPort` - the production `McpClientPort`, `{ connect: connectCodexMcpClient }`

### Elicitation

An interaction in which an MCP server asks for confirmation or supplemental input. The module models this with:

- `ElicitationPromptText` - represents the prompt content
- `ElicitationVerdict` - the approve or deny decision
- `CorrelationResult` - outcome of correlating a prompt with pending context

### Approve and deny decisions

`pickApproveDecision` and `pickDenyDecision` provide the decision primitives used when responding to elicitation prompts.

### Command extraction

`extractCodexCommand` and `unwrapShellWrappedCommand` extract command payloads from wrapped command structures, supporting flows where a command must be inspected or surfaced to users.

## Main flows

### Establishing an MCP connection

1. Caller selects the transport path:
   - **Codex**: `connectCodexMcpClient` with optional `buildCodexMcpServerArgv`
   - **Stdio**: `connectStdioMcpServer`
   - **HTTP**: `connectHttpMcpServer`
2. The Codex path returns `McpClientConnection` from `types.ts`. The stdio and HTTP paths return `McpServerConnection` from `client.ts`.
3. Transport details stay in `client.ts`. `wire.ts` only decodes raw messages and does not open a connection.

If an external SDK is required but unavailable, the connection path surfaces `McpClientSdkMissingError`.

### Presenting MCP tools to callers

1. MCP tool metadata arrives from a connected server
2. `toToolDescriptors` maps that metadata to `McpToolDescriptor` values
3. Consumers in `src/mcp-servers`, `src/commands`, and `src/tui` render or dispatch those descriptors without MCP-specific parsing. The `annotations` hint is what risk classification reads to tell read-only tools from destructive ones.

### Processing an elicitation prompt

1. The raw `elicitation/create` request is captured from the transport tap in `client.ts` and stored by request id. When the SDK asks for a response, the registered handler reads it back. With no consumer registered, the handler declines at once so the child is not left waiting.
2. `toPendingElicitation` converts the raw request into a `PendingElicitation`, and `correlateElicitation` matches its `callId` against the recent `exec_approval_request` event, returning a `CorrelationResult`
3. `pickApproveDecision` or `pickDenyDecision` chooses a value from that correlated vocabulary, and `classifyElicitationRisk` supplies the destructive and credentials flags the approval gate needs
4. `buildElicitationResponse` turns the `ElicitationVerdict` into the `{action, decision}` payload that codex reads. This payload is returned as the raw JSON-RPC result.
5. `MCP_ELICITATION_TOOL_PREFIX` names the synthetic approval tool, and `describeElicitationPrompt` reads that name back to render the prompt for the operator. This wiring is not in `src/mcp-client`; it appears to live in `src/harness/external/supervise-mcp.ts` and the two `requestApproval` renderers.

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by `--force`. The prose sections above are the agent/human-owned part.

### Public API

| Symbol | Type |
|--------|------|
| `McpClientSdkMissingError` | class |
| `connectCodexMcpClient` | function |
| `codexMcpClientPort` | constant |
| `buildCodexMcpServerArgv` | function |
| `McpToolDescriptor` | interface |
| `McpServerConnection` | interface |
| `toToolDescriptors` | function |
| `connectHttpMcpServer` | function |
| `connectStdioMcpServer` | function |
| `CorrelationResult` | type |
| `correlateElicitation` | function |
| `pickApproveDecision` | function |
| `pickDenyDecision` | function |
| `ElicitationVerdict` | type |
| `buildElicitationResponse` | function |
| `toPendingElicitation` | function |
| `extractCodexCommand` | function |
| `unwrapShellWrappedCommand` | function |
| `MCP_ELICITATION_TOOL_PREFIX` | constant |
| `ElicitationPromptText` | interface |

### Key files

| File | Import count | Imports |
|------|--------------|---------|
| `src/mcp-client/client.ts` | 21 | 2 |
| `src/mcp-client/elicitation.ts` | 5 | 3 |
| `src/mcp-client/types.ts` | 7 | 0 |
| `src/mcp-client/wire.ts` | 6 | 1 |
| `src/mcp-client/elicitation.test.ts` | 0 | 3 |
| `src/mcp-client/fixtures.test.ts` | 0 | 3 |

### Module dependencies

**Depends on:**
- `src/lib` - 1 import(s)
- `src/harness/external` - 1 import(s)

**Depended on by:**
- `src/mcp-servers` - 16 import(s)
- `src/harness/external` - 5 import(s)
- `src/commands` - 3 import(s)
- `src/tui` - 1 import(s)

### Graph signals

- **Files**: 10
- **Cross-module imports**: 2

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/external](src-harness-external.md)
- [Module src/mcp-servers](src-mcp-servers.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```

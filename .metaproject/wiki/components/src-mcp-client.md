---
Title: Module src/mcp-client
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/mcp-client` groups 10 file(s). Depends on `src/lib`, `src/harness/external`. Exposes 20 public symbol(s)."
---
```markdown
---
Title: Module src/mcp-client
Version: 0.1.0
Type: component
Status: accepted
Summary: "`src/mcp-client` is the client-side facade for MCP server integrations. It bundles the files used to connect to Codex, HTTP, and stdio MCP servers, convert MCP messages into application-friendly shapes, and manage elicitation prompts that require an approve or deny decision."
---

# Module src/mcp-client

## Summary

`src/mcp-client` is the client-side facade for MCP server integrations. It bundles the files used to connect to Codex, HTTP, and stdio MCP servers, convert MCP messages into application-friendly shapes, and manage elicitation prompts that require an approve or deny decision.

## Overview

The module owns client-side MCP behavior rather than server implementations. It centralizes three responsibilities:

- **Connection management**: Establishing MCP connections through SDK-backed helpers such as `connectCodexMcpClient`, `connectStdioMcpServer`, and `connectHttpMcpServer`.
- **Type normalization**: Converting MCP connection data and tool metadata into stable public interfaces like `McpServerConnection` and `McpToolDescriptor`.
- **Elicitation handling**: Managing elicitation-related flows including prompt representation, correlation, decision selection, and response construction.

### Dependencies

`src/mcp-client` depends on:
- `src/lib` for shared utilities
- `src/harness/external` for external integration support

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

### Type contract

`types.ts` defines public shapes that form the stable boundary between MCP transport details and application consumers:

- `McpServerConnection` - represents an established MCP server connection
- `McpToolDescriptor` - normalized description of an MCP server tool

### Wire mapping

`wire.ts` handles low-level translation between MCP protocol messages and the module's public types. This allows connection helpers to present a simplified API without exposing transport internals.

### Elicitation adapter

`elicitation.ts` contains the core logic for MCP elicitation:

- `toPendingElicitation` - converts prompts into pending records
- `correlateElicitation` - associates incoming requests with their context
- `pickApproveDecision` / `pickDenyDecision` - selects verdicts
- `buildElicitationResponse` - constructs server-expected responses

### Command parsing helpers

`extractCodexCommand` and `unwrapShellWrappedCommand` support interpreting command-shaped values that appear in Codex or MCP flows.

## Key concepts

### McpServerConnection

A public representation of an established MCP server connection. Consumers use this shape to interact with a server without depending on transport internals.

### McpToolDescriptor

A normalized description of a tool provided by an MCP server. The `toToolDescriptors` function converts raw MCP tool data into this shape for use by commands, TUI views, and MCP server-facing logic.

### Codex MCP client

[REDACTED:name]-specific connection path includes:

- `connectCodexMcpClient` - establishes the connection
- `buildCodexMcpServerArgv` - prepares server arguments
- `codexMcpClientPort` - exposes the connection port

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
2. The returned value conforms to `McpServerConnection` from `types.ts`
3. Transport details are handled through `wire.ts`, keeping the public API stable

If an external SDK is required but unavailable, the connection path surfaces `McpClientSdkMissingError`.

### Presenting MCP tools to callers

1. MCP tool metadata arrives from a connected server
2. `toToolDescriptors` maps that metadata to `McpToolDescriptor` values
3. Consumers in `src/mcp-servers`, `src/commands`, and `src/tui` render or dispatch those descriptors without MCP-specific parsing

### Processing an elicitation prompt

1. An elicitation prompt is represented using `ElicitationPromptText` and converted to a pending form with `toPendingElicitation`
2. `correlateElicitation` associates the incoming prompt with its pending context, returning a `CorrelationResult`
3. A response choice is produced with `pickApproveDecision` or `pickDenyDecision`
4. `buildElicitationResponse` converts the selected `ElicitationVerdict` into the response payload expected by the MCP server
5. `MCP_ELICITATION_TOOL_PREFIX` scopes elicitation-related tool naming so callers can distinguish these prompts from ordinary tool events

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

- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```

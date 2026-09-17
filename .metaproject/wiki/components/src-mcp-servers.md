---
Title: Module src/mcp-servers
Version: 0.1.0
Type: component
Status: draft
Summary: "Groups 53 files for MCP server configuration, diagnostics, credentials, and runtime coordination. Depends on `src/mcp-client`, `src/lib`, `fixtures/mcp-servers`. Exposes 20 public symbol(s)."
---
# Module src/mcp-servers

## Summary

`src/mcp-servers` is the module responsible for discovering, parsing, validating, cataloging, and running MCP server definitions. It groups 53 file(s), exposes 20 public symbol(s), and depends on `src/mcp-client`, `src/lib`, and `fixtures/mcp-servers`.

In practice, it acts as the application's server-management layer: it turns configuration into usable MCP server objects, coordinates lifecycle behavior, and provides supporting logic for credentials and diagnostics.

## Overview

The module owns the boundary between user-facing configuration and runtime execution for MCP servers. It is intended to be used by higher-level surfaces such as commands and terminal UI workflows that need to list, select, inspect, and operate against available MCP servers.

It does not appear to implement the underlying protocol itself. Instead, it coordinates the surrounding concerns: loading server definitions from config, resolving them into a normalized form, tracking known servers, applying credentials, diagnosing configuration issues, and managing runtime lifecycles through `src/mcp-client`.

## How it works

At a high level, the module is organized into a few cooperating layers:

- **Configuration layer**  
  Files like `src/mcp-servers/config.ts` handle discovery and parsing of MCP server configuration. Public symbols such as `parseConfigFile`, `parseJsonTolerant`, `expandVars`, `projectConfigFiles`, and `loadMcpServers` indicate support for loading config from files, expanding environment-style variables, and producing a normalized configuration result.

- **Validation and resolution layer**  
  Symbols such as `McpConfigProblem`, `ResolvedMcpConfig`, and `ResolvedMcpServer` suggest that raw input is validated, normalized, and converted into a more precise internal model. Constants like `SCHEMA_VERSION`, `MAX_SERVER_NAME_LENGTH`, and `MAX_TIMEOUT_SEC` imply schema and limit enforcement.

- **Catalog and lifecycle layer**  
  `src/mcp-servers/catalog.ts` and `src/mcp-servers/manager.ts` imply a notion of server catalogs or registered server definitions, plus management of server state. This is supported by the presence of `McpRuntime`, `McpRuntimeOptions`, and `ServerActionResult`.

- **Runtime layer**  
  `src/mcp-servers/runtime.ts` coordinates interaction with server instances. Timing constants such as `CLOSE_GRACE_MS` and `KILL_GRACE_MS` suggest controlled startup/shutdown behavior and grace-period handling during teardown.

- **Credential and diagnostics layer**  
  `src/mcp-servers/credentials.ts` and `src/mcp-servers/doctor.ts` imply support for handling secrets/auth material and for diagnosing common configuration or runtime problems. These likely feed into user-facing status or troubleshooting flows.

The module depends heavily on:

- `src/mcp-client` for lower-level MCP interaction
- `src/lib` for shared utilities
- `fixtures/mcp-servers` for test or sample data

It is primarily consumed by `src/commands` and `src/tui`.

## Key concepts

- **Server source and entry**
  `McpServerSource` and `McpServerEntry` represent where a server definition comes from and how it is declared in configuration.

- **Resolved server**
  `ResolvedMcpServer` is the normalized, ready-to-use representation of a server after parsing, variable expansion, and validation.

- **Config result and problems**
  `ResolvedMcpConfig` holds the overall resolved configuration, while `McpConfigProblem` captures validation or loading issues that may be reported back to callers.

- **Disable overlay**
  `McpDisableOverlay` appears to model a mechanism for suppressing servers without changing the original source configuration.

- **Runtime object and options**
  `McpRuntime` and `McpRuntimeOptions` describe an active or manageable server runtime, while `ServerActionResult` likely captures the outcome of a runtime operation.

- **Limits and schema**
  Constants such as `SCHEMA_VERSION`, `MAX_SERVER_NAME_LENGTH`, and `MAX_TIMEOUT_SEC` define structural and behavioral boundaries for server configuration.

- **Graceful shutdown**
  `CLOSE_GRACE_MS` and `KILL_GRACE_MS` indicate a staged shutdown approach: close first, then force-kill if needed.

## Main flows

### 1. Loading and resolving configuration

A typical configuration flow likely looks like this:

1. A caller requests server configuration using something like `loadMcpServers` with `LoadOptions`.
2. The module discovers relevant config files, possibly via `projectConfigFiles`.
3. Each file is read and parsed through `parseConfigFile`, potentially using `parseJsonTolerant`.
4. Variable references are expanded using `expandVars`.
5. Definitions are normalized into `ResolvedMcpServer` values and collected into `ResolvedMcpConfig`.
6. Validation issues are recorded as `McpConfigProblem` and surfaced to callers.

### 2. Starting or interacting with a server

A runtime flow likely follows this pattern:

1. A caller selects a server from a catalog or resolved configuration.
2. Any required credentials or auth-related material are prepared via `credentials.ts`.
3. A `McpRuntime` is created using `McpRuntimeOptions`.
4. The runtime delegates the underlying interaction to `src/mcp-client`.
5. The caller receives a `ServerActionResult` describing the result of the operation.
6. Shutdown is handled through the runtime's lifecycle logic, respecting `CLOSE_GRACE_MS` and `KILL_GRACE_MS`.

### 3. Diagnostics and troubleshooting

A diagnostic flow likely works like this:

1. Higher-level UI or command code asks the module to inspect server state or configuration quality.
2. `doctor.ts` evaluates resolved servers, config problems, source information, and possibly runtime readiness.
3. Findings are returned for display in command output or TUI screens.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `McpServerEntry`
- `McpServerSource`
- `ResolvedMcpServer`
- `McpConfigProblem`
- `ResolvedMcpConfig`
- `McpDisableOverlay`
- `MAX_SERVER_NAME_LENGTH`
- `SCHEMA_VERSION`
- `parseJsonTolerant` (function)
- `MAX_TIMEOUT_SEC`
- `expandVars` (function)
- `parseConfigFile` (function)
- `projectConfigFiles` (function)
- `LoadOptions`
- `loadMcpServers` (function)
- `CLOSE_GRACE_MS`
- `KILL_GRACE_MS`
- `McpRuntimeOptions`
- `ServerActionResult`
- `McpRuntime`

### Key files

- `src/mcp-servers/config.ts` - imported by 32, imports 2
- `src/mcp-servers/runtime.ts` - imported by 12, imports 11
- `src/mcp-servers/doctor.ts` - imported by 11, imports 8
- `src/mcp-servers/credentials.ts` - imported by 15, imports 3
- `src/mcp-servers/manager.ts` - imported by 13, imports 3
- `src/mcp-servers/catalog.ts` - imported by 12, imports 1

### Depends on

- `src/mcp-client` - 16 import(s)
- `src/lib` - 8 import(s)
- `fixtures/mcp-servers` - 4 import(s)
- `src/harness/external` - 2 import(s)
- `src/commands` - 1 import(s)
- `src/contracts` - 1 import(s)

### Depended on by

- `src/commands` - 26 import(s)
- `src/tui` - 11 import(s)

### Graph signals

- Files: 53
- Cross-module imports: 34

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/mcp-client](src-mcp-client.md)
- [Module src/lib](src-lib.md)
- [Module fixtures/mcp-servers](fixtures-mcp-servers.md)
- [Module src/harness/external](src-harness-external.md)
- [Module src/commands](src-commands.md)
- [Module src/contracts](src-contracts.md)
- [Module src/tui](src-tui.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.

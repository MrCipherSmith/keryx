---
Title: Module src/mcp-servers
Version: 0.1.0
Type: component
Status: draft
Summary: "Discovers, parses, validates, catalogs, and runs MCP server definitions. Groups 53 files, exposes 20 public symbols, and depends on `src/mcp-client`, `src/lib`, and `fixtures/mcp-servers`."
---

# Module src/mcp-servers

## Summary

`src/mcp-servers` is the server-management layer for MCP server definitions. It discovers configuration, resolves it into normalized runtime objects, tracks known servers, applies credentials, diagnoses configuration issues, and manages server lifecycles through `src/mcp-client`.

The module owns the boundary between user-facing configuration and runtime execution. It does not implement the underlying MCP protocol; instead, it coordinates surrounding concerns that higher-level surfaces (commands, TUI) need to list, select, inspect, and operate against available servers.

## Key concepts

| Concept | Description |
|---------|-------------|
| `McpServerSource` | Represents where a server definition originates (e.g., file path, registry). |
| `McpServerEntry` | A declared server in configuration. |
| `ResolvedMcpServer` | A normalized, validated server ready for runtime use. |
| `ResolvedMcpConfig` | The fully resolved configuration containing all servers and metadata. |
| `McpConfigProblem` | A validation or loading issue surfaced to callers. |
| `McpDisableOverlay` | A mechanism for suppressing servers without modifying source config. |
| `McpRuntime` | An active or manageable server runtime instance. |
| `McpRuntimeOptions` | Configuration for creating a runtime. |
| `ServerActionResult` | Outcome of a runtime operation. |

### Constants

- `SCHEMA_VERSION` — enforced configuration schema version
- `MAX_SERVER_NAME_LENGTH` — maximum length for server names
- `MAX_TIMEOUT_SEC` — maximum timeout for server operations
- `CLOSE_GRACE_MS` — grace period for graceful shutdown before force-kill
- `KILL_GRACE_MS` — grace period for forced termination

## How it works

The module is organized into cooperating layers:

- **Configuration layer** (`config.ts`) — discovers and parses MCP server configuration. Handles file loading, environment variable expansion (`expandVars`), and produces normalized results via `parseConfigFile`, `parseJsonTolerant`, `projectConfigFiles`, and `loadMcpServers`.

- **Validation and resolution layer** — validates raw input against schema constraints, normalizes structures, and converts them into `ResolvedMcpServer` and `ResolvedMcpConfig` objects.

- **Catalog and lifecycle layer** (`catalog.ts`, `manager.ts`) — manages server catalogs, registered definitions, and state transitions.

- **Runtime layer** (`runtime.ts`) — coordinates server lifecycle (startup, shutdown) with `src/mcp-client`. Implements staged shutdown using `CLOSE_GRACE_MS` and `KILL_GRACE_MS`.

- **Credential and diagnostics layer** (`credentials.ts`, `doctor.ts`) — handles secrets/auth material and diagnoses configuration or runtime problems for user-facing troubleshooting.

## Main flows

### Loading and resolving configuration

1. A caller invokes `loadMcpServers` with `LoadOptions`.
2. The module discovers relevant config files via `projectConfigFiles`.
3. Each file is read and parsed through `parseConfigFile` (using `parseJsonTolerant` for resilience).
4. Variable references are expanded using `expandVars`.
5. Definitions are normalized into `ResolvedMcpServer` values and collected into `ResolvedMcpConfig`.
6. Validation issues are recorded as `McpConfigProblem` and returned to callers.

### Starting or interacting with a server

1. A caller selects a server from the catalog or resolved configuration.
2. Required credentials are prepared via `credentials.ts`.
3. A `McpRuntime` is created using `McpRuntimeOptions`.
4. The runtime delegates underlying interaction to `src/mcp-client`.
5. A `ServerActionResult` describes the outcome.
6. Shutdown follows staged logic: close first, then force-kill if needed.

### Diagnostics and troubleshooting

1. Higher-level UI or command code requests server state or configuration quality inspection.
2. `doctor.ts` evaluates resolved servers, config problems, source information, and runtime readiness.
3. Findings are returned for display in command output or TUI screens.

## Dependencies

### External dependencies

| Module | Import count | Purpose |
|--------|--------------|---------|
| `src/mcp-client` | 16 | Lower-level MCP interaction |
| `src/lib` | 8 | Shared utilities |
| `fixtures/mcp-servers` | 4 | Test or sample data |
| `src/harness/external` | 2 | Test harness support |
| `src/commands` | 1 | Command integration |
| `src/contracts` | 1 | Contract types |

### Consumers

| Module | Import count |
|--------|--------------|
| `src/commands` | 26 |
| `src/tui` | 11 |

## File inventory

| File | Imports | Exports | Purpose |
|------|---------|---------|---------|
| `src/mcp-servers/config.ts` | 2 | 32 | Configuration loading and parsing |
| `src/mcp-servers/runtime.ts` | 11 | 12 | Server lifecycle management |
| `src/mcp-servers/credentials.ts` | 3 | 15 | Credential handling |
| `src/mcp-servers/manager.ts` | 3 | 13 | Server state management |
| `src/mcp-servers/catalog.ts` | 1 | 12 | Server catalog operations |
| `src/mcp-servers/doctor.ts` | 8 | 11 | Diagnostics and troubleshooting |

## Public API

### Types

- `McpServerEntry`
- `McpServerSource`
- `ResolvedMcpServer`
- `McpConfigProblem`
- `ResolvedMcpConfig`
- `McpDisableOverlay`
- `McpRuntimeOptions`
- `ServerActionResult`
- `McpRuntime`

### Constants

- `MAX_SERVER_NAME_LENGTH`
- `SCHEMA_VERSION`
- `MAX_TIMEOUT_SEC`
- `CLOSE_GRACE_MS`
- `KILL_GRACE_MS`

### Functions

- `parseJsonTolerant`
- `expandVars`
- `parseConfigFile`
- `projectConfigFiles`
- `loadMcpServers`

## Related pages

- [Wiki Index](../index.md)
- [Module src/mcp-client](src-mcp-client.md)
- [Module src/lib](src-lib.md)
- [Module fixtures/mcp-servers](fixtures-mcp-servers.md)
- [Module src/harness/external](src-harness-external.md)
- [Module src/commands](src-commands.md)
- [Module src/contracts](src-contracts.md)
- [Module src/tui](src-tui.md)

## Changelog

- **0.1.0** — Initial draft by `keryx wiki collect` (2026-09-16)

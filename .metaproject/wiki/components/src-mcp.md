# Module src/mcp

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/mcp` groups 13 file(s). Depends on `src/lib`, `src/gdgraph`, `src/standard`. Exposes 12 public symbol(s).

## Overview

`src/mcp` is the Model Context Protocol server layer for keryx. It exposes read-only Metaproject services — code graph queries, security checks, flow status, memory search, health gate, wiki queries, and standard validation — to AI editors and agents as MCP tools and resources over a stdio transport (with an opt-in HTTP/SSE path). The module is a thin protocol adapter: it owns serialization, visibility filtering, redaction routing, and transport wiring, but delegates every domain operation to the respective service facades in other modules. It is depended on by `src/commands` and is the only place in the codebase where the optional `@modelcontextprotocol/sdk` is ever loaded.

## How it works

The module is organized in three concentric layers.

**Configuration and discovery** (`config.ts`, `client-config.ts`). `config.ts` loads `mcp.config.json` from `.metaproject/core/mcp/` and deep-merges it over built-in defaults, always producing a well-formed `McpConfig` without ever throwing. `client-config.ts` handles the install/uninstall lifecycle: it writes a managed `keryx mcp serve` server entry into editor client configs (Cursor's `.cursor/mcp.json` and Claude's `.mcp.json`), identified by a `_keryxManaged` sentinel that guarantees idempotency and prevents clobbering user-authored entries. It also manages opt-in enablement by flipping `modules.mcp.enabled` in `metaproject.json` and scaffolding the required on-disk structure.

**Pure dispatch core** (`tools.ts`, `dispatch.ts`). `tools.ts` defines the tool registry: `buildToolRegistry()` returns a flat list of `ToolEntry` objects, each a thin adapter that deserializes JSON-RPC params, calls a single service facade method (e.g. `getAffected`, `createSecurityService`, `createGdWikiService`), and returns a typed result. No business logic lives in the registry itself. `dispatch.ts` then layers three concerns over that registry without any SDK dependency: it builds an `McpContext` (config + discovery + tools), applies a three-way visibility filter (module exposed in manifest, config include/exclude list, and `mcpEnabled`/`exposeTools` flags), and routes every tool result through a `redactToolOutput` seam before it can leave the process. Resource listing and reading live in the same file and are guarded by the same `mcpEnabled`/`exposeResources` flags.

**Transport binding** (`server.ts`). `server.ts` is the sole file that ever imports `@modelcontextprotocol/sdk`, and only via a lazy `await import()` so the module is never loaded on any command path except `keryx mcp serve`. It calls `createMcpServer(ctx)` to build an SDK `Server` whose four request handlers (`tools/list`, `tools/call`, `resources/list`, `resources/read`) each delegate directly to the corresponding `dispatch*` function. The resulting server is then connected to either a stdio transport (default) or the opt-in HTTP/SSE transport (isolated in `./transport/http-sse`), which requires an explicit capability flag in the manifest.

## Key concepts

**ToolEntry** — the central registry unit. Each entry carries a `name` (e.g. `gdgraph.affected`), a `module` label used for manifest-level filtering, an `inputSchema` (a minimal JSON Schema fragment), a `mutating` flag that marks whether the tool writes anything, and an `invoke(cwd, params)` function that performs the actual work.

**McpContext** — the per-request runtime bundle assembled by `buildMcpContext`. It holds the resolved `McpConfig`, the `McpDiscovery` snapshot (manifest flags), the `cwd`, and the full tool registry. Everything downstream in the dispatch core operates on this context rather than reading config files again.

**McpConfig** — the structured configuration surface: transport choice (`stdio` | `http`), HTTP host/port/enabled, tool include/exclude filter lists, resource roots, and the `redactToolOutput` boolean (defaults to `true` and must remain so per the security contract M-5).

**Visibility filter** — a three-layer gate evaluated in `visibleTools()`: (1) the manifest's `modules.mcp.enabled` and `expose.tools` flags, (2) whether the tool's `module` is listed in `expose.modules`, and (3) the config-level include/exclude list. A tool that fails any layer is hidden from `tools/list` and is unreachable via `tools/call`.

**Redaction seam** — every tool result is serialized to JSON and passed through `redactToolOutput` before being returned to the transport. This seam is the only path out; it is not possible to bypass it for a visible tool.

**McpClientRuntime** — an abstraction for editor-specific install targets. Each runtime knows its settings file path (or `null` for the `generic` clipboard-snippet case), how to merge the managed entry in, how to strip it back out, and how to validate the resulting config. The two file-backed runtimes are `cursor` and `claude`.

**_keryxManaged sentinel** — a key written into every managed server entry to distinguish it from user-authored entries. It ensures that install is idempotent and that uninstall removes exactly the entry keryx wrote, leaving all other servers intact.

## Main flows

**Flow 1 — `keryx mcp serve` startup.** `src/commands` calls `serveMcp({ cwd })` in `server.ts`. That function calls `buildMcpContext(cwd)` from `dispatch.ts`, which concurrently loads config via `loadMcpConfig` (`config.ts`) and the manifest discovery snapshot. With the context built, `createMcpServer(ctx)` is called: it lazily imports the SDK (throwing `McpSdkMissingError` with an install hint if it is absent), constructs an SDK `Server`, and registers four request handlers that close over `ctx`. Finally, `startStdioTransport(server)` (from `./transport/stdio`) connects the server to stdin/stdout and begins the JSON-RPC message loop.

**Flow 2 — a tool call (`tools/call`).** The SDK delivers a `CallToolRequest` to the registered handler in `server.ts`. The handler extracts `name` and `arguments`, then calls `dispatchCallTool(ctx, name, args)` in `dispatch.ts`. That function runs `visibleTools(ctx)` to verify the tool is exposed, then calls `tool.invoke(ctx.cwd, args)` — for example, for `gdgraph.affected` this calls `getAffected(graph, file)` from `src/gdgraph/query`. The raw result is JSON-serialized and passed through `redactToolOutput` before being wrapped in `{ text, isError }` and returned to the SDK. Any error in `invoke` is caught and returned as `isError: true` rather than propagating across the transport.

**Flow 3 — `keryx mcp install`.** `src/commands` calls `installMcpClient(projectRoot, ids, options)` in `client-config.ts`. For each resolved runtime (e.g. `cursor`), it reads the existing settings file (or starts from an empty object), calls `runtime.merge(settings, projectRoot)` to inject the managed server entry with the `_keryxManaged` sentinel, validates the result, and writes the file back (unless `dryRun`). In parallel, `enableMcpModule` updates `metaproject.json` to set `modules.mcp.enabled=true` and calls `scaffoldMcpModule` to create the `core/mcp/` directory tree and default config/manifest files if they are missing. Finally, `probeMcpSdk` checks whether the optional SDK is importable and returns an actionable hint if not.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `JsonSchema`
- `ToolEntry` (interface)
- `buildToolRegistry` (function)
- `McpContext` (interface)
- `buildMcpContext` (function)
- `visibleTools` (function)
- `ToolListing` (interface)
- `dispatchListTools` (function)
- `ToolCallResult` (interface)
- `dispatchCallTool` (function)
- `dispatchListResources` (function)
- `dispatchReadResource` (function)

### Key files

- `src/mcp/tools.ts` - imported by 2, imports 8
- `src/mcp/dispatch.ts` - imported by 4, imports 5
- `src/mcp/mcp.test.ts` - imported by 0, imports 7
- `src/mcp/client-config.ts` - imported by 3, imports 2
- `src/mcp/config.ts` - imported by 3, imports 2
- `src/mcp/server.ts` - imported by 2, imports 3

### Depends on

- `src/lib` - 6 import(s)
- `src/gdgraph` - 2 import(s)
- `src/standard` - 2 import(s)
- `src/security` - 2 import(s)
- `src/mcp/transport` - 2 import(s)
- `src/wiki` - 2 import(s)

### Depended on by

- `src/commands` - 3 import(s)

### Graph signals

- Files: 13
- Cross-module imports: 20

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/gdgraph](src-gdgraph.md)
- [Module src/standard](src-standard.md)
- [Module src/security](src-security.md)
- [Module src/mcp/transport](src-mcp-transport.md)
- [Module src/wiki](src-wiki.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki enrich workflow (2026-07-10).
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

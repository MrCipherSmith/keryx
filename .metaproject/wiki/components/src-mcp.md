---
Title: Module src/mcp
Version: 1.0.1
Type: component
Status: accepted
Summary: ""
---
```markdown
---
Title: Module src/mcp
Version: 1.0.1
Type: component
Status: accepted
Summary: "Model Context Protocol server layer exposing read-only Metaproject services (code graph, security, flow, memory, health, wiki, validation) as MCP tools and resources to AI editors. Thin protocol adapter delegating to service facades; supports stdio and opt-in HTTP/SSE transport."
---
# Module src/mcp

VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df
VerifiedScope: sha256:9cbe5d0cbd59c817e21a866641803a8a96522d3542c1b221f31df60d6a148619

## Summary

`src/mcp` groups 13 file(s). Depends on `src/lib`, `src/gdgraph`, `src/standard`. Exposes 12 public symbol(s).

## Overview

`src/mcp` is the Model Context Protocol server layer for keryx. It exposes read-only Metaproject services — code graph queries, security checks, flow status, memory search, health gate, wiki queries, and standard validation — to AI editors and agents as MCP tools and resources over a stdio transport (with an opt-in HTTP/SSE path). The module is a thin protocol adapter: it owns serialization, visibility filtering, redaction routing, and transport wiring, but delegates every domain operation to the respective service facades in other modules. It is depended on by `src/commands` and is the only place in the codebase where the optional `@modelcontextprotocol/sdk` is ever loaded.

## How it works

The module is organized in three concentric layers.

**Configuration and discovery** (`config.ts`, `client-config.ts`). `config.ts` loads `mcp.config.json` from `.metaproject/core/mcp/` and deep-merges it over built-in defaults, always producing a well-formed `McpConfig` without ever throwing. `client-config.ts` handles the install/uninstall lifecycle: it writes a managed `keryx serve-mcp` server entry into editor client configs (Cursor's `.cursor/mcp.json` and Claude's `.mcp.json`), identified by a `_keryxManaged` sentinel that guarantees idempotency and prevents clobbering user-authored entries. It also manages opt-in enablement by flipping `modules.mcp.enabled` in `metaproject.json` and scaffolding the required on-disk structure.

**Pure dispatch core** (`tools.ts`, `dispatch.ts`). `tools.ts` defines the tool registry: `buildToolRegistry()` returns a flat list of `ToolEntry` objects, each a thin adapter that deserializes JSON-RPC params, calls a single service facade method (e.g. `getAffected`, `createSecurityService`, `createGdWikiService`), and returns a typed result. No business logic lives in the registry itself. `dispatch.ts` then layers three concerns over that registry without any SDK dependency: it builds an `McpContext` (config + discovery + tools), applies a three-way visibility filter (module exposed in manifest, config include/exclude list, and `mcpEnabled`/`exposeTools` flags), and routes every tool result through a `redactToolOutput` seam before it can leave the process. Resource listing and reading live in the same file and are guarded by the same `mcpEnabled`/`exposeResources` flags.

**Transport binding** (`server.ts`). `server.ts` is the sole file that ever imports `@modelcontextprotocol/sdk`, and only via a lazy `await import()` so the module is never loaded on any command path except `keryx serve-mcp`. It calls `createMcpServer(ctx)` to build an SDK `Server` whose four request handlers (`tools/list`, `tools/call`, `resources/list`, `resources/read`) each delegate directly to the corresponding `dispatch*` function. The resulting server is then connected to either a stdio transport (default) or the opt-in HTTP/SSE transport (isolated in `./transport/http-sse`), which requires an explicit capability flag in the manifest.

## Key concepts

**ToolEntry** — the central registry unit. Each entry carries a `name` (e.g. `gdgraph.affected`), a `module` label used for manifest-level filtering, an `inputSchema` (a minimal JSON Schema fragment), a `mutating` flag that marks whether the tool writes anything, and an `invoke(cwd, params)` function that performs the actual work.

**McpContext** — the per-request runtime bundle assembled by `buildMcpContext`. It holds the resolved `McpConfig`, the `McpDiscovery` snapshot (manifest flags), the `cwd`, and the full tool registry. Everything downstream in the dispatch core operates on this context rather than reading config files again.

**McpConfig** — the structured configuration surface: transport choice (`stdio` | `http`), HTTP host/port/enabled, tool include/exclude filter lists, resource roots, and the `redactToolOutput` boolean (defaults to `true` and must remain so per the security contract M-5).

**Visibility filter** — a three-layer gate evaluated in `visibleTools()`:

1. The manifest's `modules.mcp.enabled` and `expose.tools` flags
2. Whether the tool's `module` is listed in `expose.modules`
3. The config-level include/exclude list

A tool that fails any layer is hidden from `tools/list` and is unreachable via `tools/call`.

**Redaction seam** — every tool result is serialized to JSON and passed through `redactToolOutput` before being returned to the transport. This seam is the only path out; it is not possible to bypass it for a visible tool.

**McpClientRuntime** — an abstraction for editor-specific install targets. Each runtime knows its settings file path (or `null` for the `generic` clipboard-snippet case), how to merge the managed entry in, how to strip it back out, and how to validate the resulting config. The two file-backed runtimes are `cursor` and `claude`.

**_keryxManaged sentinel** — a key written into every managed server entry to distinguish it from user-authored entries. It ensures that install is idempotent and that uninstall removes exactly the entry keryx wrote, leaving all other servers intact.

## Main flows

### Flow 1 — `keryx serve-mcp` startup

1. `src/commands` calls `serveMcp({ cwd })` in `server.ts`
2. `serveMcp` calls `buildMcpContext(cwd)` from `dispatch.ts`
3. `buildMcpContext` concurrently loads config via `loadMcpConfig` (`config.ts`) and the manifest discovery snapshot
4. With the context built, `createMcpServer(ctx)` is called
   - Lazily imports the SDK (throws `McpSdkMissingError` with an install hint if absent)
   - Constructs an SDK `Server`
   - Registers four request handlers that close over `ctx`
5. `startStdioTransport(server)` from `./transport/stdio` connects the server to stdin/stdout and begins the JSON-RPC message loop

### Flow 2 — a tool call (`tools/call`)

1. The SDK delivers a `CallToolRequest` to the registered handler in `server.ts`
2. Handler extracts `name` and `arguments`, calls `dispatchCallTool(ctx, name, args)` in `dispatch.ts`
3. `dispatchCallTool` runs `visibleTools(ctx)` to verify the tool is exposed
4. Calls `tool.invoke(ctx.cwd, args)` — for example, for `gdgraph.affected` this calls `getAffected(graph, file)` from `src/gdgraph/query`
5. Raw result is JSON-serialized and passed through `redactToolOutput`
6. Wrapped in `{ text, isError }` and returned to the SDK
7. Any error in `invoke` is caught and returned as `isError: true` rather than propagating across the transport

### Flow 3 — `keryx integrate`

1. `src/commands` calls `installMcpClient(projectRoot, ids, options)` in `client-config.ts`
2. For each resolved runtime (e.g. `cursor`):
   - Reads existing settings file (or starts from empty object)
   - Calls `runtime.merge(settings, projectRoot)` to inject the managed server entry with `_keryxManaged` sentinel
   - Validates the result and writes the file back (unless `dryRun`)
3. In parallel, `enableMcpModule` updates `metaproject.json` to set `modules.mcp.enabled=true`
4. `scaffoldMcpModule` creates the `core/mcp/` directory tree and default config/manifest files if missing
5. `probeMcpSdk` checks whether the optional SDK is importable and returns an actionable hint if not

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by `--force`. The prose sections above are the agent/human-owned part.

### Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `HandleSlateOpenParams` | interface | Parameters for slate open handler |
| `handleSlateOpen` | function | Handles slate open events |
| `buildToolRegistry` | function | Constructs the tool registry |
| `McpContext` | interface | Per-request runtime bundle |
| `buildMcpContext` | function | Assembles McpContext from config and discovery |
| `visibleTools` | function | Applies three-layer visibility filter |
| `ToolListing` | interface | Tool list response structure |
| `dispatchListTools` | function | Handles tools/list requests |
| `ToolCallResult` | interface | Tool call response structure |
| `dispatchCallTool` | function | Handles tools/call requests |
| `dispatchListResources` | function | Handles resources/list requests |
| `dispatchReadResource` | function | Handles resources/read requests |

### Key files

| File | Imports | Exports to |
|------|---------|------------|
| `src/mcp/tools.ts` | 13 | 5 modules |
| `src/mcp/dispatch.ts` | 6 | 6 modules |
| `src/mcp/metaproject-tools.ts` | 4 | 5 modules |
| `src/mcp/client-config.ts` | 2 | 6 modules |
| `src/mcp/server.ts` | 3 | 3 modules |
| `src/mcp/mcp.test.ts` | 7 | 0 (test file) |

### Module dependencies

**Depends on:**

- `src/harness/tool` — 8 import(s)
- `src/lib` — 6 import(s)
- `src/sac` — 4 import(s)
- `src/gdgraph` — 3 import(s)
- `src/security` — 3 import(s)
- `src/standard` — 2 import(s)

**Depended on by:**

- `src/commands` — 3 import(s)
- `src/harness/tool` — 3 import(s)
- `src/sac` — 3 import(s)
- `src/tui` — 3 import(s)

### Graph signals

- Files: 19
- Cross-module imports: 36

## Related Wiki

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/gdgraph](src-gdgraph.md)
- [Module src/standard](src-standard.md)
- [Module src/security](src-security.md)
- [Module src/mcp/transport](src-mcp-transport.md)
- [Module src/wiki](src-wiki.md)
- [Module src/commands](src-commands.md)

## Changelog

- **1.0.1** — Reference refreshed from the code graph (5886c474)
- **1.0.0** — Prose sections enriched by gdwiki enrich workflow (2026-07-10)
- **0.1.0** — Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z
```

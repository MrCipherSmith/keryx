---
Title: Module src/mcp-servers
Version: 1.0.0
Type: component
Status: accepted
Summary: "Discovers, parses, validates, catalogs, and runs MCP server definitions. Groups 53 files, exposes 20 public symbols, and depends on `src/mcp-client`, `src/lib`, and `fixtures/mcp-servers`."
---

# Module src/mcp-servers

## Summary

`src/mcp-servers` owns the path from MCP server definitions on disk to a running, catalogued set of servers for one shell session. It reads native `.keryx/mcp-servers.json` files at user and project scope, plus read-only courtesy reads of other tools' config files, merges them by server name, applies the personal enable/disable overlay, and holds back project-committed servers until the operator has trusted them. It does not implement the MCP protocol; it hands each approved definition to `src/mcp-client` and turns what comes back into a tool catalog that commands and the TUI can search and act on.

## Key concepts

| Concept | Description |
|---------|-------------|
| `McpServerSource` | The layer a definition came from: `project`, `user`, or one of the compat tools' files (`cursor`, `claude`, `mcp.json`, `grok`). Compat sources are read but never written. |
| `McpServerEntry` | One server exactly as written in a config file: `command` or `url`, `env`, `headers`, `oauth`, timeouts and `enabled`. |
| `ResolvedMcpServer` | An entry after `${VAR}` expansion, with its winning `source`, `file`, `projectLocal` flag (whether a repository could have committed it), overlay-adjusted `enabled`, and the unexpanded `raw` entry that anything printed must use. |
| `ResolvedMcpConfig` | The resolved servers, sorted by name, together with the problems found while loading them. |
| `McpConfigProblem` | A file or entry that could not be read or validated. It is carried back rather than thrown, and marked `foreign` when it came from a compat file keryx does not own. |
| `McpDisableOverlay` | The personal overrides map from `mcp-servers-disabled.json`. It holds `true` and `false` per name, so it can enable a server that a project file disabled as well as disable one. |
| `McpRuntime` | The per-session handle: `catalog()`, `servers()`, `configured()`, `connectServer`, `disconnectServer`, `ready()` and `close()`. Created once by the surface that owns the session. |
| `McpRuntimeOptions` | `cwd`, `gitRoot`, `configDir`, `env`, and an optional `connect` function that tests use to replace the real dial. |
| `ServerActionResult` | `{ ok: true }` or `{ ok: false, message }`, returned by connect and disconnect. |

### Constants

- `SCHEMA_VERSION` — the only `schemaVersion` the loader accepts (1). A newer file is refused with a message to upgrade, not read on guesswork.
- `MAX_SERVER_NAME_LENGTH` — 40. Leaves room in the 64-character `server__tool` limit for a tool name.
- `MAX_TIMEOUT_SEC` — one day. Larger values overflow `setTimeout`, which silently becomes 1 ms.
- `CLOSE_GRACE_MS` — 750 ms. How long `close()` waits for outstanding dials before closing what it has.
- `KILL_GRACE_MS` — 4500 ms. How long `close()` waits for aborted dials' child processes to exit. The SDK escalates from stdin end to SIGTERM to SIGKILL over about four seconds.

## How it works

The module is organized into cooperating layers:

- **Configuration layer** (`config.ts`) — `loadMcpServers` merges the config layers into one list. Compat files (listed by `compatFiles`, read by `compat.ts`) load first so native definitions overwrite them, then the user file, then the project files from `projectConfigFiles`, shallowest first so the deepest file wins. The merge replaces whole entries per name rather than merging fields, so a project server never inherits half of a user definition. `parseConfigFile` checks the schema version and each entry (`entryProblems`, `oauthProblems`), and records a bad entry as a problem instead of skipping it silently. `expandVars` resolves `${VAR}` and `${VAR:-default}` in the fields `expandEntry` names. `parseJsonTolerant` lives in `json-utils.ts`, moved out to break an import cycle with `compat.ts`.

- **Catalog layer** (`catalog.ts`) — pure functions with no I/O. `catalogForServer` qualifies each tool as `server__tool`. Characters outside `[A-Za-z0-9_-]` become `_` in the name the model sees, while `rawName` keeps the server's own name for `tools/call`. A name that still fails `FQN_PATTERN`, or a duplicate after sanitising (first in `tools/list` wins), is kept as a `SkippedTool` with its reason. `mergeCatalogs` combines the per-server results.

- **Manager layer** (`manager.ts`) — `startServers` dials enabled servers with `DEFAULT_CONNECT_CONCURRENCY` (4) at a time. Each dial and each `listTools` call is raced against the server's timeout, 15 s by default, and `startServers` never rejects: a failure becomes a `failed` state carrying its message. A connection that lands after its timeout is closed. `closeServers` closes what remains, so one failed close does not block the others.

- **Runtime layer** (`runtime.ts`) — `createMcpRuntime` returns without blocking. Project servers that `trust.ts` has not approved are reported as `needs-approval` and never dialled. The rest start in the background, and `catalog()` and `servers()` are functions, so a server that finishes late appears without a rebuild. `connectServer` and `disconnectServer` run one at a time per server name, persist the choice through `setServerEnabled` in `store.ts`, and record the name in a `mutated` set so the startup sweep does not overwrite an operator's action. `close()` is staged and idempotent: it aborts pending dials, waits `CLOSE_GRACE_MS`, closes connections, then waits up to `KILL_GRACE_MS` for aborted children to exit.

- **Remote and credential layer** (`runtime.ts` `connectRemote`, `credentials.ts`, `http-headers.ts`) — before a socket opens, `remoteTargetProblem` and `resolveHttpHeaders` refuse an invalid URL or a header whose credential variable resolves empty. OAuth is considered only when the server declares no `authorization` header and no `bearer_token_env_var`, and has not set `oauth: false` (`usesOAuth`). `sessionAuthProviderOptions` returns a provider only when a stored token exists; otherwise the session dials without one, and a 401 is reported as `needs_auth`. A session never starts an interactive login. Tokens are kept in `mcp-credentials.json`, keyed by `name:url`, written owner-only under a file lock.

- **Diagnostics layer** (`doctor.ts`) — `runDoctor` diagnoses servers one at a time, through the `connect` function it is given (the session's own dial procedure), and closes each connection after listing. Environment and header values appear only as `set` or `unset`. Failure text comes from HTTP status, system error codes and TLS codes where present, and from message text only as a fallback. The report is healthy only when nothing needs the operator.

Supporting modules that the layers above import: `trust.ts` (the approval store the runtime gate reads), `store.ts` (writes the enabled toggle), `spawn-env.ts` (the environment a stdio child receives), `tools.ts` (display sanitising), and `oauth-provider.ts` (the SDK auth provider).

## Main flows

### Loading and resolving configuration

1. A caller invokes `loadMcpServers` with `LoadOptions`. When `configDir` is given without `home`, the compat files in the real home directory are skipped, so an isolated run does not depend on which tools the machine's user has configured.
2. Compat files are read first, then the user file in the keryx config directory, then each file from `projectConfigFiles`. Each goes through `parseConfigFile`, which parses tolerantly, refuses a newer `schemaVersion`, and validates every entry.
3. Invalid entries and unreadable files become `McpConfigProblem` values, tagged `foreign` when they come from a compat file. Nothing throws, and the valid servers still load.
4. The winner for each name is kept. The overlay in `mcp-servers-disabled.json` sets `enabled` in both directions, and each winner is expanded with `expandVars` while its `raw` entry is kept for display. The result is a name-sorted `ResolvedMcpConfig`.

### Starting a session

1. `createMcpRuntime` loads the config and the trust store, and holds back every enabled project server that still needs approval. Those are reported as `needs-approval` and never dialled.
2. `startServers` dials the rest in the background. A command server goes through `connectStdioMcpServer` with an environment from `buildMcpChildEnv`; a URL server goes through `connectRemote`.
3. Each successful dial's `listTools` result passes through `catalogForServer`. The merged catalog and per-server states update as each dial settles, and the shell reads them through `catalog()` and `servers()`.
4. A server that fails becomes a `failed` state with its message. The shell opens either way.

### Connecting, disconnecting and shutting down

1. `connectServer(name)` refuses an unapproved project server, treats an already connected one as success, and persists `enabled: true` through `store.ts`. It then closes any existing connection, dials once, and updates the state and catalog.
2. `disconnectServer(name)` persists `enabled: false`, closes the connection, and removes that server's catalog entries. It refuses while the server is still connecting.
3. `close()` aborts pending dials, waits up to `CLOSE_GRACE_MS`, closes the connections, and waits up to `KILL_GRACE_MS` for aborted child processes to exit. A dial that lands after that is closed when it arrives.

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

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- **0.1.0** — Initial draft by `keryx wiki collect` (2026-09-16)

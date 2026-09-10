# Keryx MCP Servers — Specification
Version: 0.1.0

**Status: specification ready (future).** No runtime implementation is
claimed. File and symbol citations below are the *current* code this package
must integrate with, verified by reading them.

## 1. Identity

A new module, `src/mcp-servers/`, that turns operator-configured MCP servers
into a catalog the interactive agent can search and call.

It is **not** `src/mcp/` (keryx as an MCP server for editors). It is **not**
a replacement for `src/mcp-client/` (Codex elicitation). It **uses** a
generalized MCP client port: stdio + streamable HTTP, `listTools`,
`callTool`, `close`.

SDK: `@modelcontextprotocol/sdk`, lazy `await import()`, same
`*SdkMissingError` shape as `src/mcp/server.ts` and
`src/mcp-client/client.ts`. No second MCP library (`rmcp` is Grok Build's
stack; keryx does not take it).

Config schema: [schemas/mcp-servers-config.schema.json](schemas/mcp-servers-config.schema.json).

## 2. Storage structure

| File | Role |
|---|---|
| `{keryxConfigDir()}/mcp-servers.json` | User-global native config. `keryxConfigDir` is `src/lib/config-dir.ts` (XDG `~/.local/share/keryx` on Unix). |
| `{keryxConfigDir()}/mcp-credentials.json` | Owner-only OAuth/token store (`writeOwnerOnlyFile`, same seam as `search-credentials.json`). |
| `{keryxConfigDir()}/mcp-servers-disabled.json` | Personal enable/disable overlay so toggling a project-defined server does not rewrite the committed file. |
| `<project>/.keryx/mcp-servers.json` | Project-scoped native config, walked cwd → git root. Deepest file wins per name. |
| Compat sources (read-only) | `.cursor/mcp.json`, `~/.cursor/mcp.json`, project `.mcp.json`, `~/.claude.json` `mcpServers` / `projects.<cwd>.mcpServers`, Grok `~/.grok/config.toml` and `<repo>/.grok/config.toml` `[mcp_servers.*]`. |

Do **not** write into `.metaproject/core/mcp/mcp.config.json`. That file is
the inbound `keryx serve-mcp` config (`src/mcp/config.ts`).

Native config is JSON, not TOML. Grok TOML is a compat *reader*. Writes from
`keryx mcp add` go to native JSON (`--scope user` default, `--scope project`
for `.keryx/mcp-servers.json`).

Merge order on name conflict (highest wins, replace not field-merge):

1. Native project `.keryx/mcp-servers.json` (cwd → git root, deepest)
2. Native user `mcp-servers.json`
3. Claude
4. Cursor
5. Project `.mcp.json`
6. Grok TOML

A personal disable overlay hides a server from connect/list-as-enabled
without deleting it. `keryx mcp enable|disable` writes that overlay (and
clears a sticky `enabled: false` only in the user native file, never in a
committed project file — Grok Build's enable/disable rule).

`${VAR}` and `${VAR:-default}` expand in `url`, `command`, `args`, `env`
values, and `headers` values at load time. Expanded values never appear in
doctor JSON beyond a redacted `set`/`unset` flag.

## 3. Manifest / config shape

See the schema. Informal:

```json
{
  "schemaVersion": 1,
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "enabled": true
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "enabled": true
    }
  }
}
```

A server is stdio when `command` is present, HTTP when `url` is present.
Both is a config error (`doctor` severity error; server not started).

HTTP optional fields: `headers`, `bearer_token_env_var`, `oauth` (object or
`false` to disable discovery), `startup_timeout_sec`, `tool_timeout_sec`.
Stdio optional fields: `args`, `env`, `cwd`, same timeouts.

Server names: letters, digits, hyphen, underscore. Same restriction Grok
Build documents for `grok mcp add`.

## 4. CLI / skill / TUI surface

### 4.1 The publisher surface, renamed (D-04)

`keryx mcp` no longer means "keryx is the server". That surface moves:

| was | is |
|---|---|
| `keryx mcp serve` | `keryx serve-mcp` |
| `keryx mcp install --runtime <editor>` | `keryx integrate <editor>` |
| `keryx mcp uninstall --runtime <editor>` | `keryx integrate --remove <editor>` |

Behaviour is unchanged; only the names are. Every retired spelling still runs
and prints one line naming its replacement — no removals, no broken scripts.
`src/commands/mcp.ts` keeps the implementation and gains the aliases.

### 4.2 New subcommands (this package)

| Command | Behavior |
|---|---|
| `keryx mcp list [--json]` | Merged view with source tags `(user)`, `(project)`, `(cursor)`, `(claude)`, `(mcp.json)`, `(grok)`, `(disabled)`. |
| `keryx mcp add <name> -- <command…>` | Stdio server. `--scope user\|project`. Repeatable `-e KEY=value`. |
| `keryx mcp add --transport http <name> <url>` | HTTP server. Repeatable `--header "K: V"`. |
| `keryx mcp add --transport sse <name> <url>` | Alias of http (D-06). |
| `keryx mcp remove <name> [--scope user\|project]` | Deletes native entry. Errors if the name exists only in a compat source (tell the operator to edit that file or disable). Errors if both scopes define it and `--scope` is omitted. |
| `keryx mcp enable \| disable <name>` | Personal overlay. |
| `keryx mcp doctor [name] [--json]` | Config problems + connect attempt + tool count + skipped invalid FQNs. |
| `keryx mcp auth <name>` | Interactive OAuth for a remote server. Headless: exit 1 with `needs_auth`. |

Unknown current subcommands (`list`, `add`, …) already error today, so these
are additive.

### 4.3 TUI

- `/mcp` becomes the consumer view. Modal on the existing
  `openModal` host (`src/tui/modal-host.ts`): per-server rows (name, source,
  status, tool count), Space toggles, `i` starts OAuth, `r` reloads config.
- `/mcp` stays the keryx-as-server installer (`MCP_TOOLS_COMMAND` in
  `src/tui/mcp-inspector.ts`).
- When this package is implemented, replace the Tools-tab caption
  `"keryx doesn't consume MCP servers as a client yet"` with copy that
  points at `/mcp`.

### 4.4 Model tools

Two `InteractiveTool`s appended to the interactive agent's tool list
(`AgentDeps.tools` in `src/commands/agent.ts`), not to the durable harness
`ToolRegistry` unless a later harness-run slice reuses them (out of v1
scope: v1 is `keryx shell`).

`search_tool`

- Input: `{ query: string }`
- Searches the in-memory catalog of **enabled, connected, scan-clean**
  tools by name, server, and description.
- Output: a bounded list of `{ tool_name, server, description }` where
  `tool_name` is the FQN.

`use_tool`

- Input: `{ tool_name: string, tool_input: object }`
- `tool_name` is the FQN (`linear__create_issue`).
- Looks up the catalog, calls `connection.callTool(rawName, tool_input)`
  with `tool_timeout_sec`.
- `risk` is `"destructive"` when the catalog entry was classified
  mutating/unknown; `"read"` only when the MCP tool schema is purely
  annotated read-only **and** the name/description do not match write
  verbs. Unknown ⇒ destructive. This is a fail-closed default, not a
  claim that MCP tools declare risk honestly.
- Result truncation: default 20_000 bytes (Grok's default). Spill the
  remainder to a session file; tell the model it was truncated.

System instruction: a short block listing connected server names and tool
counts, not schemas. Same reason as Grok: keep the advertised tool list
stable when catalogs change.

## 5. Data contracts

### 5.1 Runtime catalog entry

```text
{
  fqName: string,          // "github__create_issue"
  server: string,
  rawName: string,         // name on the wire
  description: string,
  inputSchema: object,
  source: "user" | "project" | "cursor" | "claude" | "mcp.json" | "grok",
  scan: "clean" | "blocked",
  connectionId: string
}
```

FQN construction: `server + "__" + rawName`, then validate
`^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$`. Failure → skip + doctor warning. Delimiter
is `__` (Grok `MCP_TOOL_NAME_DELIMITER`), not OpenCode's `_`.

### 5.2 Connection status

`connected` | `disabled` | `failed` | `needs_auth` | `connecting`

A failed server does not fail the session. Doctor and `/mcp` show the
error string; no secrets.

### 5.3 Client port (generalized)

Extend `src/mcp-client/types.ts` (or a sibling types file under
`src/mcp-servers/` that wraps it) so a connection can:

- `listTools(): Promise<McpToolDef[]>` (paginated `tools/list`)
- `callTool(name, args, opts?)` (already exists)
- `close()`

Codex-specific `onElicitation` / `onCodexEvent` stay on the Codex
connection type. User MCP servers in v1 do **not** advertise elicitation or
sampling capabilities.

HTTP: `StreamableHTTPClientTransport` from the SDK. Stdio: existing
`StdioClientTransport` path, without the Codex raw-wire tap.

### 5.4 OAuth

Remote servers without an `Authorization` header and without
`oauth: false` may start a browser OAuth flow (interactive shell only).
Tokens keyed `{serverName}:{serverUrl}` in `mcp-credentials.json`, mode
matching `writeOwnerOnlyFile`. Callback on loopback. Dynamic client
registration unless `oauth.clientId` is set. Unattended / `keryx serve`:
status `needs_auth`, no browser, no hang.

## 6. Integration points

| Seam | How this package uses it |
|---|---|
| `src/mcp-client/client.ts` | Generalize stdio connect; add HTTP; keep `connectCodexMcpClient` as the Codex specialist. |
| `src/commands/agent.ts` `AgentDeps.tools` | Append `search_tool` / `use_tool`. `executeCall` already gates on `definition.risk`. |
| `src/commands/permission-mode.ts` | No new `GatedToolRisk` value required if mutating MCP maps to existing `"destructive"` / `"read"`. Do **not** invent a parallel approval function. |
| `src/security/detect/mcp.ts` `scanMcpManifest` | Run on each server's `tools/list` result before catalog insert. |
| `src/lib/config-dir.ts` | User files and owner-only writes. |
| `src/commands/mcp.ts` | Add subcommands; do not change serve/install/uninstall. |
| `src/tui/mcp-inspector.ts` | Becomes `/integrations` (D-04); behavior unchanged. Update the "doesn't consume" caption when implemented; new `/mcps` modal is a sibling file. |
| `src/capability/` | **No new capability ceiling.** Configured servers are on when present, like search providers. MCP is not a Metaproject module flag. |
| OS sandbox | v1 stdio MCP spawn is not wrapped in `sandbox-exec`/`bwrap` unless the operator sets an explicit opt-in env (name TBD at implementation, default off). Remote HTTP is not a child process. |
| `src/harness/external/supervise-mcp.ts` | Untouched. |

Init/startup: connecting servers must not block the first prompt. Handshake
runs in the background (Grok: session is not blocked for non-MCP work).
`search_tool` on a still-connecting catalog returns what is ready plus a
line that some servers are still starting. Parallel handshakes are capped
at 8 (Grok Build's constant); the constant is named in code, not magic.

Subagents (`spawn_subagent`): v1 does **not** inherit MCP connections into
children. Children keep today's builtin tool set. Inheritance (`all` /
`none` / named) is a named follow-up; Grok Build has it, keryx subagent
tool lists are assembled in
`src/harness/tool/builtin/spawn-subagent-tool.ts` and must not silently
grow.

## 7. Acceptance criteria

- **AC1 Config load.** Given a user `mcp-servers.json` and a project
  `.keryx/mcp-servers.json` that both define `github`, only the project
  entry is connected. Verified by unit test on the merge function.
- **AC2 Stdio handshake.** `keryx mcp add filesystem -- npx -y
  @modelcontextprotocol/server-filesystem <dir>` then `doctor filesystem`
  reports `connected` and a non-zero tool count against a real process.
  Flag-gated live test (`KERYX_ALLOW_REAL_SUBPROCESS=1`), excluded from CI,
  matching `keryx-mcp-client`.
- **AC3 HTTP handshake.** Connecting to a local mock streamable-HTTP MCP
  server lists tools. No live third-party network in CI.
- **AC4 FQN + skip.** A tool whose qualified name fails the 64-char regex
  is omitted from the catalog and appears in `doctor` as skipped.
- **AC5 Stable tool list.** After N MCP tools are connected, the
  interactive agent's advertised definitions include `search_tool` and
  `use_tool` and do **not** include those N FQNs.
- **AC6 Round-trip.** `search_tool` with a query matching a connected
  tool returns its FQN; `use_tool` with that FQN performs `tools/call` and
  returns content (fixture MCP server, no network).
- **AC7 Truncation.** A tool result larger than the cap is truncated in
  the model-visible output and the test asserts the cap constant.
- **AC8 Publisher renamed, nothing broken.** `keryx serve-mcp` and
  `keryx integrate` carry the previous `mcp serve` / `install` / `uninstall`
  behaviour, asserted by the existing tests retargeted at the new names. Each
  retired spelling still runs and prints its replacement exactly once.
  Superseded text: "Existing `mcp serve` / `install` / `uninstall`
  tests pass unmodified. `keryx mcp list` does not start `serve`.
- **AC9 `/mcps` is never registered.** `agent-commands.confusable.test.ts`
  fails the build on a slash command differing from another only by a trailing
  `s`, unless declared with a written reason. `/mcp` resolves to the consumer
  view; the installer view is `/integrations`.
- **AC10 Compat.** A fixture `.cursor/mcp.json` with one stdio server
  appears in `list` tagged `(cursor)` without being copied into native
  JSON.
- **AC11 Approval.** `use_tool` on a write-shaped MCP tool in `ask` mode
  calls `resolveApprovalDecision` / `requestApproval`. Under `trust`, a
  classifier-marked destructive call still asks. Headless
  (`requestApproval` undefined) fails closed.
- **AC12 Scan.** A fixture tool whose description matches
  `POISONING_PATTERNS` in `src/security/detect/mcp.ts` is `scan: "blocked"`
  and absent from `search_tool` results.
- **AC13 Isolation.** `src/harness/external/supervise-mcp.test.ts` and
  `src/mcp-client/` Codex fixtures still pass. This package's catalog does
  not register `codex mcp-server` as a user server.
- **AC14 Auth store.** OAuth tokens are written only via
  `writeOwnerOnlyFile` under `keryxConfigDir`. No `process.env` reads of
  vendor CLI credential paths. `${SECRET}` in config is expanded at load
  and not echoed by `list --json`.
- **AC15 Partial failure.** Two servers configured, one command missing:
  the good server is `connected`, the bad one `failed`, session starts.
- **AC16 Disable.** `keryx mcp disable <name>` leaves the native file
  intact, status `disabled`, no child process.
- **AC17 Caption.** After implementation, the Tools-tab string no longer
  claims keryx does not consume MCP servers.
- **AC18 No new capability flag.** `CAPABILITY_REGISTRY` in
  `src/capability/registry.ts` is not extended for this package.
- **AC19 Env expansion.** `headers.Authorization = "Bearer ${TOKEN}"`
  with `TOKEN` set reaches the HTTP transport; with `TOKEN` unset, doctor
  reports the variable missing and the server is `failed` or `needs_auth`,
  not a leaked empty bearer.
- **AC20 Unattended OAuth.** `keryx mcp auth` in a non-TTY process exits
  non-zero without opening a browser.

## 8. Implementation phases

See [implementation-plan.md](implementation-plan.md). ACs by phase:

| Phase | ACs |
|---|---|
| P0 config + stdio + builtins | 1, 2, 4, 5, 6, 7, 11, 15, 16, 18 |
| P1 HTTP + CLI | 3, 8, 19 |
| P2 TUI `/mcp` (consumer) + `/integrations` | 9, 17 |
| P3 OAuth + compat | 10, 14, 20 |
| P4 scan + doctor polish | 12, 13 |

All phases are in scope for this version. Shipping P0 alone is a valid
intermediate PR if the README status stays honest (`partial`).

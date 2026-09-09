# Keryx MCP Servers — Implementation Plan
Version: 0.1.0

Phased order for implementers. Each phase is a mergeable slice with honest
README status. Do not mark the package **implemented** until P0–P4 ACs in
[specification.md](specification.md) §7 are green.

This is not runtime code.

## Constraints carried into every phase

- Lazy SDK import only; no static `@modelcontextprotocol/sdk` in new files
  that `keryx --help` would load.
- No writes to `.metaproject/core/mcp/mcp.config.json`, `.cursor/mcp.json`,
  or Claude configs except the existing installer.
- `connectCodexMcpClient` / `gatedSuperviseCodexMcpRun` stay green.
- `keryx mcp` with no args still serves.
- Tests: unit + fixture MCP server; live stdio only behind
  `KERYX_ALLOW_REAL_SUBPROCESS=1`.

## P0 — Config, stdio, `search_tool` / `use_tool`

**Goal.** A user JSON file and a stdio server are enough for `keryx shell`
to search and call one MCP tool.

Work:

1. Config load/merge (`src/mcp-servers/config.ts`) against the schema.
   Disable overlay. `${VAR}` expansion. Project walk cwd → git root.
2. Generalize `src/mcp-client/` with `listTools` on a **generic** stdio
   connection (no Codex tap). Keep Codex function names for the specialist.
3. Connection manager: start enabled stdio servers in the background, cap
   concurrency (Grok uses 8; start with a small constant, document it).
4. Catalog: FQN, regex skip, in-memory map.
5. `search_tool` + `use_tool` as `InteractiveTool`s; wire into the shell
   tool list next to existing builtins.
6. Approval: `use_tool` risk mapping (D-05); tests with fake
   `requestApproval`.
7. CLI `list` / `add` (stdio) / `remove` / `enable` / `disable` writing
   native JSON only.
8. CLI `doctor [name]` for stdio (AC2): config problems, connect result,
   tool count, skipped FQNs. HTTP-only doctor fields wait for P1.

ACs: 1, 2, 4, 5, 6, 7, 11, 15, 16, 18.

**Exit.** README status may say `partial (P0)` if shipped alone.

## P1 — HTTP + remaining CLI

**Goal.** Remote `url` servers; stdio `doctor` already exists from P0.

Work:

1. `StreamableHTTPClientTransport` in the generic client.
2. `keryx mcp add --transport http|sse`.
3. Extend `doctor` with HTTP connectivity (stdio doctor already in P0).
4. Headers + `bearer_token_env_var` + expansion (AC19).
5. Mock HTTP MCP server in tests (no live Linear/Sentry).

ACs: 3, 8, 19.

## P2 — TUI `/mcps`

**Goal.** Operator can see and toggle consumed servers without the CLI.

Work:

1. New modal sibling of `mcp-inspector.ts` (do not overload it).
2. Slash `/mcps` / `/mcp-servers`.
3. Replace the Tools-tab "doesn't consume" caption (AC17).
4. Confirm `/mcp` installer tests still pass (AC9).

ACs: 9, 17.

## P3 — OAuth + compat import

**Goal.** Hosted servers and "I already configured this in Cursor."

Work:

1. Compat readers: Cursor, Claude, `.mcp.json`, Grok TOML. Source tags.
   Read-only (D-09).
2. OAuth: loopback callback, `mcp-credentials.json` via
   `writeOwnerOnlyFile`, `keryx mcp auth`.
3. Unattended / non-TTY fail closed (AC20).
4. Never read vendor CLI credential files (AC14).

ACs: 10, 14, 20.

## P4 — Scan, doctor polish, isolation proofs

**Goal.** Poisoned tools never reach `search_tool`; Codex path untouched.

Work:

1. `scanMcpManifest` on `tools/list` before catalog insert (AC12).
2. Doctor shows skipped FQNs, scan blocks, source tags.
3. Regression: Codex elicitation fixtures + `supervise-mcp` tests (AC13).
4. Truncation already in P0; confirm doctor documents the cap.

ACs: 12, 13 (and any P0 leftovers).

## Suggested code layout (non-normative)

```text
src/mcp-servers/
  config.ts          # load, merge, expand, disable overlay
  compat.ts          # cursor / claude / mcp.json / grok toml readers
  manager.ts         # connect, status, catalog
  search-tool.ts     # InteractiveTool search_tool
  use-tool.ts        # InteractiveTool use_tool
  doctor.ts
  oauth.ts
src/mcp-client/      # add generic stdio+HTTP listTools; keep Codex
src/commands/mcp.ts  # additive subcommands
src/tui/mcps-inspector.ts
```

## Out of this plan (named follow-ups)

- Subagent MCP inheritance (D-11).
- `tools/list_changed` live re-index.
- MCP resources/prompts as model tools.
- OS-sandbox wrap for stdio MCP (D-08 opt-in later).
- Harness-run (`keryx harness exec`) MCP, not only `keryx shell`.

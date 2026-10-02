# Keryx MCP Servers — Brainstorm
Version: 0.1.0

Reference designs studied for this package, and the behaviours Keryx
adopted. Other harnesses are contrast, not a menu of features to union.

Sources are trees under `~/sandbox/forks/` plus keryx `main` as of this
package. This is not a claim those trees match upstream HEAD tomorrow.

## Origin

A live question ("does keryx consume third-party MCP?") against
`src/mcp`, `src/mcp-client`, and `/mcp` showed two existing directions
and not the third:

1. **Inbound.** `keryx serve-mcp` / `keryx integrate` — keryx is the
   server, editors are clients (`src/mcp/`, `src/mcp/client-config.ts`).
2. **Codex elicitation.** `src/mcp-client/` + `gatedSuperviseCodexMcpRun`
   — keryx is the client of one keryx-spawned `codex mcp-server`.
3. **Missing.** User-configured GitHub/Playwright/Linear/Context7 in
   `keryx shell`.

`keryx-mcp-client` README non-goals already named (3). The TUI caption in
`src/tui/mcp-inspector.ts` still says keryx does not consume MCP servers.

## Adopted behaviours

Keryx's own decisions for the consumer surface:

- Native config sections per server; project replaces user on same name.
- Stdio (`command`/`args`/`env`) and remote (`url`/`headers`).
- FQN `server__tool`, 64-character cross-provider regex, skip invalid.
- Model does **not** see MCP tools as first-class functions.
  `search_tool` + `use_tool`; system reminder is counts, not schemas.
- CLI `mcp add|list|remove|enable|disable|doctor`.
- A TUI consumer view (`/mcp`, see D-04).
- OAuth tokens in an owner-only home file.
- Compat: Claude, Cursor, `.mcp.json`, and Grok `[mcp_servers.*]` TOML.
- `${VAR}` expansion.
- Output byte cap (20_000).
- Failed server ≠ failed session.

Deliberately **not** adopted in v1, with reason:

| Option | Why not v1 |
|---|---|
| TOML as the native config format | Keryx user config is JSON via `keryxConfigDir`; TOML is only read as a compat source. |
| A second MCP library | Keryx already lazy-loads `@modelcontextprotocol/sdk`. |
| SSE as a distinct transport | Kept as an **alias** of streamable HTTP, not a second client. |
| A vendor-managed gateway catalog | Vendor-specific. |
| MCP Apps UI / icons | Not in keryx TUI scope. |
| Subagent MCP inheritance | Child tool lists are explicit; see D-11. |
| Parsing stdio `cwd` and then dropping it | If we parse `cwd`, we honor it for local stdio. |
| Plugin `.mcp.json` marketplace | No marketplace (README non-goal). |

Also not built ahead of need: prompts, sampling, elicitation from user
servers, roots, live `tools/list_changed` re-index of the model catalog.

## Per-tool registration (contrast)

Another agent harness studied registers every MCP tool on the model as
`sanitize(server)_sanitize(tool)`, turns resources into three synthetic tools
and prompts into slash commands, and has no `mcp.json` / `mcpServers` import.

Useful: HTTP-then-SSE fallback; status enum including `needs_auth`;
`tools/list_changed` cache refresh. Rejected as v1 model bridge (D-01).

## Codex CLI (contrast)

`config.toml` `[mcp_servers.*]`; stdio + streamable HTTP; names
`mcp__{server}`; OAuth; elicitation as a **client of other servers**
(different from keryx-mcp-client, which is keryx as client of *Codex's*
server). No user-facing SSE. Not the parity target.

## Others

| Harness | Client? | Note |
|---|---|---|
| Gemini CLI | yes | `mcp_{alias}_{tool}` — underscore FQNs break on `_` in names. Avoid. |

## Architecture question (resolved)

Should keryx register MCP tools natively (per-tool registration) or behind two builtins?
**Two builtins.** Recorded as D-01. The interactive agent already has a
closed `InteractiveTool[]`; a two-tool bridge is the smallest seam that
still matches the requested product.

Should this extend `keryx-mcp-client` in place? **No.** Recorded as D-02.

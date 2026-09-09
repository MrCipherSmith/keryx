# Keryx MCP Servers — Brainstorm
Version: 0.1.0

Reference designs studied for this package. Parity target is Grok Build;
other harnesses are contrast, not a menu of features to union.

Sources are trees under `~/sandbox/forks/` plus keryx `main` as of this
package. This is not a claim those trees match upstream HEAD tomorrow.

## Origin

A live question ("does keryx consume third-party MCP?") against
`src/mcp`, `src/mcp-client`, and `/mcp` showed two existing directions
and not the third:

1. **Inbound.** `keryx mcp serve` / `keryx mcp install` — keryx is the
   server, editors are clients (`src/mcp/`, `src/mcp/client-config.ts`).
2. **Codex elicitation.** `src/mcp-client/` + `gatedSuperviseCodexMcpRun`
   — keryx is the client of one keryx-spawned `codex mcp-server`.
3. **Missing.** User-configured GitHub/Playwright/Linear/Context7 in
   `keryx shell`.

`keryx-mcp-client` README non-goals already named (3). The TUI caption in
`src/tui/mcp-inspector.ts` still says keryx does not consume MCP servers.

## Grok Build (parity target)

Inspected: `crates/codegen/xai-grok-mcp/`,
`crates/codegen/xai-grok-config-types/src/mcp.rs`,
`crates/codegen/xai-grok-pager/docs/user-guide/07-mcp-servers.md`,
`search_tool` / `use_tool` implementations.

What keryx copies:

- Native config sections per server; project replaces user on same name.
- Stdio (`command`/`args`/`env`) and remote (`url`/`headers`).
- FQN `server__tool`, 64-character cross-provider regex, skip invalid.
- Model does **not** see MCP tools as first-class functions.
  `search_tool` + `use_tool`; system reminder is counts, not schemas.
- CLI `mcp add|list|remove|enable|disable|doctor`.
- TUI `/mcps`.
- OAuth tokens in an owner-only home file.
- Compat: Claude, Cursor, `.mcp.json`.
- `${VAR}` expansion.
- Output byte cap (20_000).
- Failed server ≠ failed session.

What keryx does **not** copy, with reason:

| Grok detail | Why not v1 |
|---|---|
| TOML `~/.grok/config.toml` | Keryx user config is JSON via `keryxConfigDir`. |
| `rmcp` 2.1 + quarantined reqwest 0.13 | Keryx already lazy-loads `@modelcontextprotocol/sdk`. |
| SSE as a distinct ACP tag that still uses HTTP | Copied as an **alias**, not a second client. |
| Gateway `managed_gateway:` catalog | xAI-specific. |
| MCP Apps UI / icons | Not in keryx TUI scope. |
| Subagent `mcpInheritance` | Child tool lists are explicit; see D-11. |
| `cwd` on stdio that ACP then drops | If we parse `cwd`, we honor it for local stdio. |
| Plugin `.mcp.json` marketplace | No marketplace (README non-goal). |

Honest Grok gaps we also do not "fix ahead": prompts, sampling,
elicitation from user servers, roots, live `tools/list_changed` re-index
of the model catalog. Those are not shipped as model features there.

## OpenCode (contrast)

Inspected: `packages/opencode/src/mcp/index.ts`, `catalog.ts`,
`packages/core/src/v1/config/mcp.ts`.

- Config key `mcp` in `opencode.json`, `type: "local" | "remote"`.
- Tools registered on the model as `sanitize(server)_sanitize(tool)`.
- Resources become three synthetic tools; prompts become slash commands.
- Sampling/elicitation/tasks capabilities commented out.
- OAuth callback `127.0.0.1:19876`.
- No `mcp.json` / `mcpServers` import.

Useful: HTTP-then-SSE fallback; status enum including `needs_auth`;
`tools/list_changed` cache refresh. Rejected as v1 model bridge (D-01).

## Codex CLI (contrast)

`config.toml` `[mcp_servers.*]`; stdio + streamable HTTP; names
`mcp__{server}`; OAuth; elicitation as a **client of other servers**
(different from keryx-mcp-client, which is keryx as client of *Codex's*
server). No user-facing SSE. Not the parity target.

## Others (one line each)

| Harness | Client? | Note |
|---|---|---|
| Cline | yes | `mcpServers`, stdio/SSE/HTTP, `{server}__{tool}`, OAuth. |
| Gemini CLI | yes | `mcp_{alias}_{tool}` — underscore FQNs break on `_` in names. Avoid. |
| Qwen Code | yes | Gemini fork; `mcp__server__tool`. |
| Crush | yes | `mcp_{server}_{tool}`, stdio/HTTP/SSE, OAuth. |
| Continue | yes, agent mode | websocket extra; OAuth SSE-only. |
| DeepSeek harness | yes, plugin | stdio + HTTP, `mcp__server__raw`, no OAuth. |
| Kilocode | yes | OpenCode `mcp` map. |
| Helyx | no | *Is* an MCP server for Claude. Same confusion keryx already has. |
| Aider | no | No MCP. |

## Architecture question (resolved)

Should keryx register MCP tools natively (OpenCode) or behind two builtins
(Grok)? **Grok.** Recorded as D-01. The interactive agent already has a
closed `InteractiveTool[]`; a two-tool bridge is the smallest seam that
still matches the requested product.

Should this extend `keryx-mcp-client` in place? **No.** Recorded as D-02.

# Keryx MCP Servers — PRD
Version: 0.1.0

## Problem

Six of the seven peer coding-agent harnesses profiled in
`docs/analysis/keryx-harness-comparison/2026-08-20` already let the operator
add GitHub, Linear, Playwright, Context7, or any other MCP server and have
those tools available in the agent loop. Grok Build is the reference this
package copies: `~/.grok/config.toml` `[mcp_servers.<name>]`, stdio and
remote HTTP, `server__tool` names, model access through `search_tool` /
`use_tool`, `grok mcp add|list|doctor`, OAuth, and compat import of
Claude/Cursor/`.mcp.json`.

Keryx does not. It **serves** Metaproject over MCP so *other* agents can use
keryx (`keryx serve-mcp`, `keryx integrate`). Its own shell cannot consume
a server the operator configured. The TUI `/mcp` tab is easy to misread as
the opposite: it installs keryx into an editor, and the caption in
`src/tui/mcp-inspector.ts` still says so.

`keryx-mcp-client` (flow 182) closed a different gap: talk to `codex
mcp-server` as a client so elicitation/approval can flow back into
`resolveApprovalDecision`. Its README non-goal is explicit: no
"browse and consume any MCP server" UX. That non-goal is now the product
request.

The operator consequence is concrete. A keryx session cannot call
Playwright, GitHub, Linear, or Context7 the way a Grok Build session can,
even when those servers are already in `.cursor/mcp.json` on the same
machine.

## Goal

Make `keryx shell` consume user-configured third-party MCP servers with
**Grok Build behavioral parity**:

1. The operator adds a stdio or HTTP server (CLI, TUI, or a committed
   project file).
2. Keryx starts/connects it, lists tools, namespaces them `server__tool`.
3. The model's advertised tool list stays stable: it searches with
   `search_tool` and calls with `use_tool`.
4. Remote servers can authenticate with headers, env, or OAuth.
5. Existing editor MCP configs can be imported rather than retyped.
6. Existing keryx-as-server and Codex-elicitation paths keep working.

Parity is behavioral, not a TOML clone and not a port of `rmcp`. Keryx stays
on `@modelcontextprotocol/sdk` and native JSON config next to
`search-providers.json`.

## Users

- An operator running `keryx shell` who already has MCP servers in Cursor or
  Claude and expects keryx to use them.
- An operator who wants a project-local Playwright/filesystem/GitHub server
  committed for the team.
- A future implementer of this package, who must not confuse it with
  `src/mcp/` (inbound server) or `src/mcp-client/` (Codex elicitation).

## Requirements

1. **Config.** User-global and project-scoped server lists. Same name:
   project replaces user (no field merge), matching Grok Build.
2. **Stdio transport.** Spawn `command` + `args` + `env` + optional `cwd`,
   MCP handshake, `tools/list` (paginated).
3. **HTTP transport.** Streamable HTTP to `url` with optional headers.
   Config `type = "sse"` or a URL ending in `/sse` is the same HTTP client
   (Grok Build runtime fact: SSE is a label, not a second stack).
4. **Naming.** Internal FQNs are `server__tool`. Invalid names
   (`^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$` on the qualified name, max 64) are
   skipped and reported, not registered — Grok Build's cross-provider cap.
5. **Model bridge.** Do not add MCP tools to the provider tool list. Add
   exactly two builtins: `search_tool` (search the catalog) and `use_tool`
   (`{ tool_name, tool_input }` → `tools/call`). A short system reminder
   lists connected server names/counts, not every schema.
6. **CLI.** `keryx mcp add|list|remove|enable|disable|doctor|auth` without
   breaking `serve|install|uninstall`. Default `keryx mcp` remains serve.
7. **TUI.** `/mcp` lists/toggles/diagnoses consumed servers. `/integrations` becomes
   the installer of keryx-as-server. The misleading "keryx doesn't consume
   MCP servers" caption is updated only when this package is implemented.
8. **Auth.** Stdio `env`; HTTP `headers` and `bearer_token_env_var`;
   `${VAR}` / `${VAR:-default}` expansion at load; remote OAuth with tokens
   in an owner-only file next to `search-credentials.json`.
9. **Compat.** Read Cursor `.cursor/mcp.json`, Claude `.mcp.json` /
   `~/.claude.json` `mcpServers`, project `.mcp.json`, and Grok
   `[mcp_servers.*]` TOML. Native keryx JSON wins on name conflict.
10. **Approval.** `use_tool` is not `risk: "read"`. It goes through
    `executeCall` → `resolveApprovalDecision`. Credential-touching and
    destructive MCP calls still ask under `trust`; `auto` keeps the
    existing credentials / SAC-review floors.
11. **Security scan.** Discovered tool names/descriptions pass
    `scanMcpManifest` (`src/security/detect/mcp.ts`) before they enter the
    searchable catalog. Findings are visible; poisoning/line-jumping tools
    are not offered to the model.
12. **Failure.** A single server that fails to start is `failed` with a
    named error. Other servers still connect. The session does not hang on
    MCP init.
13. **Lifecycle.** Enable/disable without deleting config. Doctor reports
    config problems and connectivity. Output of `use_tool` is truncated
    with a documented byte cap (Grok default 20_000 bytes).
14. **Boundaries.** `src/mcp/` (inbound) and `gatedSuperviseCodexMcpRun`
    stay. This package must not route Codex elicitation through
    `search_tool`.
15. **No new MCP library.** Reuse `@modelcontextprotocol/sdk`, already an
    optional dependency used by `src/mcp/server.ts` and `src/mcp-client/`.

## Success Criteria

- A live stdio server (e.g. `@modelcontextprotocol/server-filesystem`) added
  with `keryx mcp add`, visible in `keryx mcp list` and `/mcp`, searchable
  via `search_tool`, callable via `use_tool` in `keryx shell`.
- A live remote HTTP server reachable with a header or completed OAuth
  round-trip, same model path.
- Cursor/Claude `.mcp.json` servers appear in `keryx mcp list` without being
  copied by hand, tagged with their source.
- `keryx serve-mcp` and `keryx integrate` carry the previous behavior (existing
  tests still pass).
- Codex elicitation fixtures and `gatedSuperviseCodexMcpRun` tests still
  pass unmodified.
- The provider tool list for a session with N MCP tools still contains the
  same builtin names plus `search_tool` and `use_tool` — not N extra tools.
- A tool whose description matches the existing MCP poisoning detector is
  absent from `search_tool` results.

## Risks

- **`/mcp` vs `/mcps` confusion — resolved, not mitigated.** The installer tab
  already looks like a consumer, which is evidence the name was wrong rather
  than a caption to fix. `/mcps` is not introduced: `/mcp` becomes the consumer
  view and the installer moves to `/integrations` (D-04). Enforced by
  `src/commands/agent-commands.confusable.test.ts`, which fails the build on a
  slash command differing from another only by a trailing `s`.
- **Scope creep to a full MCP client.** Sampling, elicitation, resources as
  model tools, MCP Apps. Grok Build itself treats most of these as gaps.
  Mitigated by copying Grok's *shipped* surface, not the MCP spec.
- **OAuth and headless.** Grok's OAuth is browser-based and blocks headless
  until login. Keryx `unattended` / `keryx serve` must fail closed (named
  `needs_auth`), never hang. Mitigated by treating OAuth as interactive-only
  in v1; headers/env remain the headless path.
- **Stdio sandbox.** Grok does not special-case MCP children; they inherit
  the agent process. Keryx's OS sandbox defaults differ for harness vs
  `shell_exec`. A contained stdio MCP that cannot reach npm cache or the
  network looks "down". Mitigated by D-08: v1 stdio MCP spawn is
  unsandboxed unless the operator opts in; remote HTTP is out of the FS
  sandbox by construction.
- **64-character FQN cap.** Grok silently skips invalid names. Operators
  will think a server is "up" with zero tools. Mitigated by doctor + `/mcp`
  showing skipped names.
- **Credential store vs D-01.** MCP OAuth tokens are easy to confuse with
  provider/CLI logins. Mitigated by storing them like search credentials,
  never reading `~/.codex` / Claude credential files.

## Recommendation

Specify and implement this as a **new** requirements package and a **new**
`src/mcp-servers/` module. Do not reopen `keryx-mcp-client`'s Codex
elicitation ACs. Generalize `src/mcp-client/` only as far as transports
(`listTools`, HTTP) so both consumers share one SDK load path.

Copy Grok Build's model bridge (`search_tool` / `use_tool`) rather than
OpenCode's per-tool registration: keryx already cares about a stable
interactive tool list (`InteractiveTool[]` in `AgentDeps`), and Grok's
reason — KV-cache stability when MCP catalogs change — applies here.

Proceed in the phases in [implementation-plan.md](implementation-plan.md).
P0 (config + stdio + the two builtins) is the first falsifiable slice.

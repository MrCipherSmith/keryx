# MCP Module

Version: 0.1.0
Type: module
Status: active

## Summary

Exposes read-only Metaproject services (code graph, security, flow status,
memory, health, wiki, standard) over the Model Context Protocol (MCP). A thin
protocol adapter — it defines no new module logic.

## Commands

- `keryx serve-mcp` — stdio JSON-RPC MCP server (default transport).
- `keryx serve-mcp --http` — isolated HTTP/SSE opt-in (localhost only;
  requires `http.enabled=true` in this module's manifest entry).
- `keryx serve-mcp --cwd <project-root>` — expose a specific project,
  independent of the MCP client's launch directory.
- `keryx integrate <cursor|claude|generic|all> [--dry-run]` —
  wire this project into an editor/agent: writes a project-local client
  config (cursor → `.cursor/mcp.json`, claude → `.mcp.json`) and sets
  `modules.mcp.enabled=true`. `--dry-run` prints the change without
  writing anything. This is the command to run when a user asks to
  "connect" or "enable" MCP for this project — it is the full, real setup
  step; hand-editing a client config file directly is unnecessary and
  skips setting `modules.mcp.enabled`.
- `keryx integrate --remove <cursor|claude|generic|all>` — remove the
  managed client config again.

## Session trust (consumer side)

Separate from serving: when keryx *calls* another server's tools through
`use_tool`, `trust` mode can grant one exact tool for the interactive session.
A tool whose live catalog entry has `destructiveHint: true` is never offered the
grant, and a grant already held is dropped on the next call once the hint turns
`true`; an absent or `false` hint changes nothing. `/mcp trust list` and
`/mcp trust revoke <server__tool>|all` show and remove grants, and `/new`,
`/clear` and resume clear them. Guide: `docs/docs/guides/permission-modes.md`.

## Notes

- Requires the optional `@modelcontextprotocol/sdk`. Disabled by default.
- Every tool result is routed through the security `redactRaw` seam before
  transport.
- Tool/resource exposure is filtered by the manifest (`expose.modules`); a
  disabled module is hidden from `tools/list` and `resources/list`.

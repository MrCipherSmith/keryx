# MCP Module

Version: 0.1.0
Type: module
Status: active

## Summary

Exposes read-only Metaproject services (code graph, security, flow status,
memory, health, wiki, standard) over the Model Context Protocol (MCP). A thin
protocol adapter — it defines no new module logic.

## Commands

- `keryx mcp serve` — stdio JSON-RPC MCP server (default transport).
- `keryx mcp serve --http` — isolated HTTP/SSE opt-in (localhost only;
  requires `http.enabled=true` in this module's manifest entry).
- `keryx mcp serve --cwd <project-root>` — expose a specific project,
  independent of the MCP client's launch directory.
- `keryx mcp install --runtime <cursor|claude|generic|all> [--dry-run]` —
  wire this project into an editor/agent: writes a project-local client
  config (cursor → `.cursor/mcp.json`, claude → `.mcp.json`) and sets
  `modules.mcp.enabled=true`. `--dry-run` prints the change without
  writing anything. This is the command to run when a user asks to
  "connect" or "enable" MCP for this project — it is the full, real setup
  step; hand-editing a client config file directly is unnecessary and
  skips setting `modules.mcp.enabled`.
- `keryx mcp uninstall --runtime <cursor|claude|generic|all>` — remove the
  managed client config again.

## Notes

- Requires the optional `@modelcontextprotocol/sdk`. Disabled by default.
- Every tool result is routed through the security `redactRaw` seam before
  transport.
- Tool/resource exposure is filtered by the manifest (`expose.modules`); a
  disabled module is hidden from `tools/list` and `resources/list`.

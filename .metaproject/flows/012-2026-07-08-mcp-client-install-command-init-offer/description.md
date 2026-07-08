# Implement: `mcp install/uninstall` client-config command + init MCP offer

Status: formalized
Source: user request (channel) — make wiring the MCP server into an editor/agent one command; offer it at init; write client settings automatically, project-scoped.

## Problem

Today enabling the Block A MCP server for an editor is manual: set `modules.mcp.enabled=true`,
install the optional SDK, and hand-edit the client's MCP config (`.cursor/mcp.json`, `.mcp.json`).
Users want (1) a dedicated command that writes the client config automatically, merge-safely,
project-scoped; (2) `init` to offer enabling MCP; (3) it to land in the editor settings for them.
The pattern already exists: E5's multi-runtime hook installer (`RuntimeHook` registry +
`installRuntimeHooks`/`uninstallRuntimeHooks`, managed-sentinel, merge-safe, idempotent, targeted
uninstall). Reuse that shape for MCP client configs.

## Expected Outcome

- **New command** `gd-metapro mcp install [--runtime <cursor|claude|generic|all>] [--dry-run]`
  and `gd-metapro mcp uninstall [--runtime ...]`:
  - Merge-safely writes the project-local MCP client config, preserving all existing servers/keys,
    idempotent on re-run, with a managed sentinel so `uninstall` removes ONLY the gd-metapro entry.
    Targets: `cursor` → `.cursor/mcp.json`, `claude` → `.mcp.json`; `generic` → prints a ready
    JSON snippet (no file). The managed server entry is
    `mcpServers.gd-metapro = { command: "gd-metapro", args: ["mcp","serve"] }`.
  - On install, sets `modules.mcp.enabled=true` in `.metaproject/metaproject.json` (so the server
    actually exposes tools/resources), preserving the rest of the manifest.
  - Detects whether `@modelcontextprotocol/sdk` is importable; if not, prints an actionable hint to
    install it (does NOT auto-install — no network/package changes without the user).
  - `--dry-run` prints the planned change without writing; validates the rendered config.
- **`init` offer:** a new interactive question "Enable the MCP server (expose this project to
  Cursor / Claude Code)?" default **No**; honored non-interactively by the existing `--mcp/--no-mcp`
  flags (default off). When enabled, `init` sets `modules.mcp.enabled=true` and (interactive only)
  offers to write a client config for a chosen runtime; `--yes` never writes a client config.
- **Golden rule:** with the default answer (No) and no `mcp install` run, `init` output and every
  command are byte-identical to today; `modules.mcp` stays off; no client config is written; no
  network. `dependencies` stays `{}`. The installer never clobbers user keys, is idempotent, and
  targeted-uninstall leaves other servers + user content intact.

## Out of Scope

- Windsurf (its MCP config is global `~/.codeium/...`, not project-scoped — would break the
  "only within the project" guarantee; add later separately).
- Auto-installing the MCP SDK or opening any network connection.
- Changing the MCP server itself (Block A) or the security hooks installer (E5) — only reuse its pattern.

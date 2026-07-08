# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `gd-metapro flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `gd-metapro flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `gd-metapro mcp install --runtime cursor` writes `.cursor/mcp.json` and `--runtime claude` writes `.mcp.json` at the project root, adding `mcpServers.gd-metapro = { command:"gd-metapro", args:["mcp","serve"] }`; `--runtime generic` prints a ready JSON snippet and writes no file; `--runtime all` targets cursor+claude. The written entry is marked with a managed sentinel.
- AC2: Merge-safe: installing into a config that already has other `mcpServers` and unrelated top-level keys preserves every pre-existing server and key; a re-install is idempotent (no duplicate/second gd-metapro entry, no diff on the second run).
- AC3: `gd-metapro mcp uninstall --runtime <id>` removes ONLY the managed gd-metapro entry (and the sentinel) and leaves other servers + user content intact; uninstalling when nothing is installed is a no-op.
- AC4: `mcp install` sets `modules.mcp.enabled=true` in `.metaproject/metaproject.json` while preserving the rest of the manifest (malformed manifest ⇒ no-op with a message, never a throw); `--dry-run` prints the planned change and writes NOTHING (no client file, no manifest change).
- AC5: `mcp install` probes whether `@modelcontextprotocol/sdk` is importable and, when absent, prints an actionable install hint (`bun add @modelcontextprotocol/sdk`); it never auto-installs and never opens a network connection.
- AC6: `init` presents an interactive question offering the MCP server, default **No**; answering No (and every `--yes`/non-interactive run) leaves `modules.mcp` disabled and writes no client config, so the `init` manifest + output are byte-identical to today; the `--mcp`/`--no-mcp` flags set it non-interactively; answering Yes sets `modules.mcp.enabled=true` (and, interactively, offers to write a chosen runtime's client config).
- AC7: `bun run check` (typecheck + full suite) passes with the 352 pre-existing tests unchanged; `package.json` `dependencies` stays empty; a no-network assertion holds for `mcp install` (no socket opened); README + `docs/docs/cli-reference.md` document `mcp install|uninstall` and the init offer.

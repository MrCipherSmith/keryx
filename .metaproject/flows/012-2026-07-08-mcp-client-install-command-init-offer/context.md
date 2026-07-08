# Context

Collected deterministically by `gd-metapro flow init` at 2026-07-08T08:19:16.824Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `gd-metapro gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-07-07T13:53:28.505Z)
- refresh: `gd-metapro health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security

## Agent Findings

### Reuse this proven pattern (E5 multi-runtime hook installer)
- `src/security/agent-hooks/runtimes.ts` — `RuntimeHook` interface `{ id, settingsPath(root), merge(settings), strip(settings), validate(settings) }`; managed sentinel via `MANAGED_KEY = "_gdMetaproManaged"` + a sentinel string (`isManagedGroup`, `setSentinel`/`clearSentinel`); `RUNTIME_HOOKS[]` registry; per-runtime merge (`claudeMerge`/`flatMerge`). This is the EXACT merge-safe/idempotent/targeted-uninstall shape to mirror for MCP client configs — build a sibling `McpClientRuntime` registry, do NOT entangle with security hooks.
- `src/security/agent-hooks.ts` — `installRuntimeHooks(projectRoot, ids)` / `uninstallRuntimeHooks(...)` / `resolveRuntimes(ids)` — the install/uninstall orchestration (read JSON-or-empty → merge/strip → validate → write). Mirror this for MCP.
- `src/commands/security.ts` L494+ (`case "hooks"`) — `security hooks <install|uninstall> --runtime <id|all>[,...]` CLI wiring, including comma-list + `all`. Mirror for `mcp install|uninstall`.

### MCP command + server (Block A, landed)
- `src/commands/mcp.ts` — `mcpCommand(args, cwd)`; currently handles `serve`/`--http`/help. ADD `install`/`uninstall` subcommands here (+ route already in `cli.ts`).
- `src/mcp/discovery.ts` — reads `modules.mcp.enabled`. `src/commands/init.ts` (`buildMcpModuleEntry`, capability wiring) — how `--mcp` writes the `modules.mcp` manifest entry. Install must set `modules.mcp.enabled=true` merge-safely.

### init interactive pattern (mirror exactly)
- `src/commands/init.ts` — uses `confirm(prompt, default)` + `choice(...)` from `src/lib/prompt`; each module gates on `options.<noFlag>` else `!options.yes` → `confirm(...)`. Manifest is written from computed `enable*` booleans. `--yes` = non-interactive (accept defaults, NO client-config writes). Add an MCP question mirroring this (default No), and `--mcp/--no-mcp` already exist as flags.
- `note(...)` is used for post-init hints (e.g. print "run `gd-metapro mcp install` to wire your editor").

### Client config shapes (write merge-safely)
- Cursor: `.cursor/mcp.json` → `{ "mcpServers": { "<name>": { "command", "args" } } }`.
- Claude Code (project scope): `.mcp.json` at project root → same `{ "mcpServers": {...} }` shape.
- generic: print the snippet, write nothing.
- Managed server key: `gd-metapro` → `{ "command": "gd-metapro", "args": ["mcp","serve"] }`. Mark it managed (sentinel) so uninstall removes ONLY it and preserves other user servers.

### SDK presence check
- The server lazy-imports `@modelcontextprotocol/sdk` (optionalDependency). Install can probe importability (try `await import`, or check node_modules) and print `bun add @modelcontextprotocol/sdk` hint if absent. Do NOT auto-install.

### Hard invariants (golden rule)
- Default init answer (No) + no `mcp install` ⇒ byte-identical to today; `modules.mcp` off; no client file written; no network. `dependencies` stays `{}`.
- Merge-safe: never drop existing `mcpServers`/keys; idempotent re-install; `uninstall` strips only the managed entry (+ sentinel) and leaves other servers/user content.
- No existing `*.test.ts` modified; no `.metaproject/flows/**` or `flow.json` touched.

### Baseline
- main @ 949e8bc; `bun run check` green (352 tests); roadmap-2026 + docs landed.

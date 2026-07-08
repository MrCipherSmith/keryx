# Implementation Plan

Status: ready

## Approach

Mirror the E5 multi-runtime hook installer for MCP client configs: a small `McpClientRuntime`
registry ({id, settingsPath, merge, strip, validate}) with a managed sentinel so installs are
merge-safe/idempotent and uninstall is targeted. Add `mcp install|uninstall` subcommands to the
existing `mcp` command; on install also flip `modules.mcp.enabled=true` merge-safely and print an
SDK hint if the optional dep is absent (never auto-install). Add an `init` question offering MCP
(default No), honored non-interactively by the existing `--mcp/--no-mcp` flags; `--yes` never writes
a client config. Block-completion gate = the byte-identical default (No / no install) + merge-safety
tests.

Single coherent implementer (shared single-writer files: `commands/mcp.ts`, `commands/init.ts`, `cli.ts`).

## Steps

1. **Client-config registry.** `src/mcp/client-config.ts` — `McpClientRuntime` for `cursor`
   (`.cursor/mcp.json`), `claude` (`.mcp.json`), `generic` (snippet only). Managed sentinel
   (`_gdMetaproManaged`) marking the `mcpServers.gd-metapro` entry; `merge`/`strip`/`validate`
   mirroring `agent-hooks/runtimes.ts`. Reuse `src/lib/{json,fs}.ts` for read-or-empty + write.
2. **Install/uninstall orchestration.** `installMcpClient(projectRoot, ids, {dryRun})` /
   `uninstallMcpClient(...)` / `resolveMcpRuntimes(ids)` (comma-list + `all`), mirroring
   `installRuntimeHooks`. Install also merge-safely sets `modules.mcp.enabled=true` in the manifest
   and probes SDK importability → actionable hint if missing.
3. **Command wiring.** Extend `src/commands/mcp.ts` with `install`/`uninstall` (parse `--runtime`,
   `--dry-run`), help text; confirm `cli.ts` routes them (route already exists for `mcp`).
4. **init offer.** Add a `confirm("Enable the MCP server (expose this project to Cursor / Claude
   Code)?", false)` question gated on `options.noMcp` else `!options.yes`; when enabled set
   `modules.mcp.enabled=true`, and (interactive only) `choice(...)` a runtime to write its client
   config, or skip. `--yes`/non-interactive never writes a client config. Post-init `note(...)` hint
   pointing at `mcp install` when MCP is left off.
5. **Tests.** merge-safety with pre-existing user servers/keys; idempotent re-install (no dupes);
   targeted uninstall (only the managed entry removed); `--dry-run` writes nothing; install flips
   `modules.mcp.enabled`; byte-identical default (init No + no install) — golden-file/manifest diff;
   generic prints snippet, writes no file; SDK-absent hint path.
6. **Docs.** README (MCP Server subsection + Commands) + `docs/docs/cli-reference.md` (`mcp
   install|uninstall`) + init capability-flags note.
7. **Review + PR.** Adversarial review (merge-safety / idempotency / byte-identical default / no network).

## Risks

- **Merge-safety (top):** must never drop a user's existing `mcpServers` or other keys; re-install
  must not duplicate. Mitigation: mirror the proven E5 sentinel merge/strip; dedicated tests with a
  pre-populated config.
- **Byte-identical default:** the new init question must not change `--yes`/non-interactive output;
  default No must leave `modules.mcp` off and write no client file. Mitigation: gate exactly like the
  other module questions; manifest/golden diff test.
- **Manifest edit safety:** setting `modules.mcp.enabled=true` must preserve the rest of the manifest
  (parse → set → write; malformed ⇒ no-op with message). Reuse `src/lib/json`.
- **No network / no auto-install:** SDK is only probed, never installed. `dependencies` stays `{}`.
- **cwd/project scoping:** configs are written under the project root (`settingsPath(projectRoot)`),
  keeping the server project-scoped; generic prints a snippet only.

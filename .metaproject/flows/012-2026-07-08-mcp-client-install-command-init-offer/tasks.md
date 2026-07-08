# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `gd-metapro flow task done <id> <taskId>`.

| ID | Kind | Title | Satisfies |
|----|------|-------|-----------|
| T1 | context | Study E5 installer + mcp command + init prompt seams (done Phase 1) | — |
| T2 | implement | `src/mcp/client-config.ts`: McpClientRuntime registry (cursor/claude/generic) + merge/strip/validate + install/uninstall orchestration + SDK probe + manifest enable | AC1, AC2, AC3, AC4, AC5 |
| T3 | implement | `mcp install|uninstall [--runtime][--dry-run]` command in `commands/mcp.ts` + cli help | AC1, AC4 |
| T4 | implement | init MCP offer: confirm(default No) + enable modules.mcp + interactive runtime choice + post-init hint; --yes never writes client config | AC6 |
| T5 | test | Tests: merge-safety, idempotent re-install, targeted uninstall, dry-run writes nothing, manifest-enable, byte-identical default init, generic snippet, SDK-absent hint, no-network | AC1..AC7 |
| T6 | docs | README (MCP Server + Commands) + docs/docs/cli-reference.md (mcp install|uninstall) + init offer note | AC7 |
| T7 | review | Adversarial review (merge-safety / idempotency / byte-identical default / no network) + draft PR | AC6, AC7 |

## Notes
- **Golden rule is the block-completion gate:** T5's byte-identical default (init No + no install) + no-network tests (AC6/AC7) must be green.
- Reuse the E5 `agent-hooks/runtimes.ts` sentinel merge/strip pattern — build a SIBLING McpClientRuntime registry, do not entangle with the security hooks.
- `dependencies` stays `{}`; SDK is only probed, never installed; no network.
- No existing `*.test.ts` modified; no `.metaproject/flows/**` touched.

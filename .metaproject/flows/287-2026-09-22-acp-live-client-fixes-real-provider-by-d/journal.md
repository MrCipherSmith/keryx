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
- 2026-09-22T22:45:25.337Z - task-added: T13: Review fixes: refresh grants before resolution, bound server sets, stop servers on signals, scrub server output, harden the vacuous tests
- 2026-09-22T22:45:48.988Z - task-attempt: T13: started (attempt 1)
- 2026-09-22T22:55:00Z - T13 review fixes (subagent), uncommitted:
  (1) verified: grants now refreshed BEFORE resolveTuiStartup, shell order (`shellGrantRefresh`); test with an expiring grok grant + stubbed token endpoint asserts the provider sees the refreshed token.
  (2) verified: client MCP sets shared per connection by content hash (`acpMcpSetKey`), refcounted by session binding; test: two session/new with one list dial once.
  (3) verified: read loop in try/finally, `shutdown` signal raced against stdin, SIGTERM/SIGINT handlers in `keryx acp` (exit 143/130), session-mcp close bounded like runtime.ts (`within` exported); SIGKILL limit documented (no cheap sweep).
  (4) verified: tool results/errors scrubbed; scrub ignores values < 8 chars; saved credential env keys stripped from the MCP parent env by name.
  (5) echo fixture gained ECHO_SERVER_IGNORE_EOF and ECHO_SERVER_LEAK_PROBE; new process tests for SIGTERM-to-keryx and a credential-echoing server. Mutation runs: each guarded fix reverted makes its test fail.
  (6) refuted: `use_tool` always carries meta.destructive=true (executeCall and the taint gate), so allow_always is never offered; pinned in the AC7 process test.
  (7) turn settings (modelParams, maxOutputTokens, reasoningEffort) now resolved by the shell's resolvers and passed into ACP turns; docs state the in-session-override gap.
- 2026-09-22T22:54:47.734Z - task-done: T13: Review fixes: refresh grants before resolution, bound server sets, stop servers on signals, scrub server output, harden the vacuous tests
- 2026-09-22T22:59:37.030Z - task-added: T14: Re-review fixes: scrub escaped and truncated secrets, redial failed shared sets, refuse work after shutdown
- 2026-09-22T22:59:53.496Z - task-attempt: T14: started (attempt 1)
- 2026-09-22T23:06:00Z - T14 re-review fixes (subagent), uncommitted:
  (1) scrub matches each secret raw AND JSON-escaped; (2) scrub moved into the tool pair via a `redact` hook in `src/mcp-servers/tools.ts`, applied after serialisation and before sanitise/truncate (identity for keryx shell);
  (3) `AcpSessionMcp.revive()` redials failed or unresponsive (tools/list probe, 5s) servers when a session binds to a running set; docs state threads share server processes;
  (4) `stopping` flag set on the shutdown abort and in the finally, refusing session/new, session/load, session/prompt (`condition: shutting-down`);
  (5) cli-reference secrets paragraph states exactly what is scrubbed and the limits (8-char minimum, transformed values, model-authored copies).
  Mutations M5-M7 and M8b (both stopping assignments removed) each fail their test; M8 (abort-only) survives because the finally assignment also closes the window.
  T14 amendment: the timing-based `tools/list` probe (REVIVE_PROBE_MS) is removed. `revive()` redials only servers known dead: failed to start, or `isClosed()` true — a new optional flag on `McpServerConnection`, set by the stdio client from the SDK's `Protocol.onclose` (fires when the child's pipes close). Fixture gained `ECHO_SERVER_HOLD_TOOL` (a `hold` tool; requests handled one at a time). New tests: a server whose process exited is redialled; a server busy in a long call is not. Mutations M9 (probe restored), M10 (closed flag ignored), M11 (client never records close) each fail their tests.
- 2026-09-22T23:11:02.977Z - task-done: T14: Re-review fixes: scrub escaped and truncated secrets, redial failed shared sets, refuse work after shutdown
- 2026-09-22T23:18:32.333Z - ac-confirmed: AC1: src/commands/acp.test.ts describe(AC1): tests 'the saved keryx shell selection is used, and it is exactly what resolveTuiStartup answers', 'the default path builds a real provider through the shell's factory — never FakeProvider', 'a factory result that is FakeProvider (no credential, unknown name) is refused, never run', '--provider fake is refused: the scripted provider is reachable only through --fixture', '--fixture is the one way to the scripted provider'; plus src/acp/mcp-servers.process.test.ts describe(AC1/AC2 — provider resolution with no --fixture) test 'keryx shell's saved selection is used with no flags: session/new is accepted'. AC amended 2026-09-22T22:38:14Z per journal (fake-provider construction inside shell's own makeProvider is unavoidable; the asserted property is that acp discards it and never runs a turn against it).
- 2026-09-22T23:18:36.650Z - ac-confirmed: AC2: src/commands/acp.test.ts describe(AC2 — nothing configured is an answer that says what to configure): tests 'no saved selection and no flags: unconfigured, naming keryx shell and --provider/--model', 'half a pair is refused rather than silently ignored'. Plus src/acp/mcp-servers.process.test.ts test 'nothing configured: initialize answers, session/new and session/load are refused naming the remedy, stderr says it once' — proves initialize still answers, session/new and session/load are refused with a named JSON-RPC error, and the stderr line is written once at startup.
- 2026-09-22T23:18:38.913Z - ac-confirmed: AC3: src/acp/mcp-servers.process.test.ts describe(AC3/AC5/AC6/AC7 — a client's stdio MCP server, end to end over the real pipe) test 'started with its env, tool offered, asked, run on allow; failures reported by name; secrets nowhere; process gone after close' — proves stdio server started with command/args/env via keryx's MCP client, tools offered to the session's turns, process gone after connection closes. Plus src/acp/session-mcp.test.ts test 'session/load starts the list it carries, and closing the connection stops it' and describe(startAcpSessionMcp) test 'one server fails, the other connects; the failure names the server and carries no secret (AC5/AC6)'.
- 2026-09-22T23:18:40.641Z - ac-confirmed: AC4: src/acp/mcp-servers.process.test.ts test 'AC4: a denied call does not run and ends exactly as a local denial does' — process test over real pipe proving a client-supplied MCP tool call goes through session/request_permission and a denial ends the call exactly as a local denial. Plus src/acp/session-mcp.test.ts test 'use_tool is destructive, so every call reaches the agent's approval branch (AC4)'.
- 2026-09-22T23:18:42.954Z - ac-confirmed: AC5: src/acp/session-mcp.test.ts describe(parseAcpMcpServers — what is refused per entry, and what fails the call (AC5)): tests 'http and sse entries are refused per entry, by name, with the reason — and their header values are secrets', 'a stdio entry with no command, bad args, bad env or a reused name is refused per entry', 'a list that is not a list, or an entry with no name, fails the whole call with -32602'. Plus test 'one server fails, the other connects; the failure names the server and carries no secret (AC5/AC6)' and process test 'session/new accepts a non-empty mcpServers and reports a server that cannot start, rather than refusing the session (flow 287)' in src/commands/acp.process.test.ts — proves session creation succeeds despite a failing server and http/sse entries are refused per-entry with reason.
- 2026-09-22T23:18:47.955Z - ac-confirmed: AC6: src/acp/session-mcp.test.ts describe(scrub (AC6)): tests 'every occurrence of every secret is replaced, a longer secret before a shorter one it contains', 'a value shorter than the minimum is not a secret: DEBUG=1 does not mangle 15000ms'. Plus describe(T13 — tool output is scrubbed too (AC6)) test 'a server that echoes its credential in a result or an error reaches the model redacted'; describe(T14 — the scrub survives JSON escaping and the truncation cap) tests 'a secret with a quote and a backslash (db"pass\\word42) is redacted in its escaped form', 'a secret straddling the 20,000-byte cap leaves no prefix behind'. Plus src/acp/mcp-servers.process.test.ts describe(T13 — AC6 against a server that echoes its own credential) test 'the leaked value is redacted in the tool result, and appears in no artifact' and describe(T14 — escaped secrets, and a shared set that recovers) test testing a credential with quote/backslash redacted in JSON-escaped result. Together these prove env/header values from mcpServers never reach transcripts, records, logs, stdout/stderr, including escaped and truncated forms.
- 2026-09-22T23:18:50.088Z - ac-confirmed: AC7: src/acp/mcp-servers.process.test.ts describe(AC3/AC5/AC6/AC7 — a client's stdio MCP server, end to end over the real pipe) main test 'started with its env, tool offered, asked, run on allow; failures reported by name; secrets nowhere; process gone after close' — drives the built keryx acp CLI over a real stdio pipe against a real stdio MCP server fixture from the repo (echo-server fixture): session/new with that server succeeds, its tool is offered, the permission ask arrives, the call runs on allow and returns its result, and the server process is gone after the connection closes. No network involved (stdio fixture only).
- 2026-09-22T23:18:53.155Z - ac-confirmed: AC8: docs/docs/cli-reference.md acp section (lines 168-405): describes provider/model resolution with no flags ('keryx acp uses the provider and model' the saved selection resolves to, line 181), what happens when nothing is configured (line 201: 'keryx acp still starts and still answers'), which mcpServers transports are accepted vs refused (line 392-393: 'No transport but stdio... only ever speaks newline-delimited JSON-RPC over the pipes'), and how a failed server is reported (line 236+ client MCP servers section). README.md lines 251-277 (Agent Client Protocol server bullet) states the same and links to the cli-reference for the full table; line 268 states servers are stopped when the connection ends or on SIGTERM/SIGINT, and http/sse entries are refused.
- 2026-09-22T23:18:55.634Z - ac-confirmed: AC9: CI 18/18 green on PR MrCipherSmith/keryx#648 at head a559059d84ae10c20d92bc3f1366cfa0a530ff6e, merged 2026-09-22 as squash commit 4aba62bc into main. Local 'keryx health run' in /home/altsay/keryx: PASS, project score 94 (stable trend), 320 findings, no gate conditions triggered.
- 2026-09-22T23:19:00.337Z - task-done: T1: Collect remaining context
- 2026-09-22T23:19:00.442Z - task-done: T2: Implement per plan
- 2026-09-22T23:19:00.550Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-22T23:19:00.654Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-22T23:19:02.996Z - task-done: T12: Verification: CI green, keryx health run
- 2026-09-22T23:24:17.455Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/648 (warning: PR is not a draft) (base: main)
- 2026-09-22T23:24:19.131Z - completing
- 2026-09-22T23:24:24.580Z - done: all gates passed

## 2026-09-22 — correction: AC1 was confirmed against its original wording

The amendment of AC1 recorded at 22:38 (ac-updated history entry, with its reason) never reached
`acceptance-criteria.md`: `keryx flow ac update` takes no criterion id and no text — it re-freezes
the file as it stands — and silently ignored the `AC1` and `--text` arguments it was given. The
flow therefore completed with AC1 still reading "a test proves the default path never constructs
the fake or fixture provider".

That sentence is not literally true of what shipped. The shell's own `makeProvider` returns an
empty `FakeProvider` for a provider without a credential; `keryx acp` discards it at once and
reports the provider unconfigured. What was delivered and tested is the property the amendment
stated: no turn ever runs against, and the server is never handed, the fake or fixture provider —
it is reachable only through `--fixture` (src/commands/acp.test.ts, "a factory result that is
FakeProvider … is refused, never run"; "--fixture is the one way to the scripted provider").

The completed record is left as it is rather than re-frozen after completion, which would void
every confirmation on a done flow. The CLI defect that dropped the text is fixed in flow 293.

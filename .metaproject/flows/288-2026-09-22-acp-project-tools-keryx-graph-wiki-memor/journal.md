# Flow Journal

- 2026-09-22T22:22:26.709Z - flow created

## 2026-09-22 — release decision (operator)

One release after BOTH flow 287 (A) and flow 288 (B) are done: flow 287 merges to main but is not tagged on its own. Before tagging, smoke `keryx acp` with no flags and with client-supplied MCP servers — the exact scenario that failed live in Zed on 0.2.154.
- 2026-09-22T22:28:48.543Z - frozen: 10 criteria; checksum recorded
- 2026-09-22T22:28:48.787Z - started
- 2026-09-22T22:28:49.028Z - task-added: T5: Offer the shell's read-only project tools in ACP sessions through the same gate and definitions
- 2026-09-22T22:28:49.273Z - task-added: T6: Map every ACP roster tool to a meaningful ACP tool kind, with a test against 'other' fallbacks
- 2026-09-22T22:28:49.538Z - task-added: T7: Pin the roster: no untrusted-result, delegation or bus tools, enforced by a test
- 2026-09-22T22:28:49.763Z - task-added: T8: Advertise and handle slash commands over ACP (available_commands_update, / prompts)
- 2026-09-22T22:28:49.996Z - task-added: T9: Model selection via configOptions category model, session/set_config_option and /model
- 2026-09-22T22:28:50.216Z - task-added: T10: Type AvailableCommand and config options in protocol.ts; unrefuse session/set_config_option
- 2026-09-22T22:28:50.446Z - task-added: T11: Process tests over a real pipe for tools, commands and model switching
- 2026-09-22T22:28:50.661Z - task-added: T12: Docs: CLI reference and README for the ACP roster, commands and model switching; README positioning line
- 2026-09-22T22:28:50.865Z - task-added: T13: Verification: CI green, keryx health run
- 2026-09-22T23:16:11.326Z - task-attempt: T5: started (attempt 1)

## 2026-09-22 — T5–T12 implemented (subagent)

- T5/AC1: project-tool assembly extracted to `src/commands/project-tools.ts` (`buildProjectTools`, `METAPROJECT_FREE_TOOLS` moved there, re-exported from `interactive-agent-tools.ts`). The shell factory and the new ACP roster (`src/acp/roster.ts`, `buildAcpSessionTools`) both call it — one gate (`offersIndexTools`), one set of definitions.
- T6/AC2: `TOOL_KIND_BY_NAME` covers every roster tool (project tools; client-MCP `search_tool`=search, `use_tool`=execute); `ACP_TOOL_KIND_OTHER_EXCEPTIONS` is empty.
- T7/AC3: `roster.test.ts` pins keryx's own roster exactly; web pair, spawn_subagent, bus_* asserted absent (and asserted present in the shell roster, so the exclusion is a choice); the client-MCP pair is the documented exception.
- T8/AC4: `src/acp/commands.ts` — /help, /model, /reasoning, /status (each a real agent-mode shell command); `available_commands_update` sent after the session/new and session/load replies; `/word` prompts answered by keryx, never the model, not added to history; unlisted -> the list. A prompt that starts with a path is not a command.
- T9/AC5/AC6: `src/acp/models.ts` + `shellModelSource` in `src/commands/acp.ts` (detectProviders + resolveModelsForPicker, narrowed to providers the shell factory builds without falling back to FakeProvider; bind = refresh grants first -> realMakeProvider -> refuse Fake -> resolveAcpTurnSettings for the NEW provider; nothing saved). Per-session model map in the server; a turn reads it once at start. session/new and session/load now await the connection-cached, eagerly started choice list before answering; everything before that await stays synchronous.
- T10/AC7: protocol types for AvailableCommand, SessionConfigOption (+select option/group, category), set_config_option request/response, `config_option_update.configOptions`; set_config_option moved from refused to implemented.
- T11/AC8: `src/acp/project-tools.process.test.ts` (fixture gained optional `models` and `{{model}}` substitution so the model a turn ran is visible on the wire).
- T12/AC9: CLI reference acp section (switching model, tools a session offers + exclusions, slash commands, method tables) and README ACP bullet + the positioning sentence.
- Decision: the README line names frozen criteria, reasoned AC updates and evidence-confirmed completion; it does not claim a "named owner" — no such flow field exists to point at.
- 2026-09-22T23:34:06.806Z - task-done: T5: Offer the shell's read-only project tools in ACP sessions through the same gate and definitions
- 2026-09-22T23:34:06.907Z - task-done: T6: Map every ACP roster tool to a meaningful ACP tool kind, with a test against 'other' fallbacks
- 2026-09-22T23:34:07.009Z - task-done: T7: Pin the roster: no untrusted-result, delegation or bus tools, enforced by a test
- 2026-09-22T23:34:07.112Z - task-done: T8: Advertise and handle slash commands over ACP (available_commands_update, / prompts)
- 2026-09-22T23:34:07.215Z - task-done: T9: Model selection via configOptions category model, session/set_config_option and /model
- 2026-09-22T23:34:07.321Z - task-done: T10: Type AvailableCommand and config options in protocol.ts; unrefuse session/set_config_option
- 2026-09-22T23:34:07.424Z - task-done: T11: Process tests over a real pipe for tools, commands and model switching
- 2026-09-22T23:34:07.525Z - task-done: T12: Docs: CLI reference and README for the ACP roster, commands and model switching; README positioning line
- 2026-09-22T23:41:56.253Z - task-added: T14: Review fixes: bounded model probe on the shell's base URL, saved per-provider endpoints, literal roster pin, stricter command parsing, cancel-aware switch, load restores the switched model
- 2026-09-22T23:42:17.385Z - task-attempt: T14: started (attempt 1)

## 2026-09-22 — T14 review fixes (subagent)

1. Model list bounded: server waits at most `modelListTimeoutMs` (default 8 s) for the list; on timeout/failure the session gets the launch model only, stderr says so, and the next session asks again (a failure is not cached; a success is). The Ollama probe now uses the `--base-url` flag only (as the shell) and every probe fetch carries `AbortSignal.timeout`. Tests: `server-models.test.ts` "1 — …" (2), `acp.test.ts` "the Ollama probe uses the --base-url flag only…".
2. Saved per-provider endpoints: the overlay is now `withSavedBaseUrls` in `shell.ts` (extracted from `resolveTuiStartup`, which calls it) and `shellModelSource` calls it. Test: `acp.test.ts` "a saved per-provider endpoint (auth.json baseUrls)…".
3. AC3 pin is a literal list in `roster.test.ts`; plus a check that every pinned read-risk tool is a known read-only builtin/metaproject op and the gated two keep their risks. No registry-level untrusted marker exists (it is a per-result flag) — the comment says so.
4. Commands: only a single-line first text block, not starting with whitespace, is a command; args from that line only; extra text on a no-arg command and any attachment are refused without echo; `session/cancel` during `/model` aborts the switch (signal reaches `bind`, nothing applied, nothing more sent). Documented the `/word` rule and the leading-space escape.
5. `session/load` restores the recorded provider/model (read from the summary before `openSession` overwrites it) when it is still a choice; otherwise launch model + an agent message saying why.
6. Overlapping switches: issued/applied sequence numbers — a later failure no longer discards an earlier success.
7. Stale "synchronous end to end" comment corrected.
- 2026-09-22T23:52:54.313Z - task-done: T14: Review fixes: bounded model probe on the shell's base URL, saved per-provider endpoints, literal roster pin, stricter command parsing, cancel-aware switch, load restores the switched model
- 2026-09-23T00:07:19.868Z - ac-confirmed: AC1: src/commands/project-tools.ts:buildProjectTools (gated by offersIndexTools) is the single assembly used by both the shell (interactive-agent-tools.ts:198) and ACP roster (acp/roster.ts:72); roster.test.ts asserts both project states and the search_code exception. bun test: roster.test.ts passes (bd1dbe96, merged PR #651).
- 2026-09-23T00:07:19.978Z - ac-confirmed: AC2: src/acp/agent-io.ts:53 TOOL_KIND_BY_NAME maps every roster tool; ACP_TOOL_KIND_OTHER_EXCEPTIONS (line 91) is empty; roster.test.ts:114 fails any tool falling back to other without being a declared exception. bun test roster.test.ts passes (bd1dbe96, merged PR #651).
- 2026-09-23T00:07:20.087Z - ac-confirmed: AC3: src/acp/roster.test.ts (AC3 block, line 7 comment) pins the literal roster list; asserts spawn_subagent (delegation) and bus_* (bus) tools absent from ACP roster while present in shell roster, and untrusted-result tools excluded per InteractiveToolResult.untrusted comment at line 137-138. bun test roster.test.ts passes (bd1dbe96, merged PR #651).
- 2026-09-23T00:07:29.203Z - ac-confirmed: AC4: src/acp/server.ts:635 sends one available_commands_update after session/new and session/load; commands.ts handles leading-/ prompt text without reaching the model (T14 hardened: single-line, no leading whitespace). project-tools.process.test.ts:135 'commands: one update after session/new, a / command never reaches the model, an unlisted one gets the list' passes. bun test: 42 pass (bd1dbe96, merged PR #651).
- 2026-09-23T00:07:29.386Z - ac-confirmed: AC5: src/acp/models.ts:74-84 builds the one select configOption of category model (shellModelSource, narrowed to providers the shell factory builds); session/new and session/load await this before answering (protocol.ts configOptions field). bun test: 42 pass (bd1dbe96, merged PR #651).
- 2026-09-23T00:07:29.599Z - ac-confirmed: AC6: src/acp/server.ts: set_config_option and /model both call bind (refresh grants -> realMakeProvider -> resolveAcpTurnSettings) which applies from the NEXT turn (per-session model map read once at turn start), never mid-turn; unknown value refused with reason; nothing written to keryx shell's saved default (journal T9). T14 fixed cancel-aware switch (session/cancel aborts /model, nothing applied) and overlapping-switch sequence numbers so a later failure doesn't discard an earlier success. project-tools.process.test.ts:180 'model: configOptions on session/new, switched by set_config_option and /model from the next turn, never mid-turn' passes. bun test: 42 pass (bd1dbe96, merged PR #651).
- 2026-09-23T00:07:38.954Z - ac-confirmed: AC7: src/acp/protocol.ts types AvailableCommand (line ~600s), AcpSessionConfigOptionCategory/AcpSessionConfigOption (601,617), AcpSetSessionConfigOptionRequest (628), config_option_update.configOptions (637); session/set_config_option moved from refused to implemented in server.ts (comment at 431 notes it is not refused while a turn runs). protocol.test.ts (version/partition tests present, ACP_PROTOCOL_VERSION etc.) passes. bun test: 42 pass (bd1dbe96, merged PR #651).
- 2026-09-23T00:07:39.068Z - ac-confirmed: AC8: src/acp/project-tools.process.test.ts describe block 'AC8 — project tools, commands and model switching over a real pipe' (line 88) with 3 tests: 'the project tools are offered, and one is called in a turn' (89), 'commands: one update after session/new, a / command never reaches the model, an unlisted one gets the list' (135), 'model: configOptions on session/new, switched by set_config_option and /model from the next turn, never mid-turn' (180) — over a real stdio pipe with the fixture provider, waits on wire events not timers. bun test: 42 pass, 0 fail (bd1dbe96, merged PR #651).
- 2026-09-23T00:07:39.180Z - ac-confirmed: AC9: docs/docs/cli-reference.md has a '## acp' section (line 168) documenting the tool roster/exclusions, commands, and configOptions model switching (lines 202-262); README.md lines 256-266 describe the ACP server, advertised commands, and roster. No remaining text claims only five tools or a launch-fixed model (both greps for those phrases returned zero hits in README.md and docs/docs/cli-reference.md). (bd1dbe96, merged PR #651).
- 2026-09-23T00:07:45.338Z - ac-confirmed: AC10: CI green 18/18 on PR #651 (gh pr checks 651 --repo MrCipherSmith/keryx) at head 7e0809a2a2b170ded9d3ecf307e1c0f6f298a19a, merged squash bd1dbe96 into main. keryx health run: PASS, project score 94, 0 gate conditions triggered (report: .metaproject/data/health/artifacts/latest.md).
- 2026-09-23T00:07:49.927Z - task-done: T1: Collect remaining context
- 2026-09-23T00:07:50.035Z - task-done: T2: Implement per plan
- 2026-09-23T00:07:50.145Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-23T00:07:50.254Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-23T00:07:54.389Z - task-done: T13: Verification: CI green, keryx health run
- 2026-09-23T00:12:21.593Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/651 (warning: PR is not a draft) (base: main)
- 2026-09-23T00:12:24.882Z - completing
- 2026-09-23T00:12:30.159Z - completion-failed: review: 1 of 5 conditions failed — terminal-dispositions (violated): 1 finding(s) at or above `minor` are not terminal: 2026-09-22-ingest-acp-project-tools#F-008 (minor, round 2026-09-22-ingest-acp-project-tools): `dismissed-deprioritised` with no recorded human decision — the orchestrator may not dismiss on its own authority; the evidence must name who decided (e.g. `human: <who>` or `decided-by: <who>`)
- 2026-09-23T04:21:59.697Z - task-added: T15: Push config_option_update when a late model list arrives after a timed-out session replied
- 2026-09-23T04:21:59.948Z - task-attempt: T15: started (attempt 1)

## 2026-09-23 — T15 implemented (worktree keryx-acp2, branch fix/acp-late-model-list)

`modelChoices(sessionId, method)` (`src/acp/server.ts`) now takes the session id and calling method. On the timeout branch it calls `armLateModelListNotify(listPromise, sessionId, method)`, which adds the session to a new `pendingLateModelList` set and attaches a `.then`/`.catch` to the SAME in-flight listing promise the session raced against: success sends that session exactly one `session/update` (`config_option_update`) built by `configOptionsFor` (the same builder `set_config_option` uses — the session's current model stays selected); failure or an already-cleared entry sends nothing. `pendingLateModelList.delete(sessionId)` is also called on every path where a session gets the list directly (cached fast path, or its own error/success outcome), so a session already served the full list — or whose own later call already resolved it — is never notified again, and `stopping`/`registry.get(sessionId)` are checked before sending so nothing goes out after shutdown or connection close. All five call sites of `modelChoices` (`configOptionsFor`, `switchSessionModel`, `restoreRecordedModel`, the `/model`-no-args branch) now pass `sessionId` + `method`.

Tests added — `src/acp/server-models.test.ts`, new "7 — a late model list reaches sessions left on the launch-only one" block (4 tests, deferred `AcpModelSource.choices()` promises, no sleeps except two fixed 20ms waits to confirm a negative — no second/no update arrives):
(a) a session offered only the launch model is told once, with the full list, when it arrives late — verified to FAIL (times out after 5s) with `armLateModelListNotify` call commented out, passes with it restored;
(b) a session that already got the complete list is never told again;
(c) a late list that fails sends nothing;
(d) no update once the connection has closed.

`bun test src/acp/server-models.test.ts`: 10 pass, 0 fail (6 pre-existing + 4 new), 28 expect() calls. Also ran the full related set (`keryx test related src/acp/server.ts`): `mcp-servers.process.test.ts`, `server-mcp.test.ts`, `server-models.test.ts` — 32 pass, 0 fail. `bun run typecheck`: clean. `bunx eslint src/acp/server.ts src/acp/server-models.test.ts`: clean.

Docs: `docs/docs/cli-reference.md` (model-switching paragraph, ~line 213) now says the picker is not left on one entry forever — once the late list arrives, keryx sends one `config_option_update` with the complete list (current model stays selected); nothing if the list fails or the session/connection has ended first.

Changed files: `src/acp/server.ts`, `src/acp/server-models.test.ts`, `docs/docs/cli-reference.md`.
- 2026-09-23T04:30:49.324Z - task-done: T15: Push config_option_update when a late model list arrives after a timed-out session replied
- 2026-09-23T04:38:23.700Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/651 (warning: PR is not a draft)
- 2026-09-23T04:38:26.987Z - completing
- 2026-09-23T04:38:33.338Z - completion-failed: review: 1 of 5 conditions failed — terminal-dispositions (violated): 1 finding(s) at or above `minor` are not terminal: 2026-09-22-ingest-acp-project-tools#F-008 (minor, round 2026-09-22-ingest-acp-project-tools): `dismissed-deprioritised` with no recorded human decision — the orchestrator may not dismiss on its own authority; the evidence must name who decided (e.g. `human: <who>` or `decided-by: <who>`)
- 2026-09-23T04:41:11.726Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/651 (warning: PR is not a draft)
- 2026-09-23T04:41:14.933Z - completing
- 2026-09-23T04:41:20.326Z - done: all gates passed

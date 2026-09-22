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

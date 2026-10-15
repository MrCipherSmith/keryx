# PRD: the orchestrator's call log is written by keryx, not by the agent

Status: DRAFT 1 for the operator (source: poll 180, answer 1, 2026-10-15; follow-up of flow 452). Not frozen.

## Problem

Flow 452 added the readiness item `memory-outside-stage`. It reads `<package>/tool-calls/orchestrator.jsonl` and blocks `completed` and publishing when the orchestrator made a memory call other than its single stage query. Nothing writes that file. The review-orchestrator skill tells the host agent to append its own tool calls (`SKILL.md:36`, `SKILL.detail.md:384`). An agent that forgets, or that is the one reading its own memory, leaves no log, and the item then passes with "no orchestrator tool log". The check depends on the behaviour it is meant to check.

## What exists today (audit)

Reader:
- `src/review/readiness.ts:242` `memoryStageCheck` reads the log through `readToolLog(dir, ORCHESTRATOR_LOG)` (`src/review/layers-usage.ts:111-117, 187`). No log: pass. Otherwise every memory call except `keryx memory search "<q>" --status accepted` with the manifest's `cleanContext.memoryQuery` is "outside".
- `memoryCalls` (`layers-usage.ts:150`) parses one JSON object per line: `name`/`tool` (MCP), `command`/`cmd` (shell), `input`/`arguments`, `time`|`timestamp`|`ts`|`at`. Any plain line is taken as a command. A line that is not a memory call is ignored. This is the format the writer must produce.
- Reviewers' logs are other files in the same directory (`<reviewer>.jsonl`, or the path a driver names in `toolLog`); they are not read by this check.

Writer: none.

Where a memory call can be seen (every layer that executes one):
1. `keryx memory <search|handoff|propose|…>` as a process (`src/commands/memory.ts`, `search` branch at line 55). Host-independent: a Claude Code or Codex session that shells out to `keryx` reaches it. It knows its cwd and environment, not which agent called it.
2. The keryx MCP server (`src/mcp/metaproject-tools.ts`: `memory_search`, `memory_handoff`, `memory_propose`, calling `port.memorySearch` at line 92). Same host-independence; no knowledge of the caller.
3. The keryx shell (`keryx shell`): the tool executor `executeCallUnbounded` (`src/commands/agent.ts:5572`) sees every tool call of a session, shell commands included, and the built-in `memory_search` tool (`src/harness/tool/builtin/metaproject-tools.ts:289`). A child reviewer started by `spawn_subagent` runs its own turn (`spawn-subagent-tool.ts:2159`), so there the executor does know parent from child. `AutomaticReviewRun` (`src/commands/automatic-review.ts:219`) already binds a turn to a package, but only for `--automatic` runs.

Not visible to any of them: a host agent's own memory (Claude Code `MEMORY.md`, auto-memory files, its conversation history), a memory MCP server of another vendor, a memory read done by editing or reading files directly. That is the named limit of the whole feature (see AC9).

## Design

1. A recorder (`src/review/orchestrator-log.ts`): `recordOrchestratorCall(packageDir, entry)` appends one JSON line `{time, source, caller, tool|command, input}` to `<package>/tool-calls/orchestrator.jsonl` with `O_APPEND`, creating the directory. It never throws: a failed append prints one warning line and the command it observed keeps its exit code and output. The line format is the one `memoryCalls` already parses, so the reader does not change shape.
2. Which package is active: `keryx review start|attach` writes a small pointer (`{id, dir, startedAt}`) to the project's data directory and `close` removes it. The pointer is honoured only while the manifest it names exists and is not `closed`. Without a pointer, or with a stale one, nothing is recorded and no file is created. No guessing from "newest package".
3. Three recording points, one per layer above: the `keryx memory` CLI, the keryx MCP memory tools, and the keryx shell executor (any tool call that `classifyToolCall` puts in the `memory` layer, plus the built-in `memory_search`).
4. Attribution through a `caller` field. The keryx shell sets `KERYX_REVIEW_CALLER=<reviewer>` in the environment of every command a spawned child runs and passes the same to its tools; the parent's calls carry `caller: "orchestrator"`. A call that reaches the CLI or MCP without the variable from a host that is not the keryx shell cannot be told apart from a reviewer's call; it is recorded as `caller: "unattributed"`.
5. The reader counts `caller: "orchestrator"` and lines without a `caller` (the host-written format that exists today). It does not count `reviewer` ids. `unattributed` is reported in the item's detail line and, per decision D1, either counts or only warns. `review start` writes a first line `{"event":"log-start"}` so that "recorded, no memory call" is told apart from "no log at all" (today the same pass). The skill stops asking the agent to write the file.

## Out of scope

- Reading or blocking the agent's own memory (impossible from keryx, see limits).
- Changing the stage rule, `cleanContext`, the nine other readiness items, reviewers' own logs, or `layersUsed`.
- Reviewer `memory_search` and the other accepted paths of poll 179 stay as they are.

## Honest limits (go into the docs verbatim)

- The log holds only calls that pass through keryx: the `keryx` CLI, the keryx MCP server, the keryx shell. A host agent's own memory (auto-memory index, remembered feedback, earlier conversation) and any other vendor's memory tool are not visible. The check stays "no keryx-visible memory read outside the stage", not "no memory used".
- Outside the keryx shell a reviewer's CLI/MCP call has no caller marker. If it is the orchestrator's host that dispatches reviewers (Claude Code `Task`, Codex), their lookups are `unattributed`. That is why D1 matters.
- It is a text of calls, not a sandbox: an agent that wants to hide a read can use a path above. The check detects an honest or careless run.
- The log is a plain file in the package; an agent with file access can edit it. Tamper-evidence is not in this flow.

## Decisions for the operator

- D1: calls recorded as `unattributed` (CLI or MCP from a host that is not the keryx shell and carries no marker). Recommended: they only warn in the item's detail line and never block, because the same call is a legitimate reviewer lookup when the host runs reviewers itself; blocking would turn a false positive into a blocked publish. Alternative: they count as the orchestrator's and block; only safe if reviewers always run inside keryx.
- D2 (default if no answer): the pointer lives in the project data directory and is not committed.

## Acceptance criteria (draft 1)

- AC1: Recorder. `recordOrchestratorCall` appends a line that `memoryCalls` parses back to the same `search`, `accepted`, `query`, `time`; 50 concurrent appends from separate calls leave 50 intact lines; a read-only directory yields one warning and no exception. Check: `bun test src/review/orchestrator-log.test.ts`.
- AC2: Active package. `review start`/`attach` write the pointer and `close` removes it; a pointer to a missing or closed package is ignored; with no pointer the recorder creates no file. Check: `bun test src/review/active-review.test.ts`.
- AC3: CLI. With an active package, `keryx memory search "q" --status accepted` appends one entry (`source: "cli"`) and its stdout and exit code equal those of a run without an active package; without one, no file appears. Check: `bun test src/commands/memory-orchestrator-log.test.ts`.
- AC4: MCP. With an active package, `memory_search`, `memory_handoff` and `memory_propose` each append one entry (`source: "mcp"`, the tool name, the query argument); the tool result is unchanged. Check: `bun test src/mcp/metaproject-orchestrator-log.test.ts`.
- AC5: Shell and children. In a scripted `keryx shell` session with an active package, the parent's `keryx memory search` shell command and built-in `memory_search` are recorded with `caller: "orchestrator"`; the same calls made by a `spawn_subagent` child are recorded with the child's reviewer id and `KERYX_REVIEW_CALLER` is present in the child's command environment and absent from the parent's. Check: `bun test src/commands/agent-orchestrator-log.test.ts`.
- AC6: Readiness. Over a recorded log: an extra orchestrator memory call (blocked, detail names it); a stage-only log (ready); a reviewer-id call (ready); an `unattributed` call (ready with a warning in the detail under D1-recommended, blocked under the alternative); a log holding only `log-start` (ready, "no memory call recorded"); no file (ready, "no log", as today). Check: `bun test src/review/memory-outside-stage-auto.test.ts`.
- AC7: Surfaces. `review readiness`, `review status` and the TUI readiness row show the recorded-versus-no-log difference and the unattributed count with the same wording. Check: `bun test src/review/readiness.test.ts src/tui/review-readiness.test.ts` (new cases only, existing cases unedited).
- AC8: Skill. Both `review-orchestrator` `SKILL.md` and `SKILL.detail.md` copies (bundled and `.metaproject`, byte-identical, under the 1615-line ceiling) say keryx writes the orchestrator log and the agent must not edit it, and no longer tell the agent to append its tool calls. Check: `bun test src/review/orchestrator-log-skill.test.ts` plus the existing skill-copy parity test.
- AC9: Docs and limits. `docs/docs/guides/review-with-a-record.md`, `docs/docs/cli-reference.md` and CHANGELOG describe the automatic log and carry the four honest limits above. Check: `bun test cli-reference-coverage` and `mkdocs build --strict` stay green; a test asserts the limits sentence in the guide.
- AC10: Nothing else moves. The ten readiness items, `cleanContext`, `layersUsed` and the files `memory-outside-stage.test.ts`, `layers-usage.test.ts`, `clean-context.test.ts` pass unedited. Check: `bun test src/review/memory-outside-stage.test.ts src/review/layers-usage.test.ts src/review/clean-context.test.ts`.

## Risks

- A blocking check that reads a log the agent can influence, with false positives from unmarked reviewer calls: contained by D1 and by recording only attributed orchestrator calls as blocking.
- CLI and MCP processes run in parallel with the shell; atomic `O_APPEND` writes of one short line each avoid interleaving, tested in AC1.
- Stale pointer after a crashed review: ignored by the manifest-status check (AC2).

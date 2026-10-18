# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Recorder. `recordOrchestratorCall` appends a line that `memoryCalls` parses back to the same `search`, `accepted`, `query`, `time`; 50 concurrent appends from separate calls leave 50 intact lines; a read-only directory yields one warning and no exception. [verify: exec `bun test src/review/orchestrator-log.test.ts`]
- AC2: Active package. `review start` and `review attach` write the pointer and `close` removes it; a pointer to a missing or closed package is ignored; with no pointer the recorder creates no file. [verify: exec `bun test src/review/active-review.test.ts`]
- AC3: CLI. With an active package, `keryx memory search "q" --status accepted` appends one entry (`source: "cli"`) and its stdout and exit code equal those of a run without an active package; without one, no file appears. [verify: exec `bun test src/commands/memory-orchestrator-log.test.ts`]
- AC4: MCP. With an active package, `memory_search`, `memory_handoff` and `memory_propose` each append one entry (`source: "mcp"`, the tool name, the query argument); the tool result is unchanged. [verify: exec `bun test src/mcp/metaproject-orchestrator-log.test.ts`]
- AC5: Shell and children. In a scripted `keryx shell` session with an active package, the parent's `keryx memory search` shell command and built-in `memory_search` are recorded with `caller: "orchestrator"`; the same calls made by a `spawn_subagent` child are recorded with the child's reviewer id, and `KERYX_REVIEW_CALLER` is present in the child's command environment and absent from the parent's. [verify: exec `bun test src/commands/agent-orchestrator-log.test.ts`]
- AC6: Readiness. Over a recorded log: an extra orchestrator memory call is blocked and the detail names it; a stage-only log is ready; a reviewer-id call is ready; an `unattributed` call is ready with a warning in the detail (decision D1); a log holding only `log-start` is ready with "no memory call recorded"; no file is ready with "no log", as today. [verify: exec `bun test src/review/memory-outside-stage-auto.test.ts`]
- AC7: Surfaces. `review readiness`, `review status` and the TUI readiness row show the recorded-versus-no-log difference and the unattributed count with the same wording; new cases only, existing cases unedited. [verify: exec `bun test src/review/readiness.test.ts src/tui/review-readiness.test.ts`]
- AC8: Skill. Both `review-orchestrator` `SKILL.md` and `SKILL.detail.md` copies (bundled and `.metaproject`, byte-identical, under the 1615-line ceiling) say keryx writes the orchestrator log and the agent must not edit it, and no longer tell the agent to append its tool calls. [verify: exec `bun test src/review/orchestrator-log-skill.test.ts`]
- AC9: Docs and limits. `docs/docs/guides/review-with-a-record.md`, `docs/docs/cli-reference.md` and CHANGELOG describe the automatic log and carry the four honest limits (only calls through keryx are visible; unmarked calls outside the keryx shell are `unattributed`; the log is not a sandbox; the log is a plain editable file). [verify: exec `bun test src/review/orchestrator-log-docs.test.ts`]
- AC10: Nothing else moves. The ten readiness items, `cleanContext`, `layersUsed` and the tests `memory-outside-stage.test.ts`, `layers-usage.test.ts`, `clean-context.test.ts` pass unedited. [verify: exec `bun test src/review/memory-outside-stage.test.ts src/review/layers-usage.test.ts src/review/clean-context.test.ts`]

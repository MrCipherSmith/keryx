# keryx shell: background job/watcher tool + sidebar

Status: formalized (rescoped after user review — see note below)
Source: user description (RU), clarified via three AskUserQuestion rounds

## Scope note

This flow originally also covered a "budgeted idle-nudge watchdog" (auto
re-sending "продолжай" when the agent stalls). The user explicitly asked to
drop that coupling and solve it separately later — it is **out of scope**
here. The directory/title still says "watchdog" because flow ids/dirs are
never renamed by hand (see `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`);
this description is the source of truth for actual scope.

## Problem

`keryx shell` has no way to run a long-lived script/process (tests in watch
mode, a dev server, a log tail) in the background while the main agent keeps
working, and see it live in the sidebar. `shell_exec`
(`src/harness/tool/builtin/shell-exec-tool.ts`) is synchronous-only with a
120s deadline.

The sidebar Activity panel (`src/tui/worker-fleet.ts` `WorkerFleet` +
`src/tui/subagent-bridge.ts`) already does live status display, but only for
`spawn_subagent` dispatches and the ephemeral side-worker.

## Reference: how other agent CLIs do this

- **Claude Code** (this harness) has the most complete model: `Bash` with
  `run_in_background` (fire-and-forget, one completion notification),
  `Monitor` (a persistent watcher: any stdout line is an event), `TaskOutput`
  (read current status/output, blocking or not), `TaskStop` (cancel).
- **Codex CLI**: background exec exists, but "wake me on background output"
  is an open, unshipped feature request
  ([openai/codex#29865](https://github.com/openai/codex/issues/29865),
  [#29922](https://github.com/openai/codex/issues/29922)).
- **OpenCode**: background tasks exist (native or via the oh-my-opencode
  plugin), but showing them in the sidebar is an open, unshipped issue
  ([anomalyco/opencode#8322](https://github.com/anomalyco/opencode/issues/8322)).

keryx already has the sidebar half (`WorkerFleet`) that Codex and OpenCode
are still missing; it is missing the background-job half that Claude Code
has.

## Expected Outcome

A builtin tool set lets the agent start a long-lived background job from
inside `keryx shell`. The job appears in the sidebar Activity panel
(reusing `WorkerFleet`, same panel subagents already use) with live
status and a live last-output-line, can be inspected on demand, and can be
stopped. Per the user's explicit choice: matching events (e.g. a "FAIL" line)
update the sidebar only — they never interrupt the transcript or the main
agent's turn on their own; the agent decides when to check a job's output.

## Expected Outcome (revised)

A `watch_job` tool, matching Claude Code's own `Monitor` primitive, is
included: an agent-authored command (typically a filtered pipeline —
`tail -f build.log | grep --line-buffered -E "FAIL|Error"`) where each
completed stdout line is one **event**, run either `persistent` (session-
length, until `stop_job`) or bounded by `timeout_ms`. Per the user's earlier
confirmed choice, events update the sidebar (last event text + event count)
and never push into the transcript on their own — that is the one deliberate
divergence from Claude Code's `Monitor`, which pushes a chat notification per
event. `start_job` and `watch_job` share one job registry/id-space, so
`job_output`/`list_jobs`/`stop_job` work uniformly across both.

## Forward-looking note (not this flow's scope, shapes the design)

`start_job`/`watch_job` take an arbitrary shell `command`, the same as
`shell_exec` — nothing about them is test/log-specific. That means this same
primitive is already the right shape to later launch another CLI (`codex
exec ...`, another `keryx shell -p ...`, any agentic tool) as a background
worker visible in the sidebar next to subagents, not just scripts/watchers.
No extra design work is needed now for that to work — worth keeping in mind
so nothing in this implementation accidentally narrows `command` to
"test/build tooling only" (e.g. no special-casing of test-runner output
formats).

## Out of Scope

- Any "idle nudge" / stalled-agent behavior (separate future flow).
- The `ws` (WebSocket) event source Claude Code's `Monitor` supports — no
  clear keryx use case yet; command/pipeline sources only for v1.
- External IPC / new listening sockets — everything here is in-process,
  same as today's `shell_exec`/`spawn_subagent`.
- Persisting job state across shell restarts.

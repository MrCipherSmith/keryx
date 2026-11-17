# Diagnose shell startup

Startup diagnostics are opt-in and separate from `--debug` session recording.
Use a runtime containing the startup trace feature (PR #1035):

```bash
KERYX_SHELL_STARTUP_TRACE=/tmp/keryx-startup.jsonl keryx shell
# Development checkout with Bun and dependencies installed:
KERYX_SHELL_STARTUP_TRACE=/tmp/keryx-startup.jsonl bun src/cli.ts shell
```

The destination's parent directory must exist. Records append; use a new file
for separate runs. Unset the variable to disable diagnostics: no tracing timer
or file output is created. An unwritable destination emits a warning rather
than preventing startup.

## Read the JSONL records

Each completed scope appends one JSON object per line:

| Field | Meaning |
|---|---|
| `scope` | `hooks.build`, `shell.make-agent-deps`, or `tui.loading` |
| `pid` | Process id |
| `durationMs` | Scope wall-clock time, not CPU time |
| `stages[].stage` | Checkpoint, such as `orientation` or `tools-mcp-and-config` |
| `stages[].durationMs` | Time since the previous mark or scope start |
| `stages[].elapsedMs` | Time since scope start |
| `eventLoop.maxLagMs` | Maximum observed timer lateness, with a 25 ms cadence |
| `eventLoop.samples` | Number of timer callbacks observed |

Marks and completion also check for overdue timers before a callback fires.
Lateness is not a task's duration and does not establish why animation stopped.
Compare the largest incremental stages with timer lateness: slow asynchronous
work need not block rendering. Scopes overlap; do not add their totals. They do
not cover all process startup time. The interval after the last mark is in the
total, not a separate stage. Low sample counts do not prove responsiveness.

Records contain timing metadata, not prompts or session content. New files
request mode `0600`; existing permissions are unchanged. Keep traces local.
Orientation reuses one Git status result per preparation, not across launches.
Failed freshness checks remain unknown. Compare cold and warm runs separately;
no fixed speedup or complete animation-stall fix is guaranteed.

## Continuous Shell and review diagnostics

Separately from the opt-in startup trace, every new Shell session writes a
continuous journal, including when running a review. Use `/diag` to see its
path and any write failure. The path is
`<runtime.cacheDir>/diagnostics/<shell-session-id>.events.ndjson`; this internal
Shell ID can differ from the saved conversation ID.

The journal records call start, stage and completion events, active-call
snapshots every 30 seconds, and Work modal opening, painting, layout, closing
and errors. Work measurements contain counts, dimensions and flags, not item
labels or results. It does not record prompts, responses or file contents.

Each agent turn is journaled too: `turn.begin`, a `turn.phase` row for each step
of the turn (model request, tool batch, a call's execution, result shown,
output persisted, result accepted into history, batch end) carrying the turn,
batch (`r<round>`) and call ids, and `turn.end` with the last phase reached.
Snapshots list open turns with the phase each is in. A turn that stays more
than 10 minutes in a step that should take milliseconds, or keeps waiting on
tool calls after none is in flight, is written as `turn.stall` with a
diagnostics dump. `session.lease_lost`, `session.save_refused` (once per loss)
and `session.detached.output_skipped` mark the moment this Shell stopped
saving the conversation; an operator line sent after that is answered with a
"Not saved" notice.

Files are private to the owner and rotate at 1 MB, retaining one `.1` copy.
A write failure warns without stopping the review. A blocked event loop also
stops periodic snapshots: inspect the last persisted events, not an assumed
heartbeat. Restart an older Shell to enable this journal.

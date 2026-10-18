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

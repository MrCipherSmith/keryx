# Background task execution P1: a finished task wakes the agent without polling

Status: formalized
Source: `docs/requirements/keryx-background-task-execution/` v1.1.0, phase P1
Predecessor: flow 263 (P0, shipped in 0.2.108)

## Problem

P0 made every `shell_exec` a supervised task: a command that outlives the yield
keeps running and the call returns a `task_id`. What P0 did **not** do is tell
the agent when that task finishes. Today the model must remember to call
`shell_job_output(task_id)`, which is the same class of defect P0 removed from
the foreground path — a correct outcome that depends on the model choosing to
ask for it.

Three consequences, all live:

1. **A finished task is silent.** Nothing reaches the agent; the transcript ends
   with a handle and no result unless the model polls.
2. **`--print` and unattended runs lose the result entirely.** The line iterator
   ends after the single prompt (`src/commands/shell.ts:2373-2379`), the process
   exits, and the session sweep kills the task. The command's output is never
   reported by anyone.
3. **Nothing bounds automatic wakes.** Once completions can start a turn, a task
   that starts another task can loop with nobody at the keyboard.

## Expected Outcome

- A task that finishes without the agent having seen its terminal status
  produces exactly one notification, delivered at most once.
- The notification is a dedicated message — a `<task-notification>` envelope
  with a banner marking the text as command output, not operator instructions —
  pushed only at a round boundary, never between two `tool` results answering
  one batch.
- An idle interactive session (TUI or readline) starts a turn from that
  notification; operator input always wins over it.
- A session that cannot be woken (`--print`, `deps.unattended === true`) holds
  its turn open while its own tasks run, bounded by `KERYX_SHELL_HOLD_MS`
  (30 min) and by each task's idle timeout, then reports what it got.
- Consecutive completion-started turns are capped (`KERYX_SHELL_MAX_AUTO_WAKE`,
  default 5) and the counter resets on any operator input.
- No recurring "still running" reminder is ever emitted (D-06, F9).

## Out of Scope

- The `shell_task_output` / `shell_task_wait` / `shell_task_kill` tools, the
  `invoke(input, ctx.signal)` cancellation seam, operator demote, and the
  side-worker deny-list — all P2 (D-15, D-16).
- The wiki rewrite, the stale rows in the shell/TUI test catalog, and the
  `shell-task-*.ts` file split — all P3, deferred by the owner's recorded
  decision in flow 263.
- On-disk full task output (D-18).
- Any change to the approval gate, the OS sandbox, process-group ownership or
  the session-scoped lifetime.

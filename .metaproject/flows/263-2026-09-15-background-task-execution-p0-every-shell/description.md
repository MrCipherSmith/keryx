# Background task execution P0: every shell_exec is a supervised task with a bounded yield

Status: formalized
Source: `docs/requirements/keryx-background-task-execution/` v1.1.0 (phase P0 + idle timeout)

## Problem

`shell_exec` blocks the whole agent turn on `await proc.exited` unless the model
remembers to set the optional `background: true`
(`src/harness/tool/builtin/shell-exec-tool.ts:238`, `:157`). A live session ran
`sleep 120 && gh run list …` without the flag: the turn froze for the full 120 s
wall-clock deadline (`:46`, `:176-182`), the command was killed, and a later
`shell_job_kill` failed because the call was never a tracked job. The deadline is
wall-clock, so a command still producing output is killed too.

## Expected Outcome

- Every `shell_exec` call in a session that has a task registry starts a
  supervised task and returns within `yieldMs` (default 10 s): the
  synchronous-shaped result when the command exited in time, otherwise a task
  handle while the command keeps running in the background.
- The wall-clock deadline is replaced by an idle timeout (default 120 s without
  output), with a per-call `idle_timeout_ms` escape clamped to [1 s, 30 min].
- Terminal statuses are `completed` / `failed` / `killed` + `killReason`.
- The concurrency cap counts only background-phase tasks, so a short command is
  never refused.
- The TUI sidebar lists a task only once it has become a background task.
- Approval gate, OS sandbox, process-group kill and session sweep are unchanged.

## Out of Scope

- Completion notification / waking the agent, `hold` delivery, auto-wake cap
  (P1: D-09, D-10, D-11).
- `shell_task_output` / `shell_task_wait` / `shell_task_kill`, the tool `signal`,
  operator demote, side-worker deny-list changes (P2: D-15, D-16).
- Wiki/ADR rewrite and package status update (P3).
- On-disk full output (D-18).

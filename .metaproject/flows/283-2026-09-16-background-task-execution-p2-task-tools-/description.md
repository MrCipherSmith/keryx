# Background task execution P2: task tools, cancellation, operator demote and side-worker rules

Status: formalized
Source: docs/requirements/keryx-background-task-execution (v1.1.0), phase P2

## Problem

P0 made every shell command a supervised task that returns within a bounded
wait. P1 made a finished task report itself exactly once. What is still missing
is everything between those two moments: while a task runs, neither the agent nor
the operator can act on it.

Concretely, and each one is a live gap rather than a nicety:

- **The agent cannot wait deliberately.** There is no `shell_task_wait`, so a
  model that needs a build to finish before the next step has only two options:
  poll `shell_job_output` in a loop, or start an unrelated step and hope. Polling
  burns rounds; hoping produces the interleavings P1's notification exists to
  repair.
- **The read cursor is implicit shared state.** `shell_job_output` advances a
  cursor nobody names, so two readers of the same task silently steal each
  other's output. `shell_task_output` takes an explicit `since`, which is what
  makes it safe to hand to a second reader at all.
- **A wait cannot be interrupted.** `InteractiveTool.invoke` takes only `input`
  and the loop checks the abort signal only BETWEEN calls, so a tool that waits
  is uninterruptible by construction: the operator's Ctrl-C cannot reach it, and
  the turn cannot be stopped until the wait's own bound fires.
- **The operator cannot demote a running command.** A foreground command the
  operator decides is long belongs in the background — but the only lever today
  is killing it, which throws away the work done so far.
- **Side workers can corrupt P1's delivery.** Delivery is exactly-once because a
  task carries an `observed` flag. A side worker that reads a terminal task marks
  it observed and the main session's notification disappears — the one failure
  mode P1 cannot defend against on its own, because it cannot tell which reader
  asked.

## Expected Outcome

- `shell_task_output`, `shell_task_wait` and `shell_task_kill` exist with the
  shapes §4.2 of the specification names; `shell_job_output` / `shell_job_kill`
  keep working as aliases for one release and accept both `job-*` and `task-*`
  ids.
- A wait is bounded (`timeout_ms` clamped to [0, 300 000]) and **abortable**: the
  turn's signal reaches the tool through `invoke(input, ctx)`, the call returns
  `interrupted: true` with the tasks still RUNNING, and their completions arrive
  later through P1's drain. An abort never kills a task.
- The operator can demote a running foreground task to the background without
  aborting the turn, through the same release path; the task keeps running and
  appears in the TUI list from its `phase` event.
- Side workers are denied kill, wait and the implicit-cursor read; they keep only
  `shell_task_output`, and their copy of it never marks a task observed, so the
  main session's notification survives any number of side-worker reads.
- P0's and P1's behaviour is unchanged: approval, sandbox, process-group kill,
  the session sweep and exactly-once delivery all keep their existing proofs.

## Out of Scope

- A streaming `monitor` tool and a recurring scheduler (D-08, follow-on package).
- On-disk full output / `outputFile` (D-18): retained output stays the 2 MiB ring
  shrunk to a 4 000-byte tail after delivery.
- Detaching a task beyond session exit (D-04): session-scoping is kept.
- Any change to the approval gate or the OS sandbox (D-05): reused unchanged.
- The documentation sweep (P3).

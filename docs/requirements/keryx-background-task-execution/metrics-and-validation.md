# Keryx Background Task Execution — Metrics and Validation
Version: 1.1.0

Every criterion in this package is stated as a measurable invariant with a
named proof. A row is `met` only when the named proof exists and passes; every
other row stays `planned` and its "Proof" column names the test that will have
to exist for it to move.

Phase P0 shipped on 2026-09-16 (keryx flow 263, branch `feat/shell-task-supervisor`):
the bounded yield, the supervised-task model, the idle timeout (pulled forward
from P1), the derived statuses and the phase-gated TUI list. The rows it proves
are marked `met (P0)`.

Phase P1 shipped on 2026-09-16 (keryx flow 265, branch `feat/shell-task-completion`):
completion delivery, the hold and the wake cap. Its rows are marked `met (P1)`,
or `met (P1, audit)` where the proof is a source audit rather than an executed
path — the two REPL loops have no headless seam, so the load-bearing behaviour is
proven by execution in `agent-task-notification.test.ts` and
`background-job-registry.test.ts`, and the audit only pins that the shells are
wired to it. The task tools, tool cancellation and side-worker rules (P2) are not
shipped, so their rows are untouched.

## Invariants

| # | Invariant | Measure | Proof | Status |
|---|---|---|---|---|
| M1 | A `shell_exec` call returns within `yieldMs` regardless of command duration. | Wall time from call to tool result. | `shell-exec-background.test.ts`, flow-263 AC1: a never-exiting fake with `yieldMs: 50` returns a `task-<n>-<pid>` handle well under 2 s. | met (P0) |
| M2 | The observed incident does not recur. | `shell_exec("sleep 120 && …")` with no flag must not block the turn for 120 s. | Same file, the incident command verbatim; plus a live run against real processes: returned in 3 006 ms with a handle, then readable and killable. | met (P0) |
| M3 | A command that exits within `yieldMs` returns the synchronous-shaped result. | Result shape and exit code. | Same file, flow-263 AC2: trimmed output, `(no output; exit N)`, `isError` on non-zero, 20 000-byte head cap with `…(truncated)`. | met (P0) |
| M4 | Idle-based killing, not wall-clock. | Kill time of (a) a chatty command outliving several idle windows, (b) a silent command. | `background-job-registry.test.ts`, flow-263 AC3: paired fakes and paired REAL processes (2 s idle window, ~100 ms ticks) — the chatty one ends `completed`, the silent one `killed`/`idle`; the user-facing message is covered on every platform by a scripted fake in `shell-exec-background.test.ts`. | met (P0) |
| M5 | Completion is delivered without polling. | A turn that started a task receives a terminal event with no `shell_task_output` call. | `agent-task-notification.test.ts`, flow-265 AC5: "the completion arrives without any shell_job_output call and without a sleep" — the turn starts a task, the task exits, and the next round carries the notification with no read tool in the transcript. | met (P1) |
| M6 | Exactly one terminal event per task, delivered at most once. | Event count per task; delivery count per event. | `background-job-registry.test.ts`, flow-265: drained once with the full record; "two drains in the SAME synchronous tick never both return the task"; a task read through `shell_job_output` after it ended, or killed by the model, is never drained; polling a still-running task does not mark it observed. Plus `agent-task-notification.test.ts`: "a delivered completion is never re-announced in later rounds". | met (P1) |
| M7 | A wait is interruptible by the operator. | Time from user message to the message's turn starting. | Test: a turn blocked in `shell_task_wait`; assert a queued message pre-empts it. | planned |
| M8 | Process-group kill reaches a grandchild. | Grandchild liveness after kill. | `shell-exec-background.test.ts` AC6 (through `shell_exec`) and `background-job-registry.test.ts` AC3 (direct): both assert the grandchild is alive and `pgid === pid` BEFORE the kill, then poll until its specific pid is gone. | met (P0) |
| M9 | No unbounded growth. | Retained output and tracked-task count over a long session. | `background-job-registry.test.ts`: ring cap with auto-kill, LRU eviction of terminated tasks, cursor rebasing after truncation, tail-shrink on exit. Per terminated task the retained bytes are the 4 KB tail plus the 24 KB head snapshot. | met (P0) |
| M10 | Approval, sandbox and session sweep are unchanged. | Existing test suites still pass. | `shell-exec-tool.test.ts`, `shell-exec-timeout.test.ts`, `shell-exec-background.test.ts`, `background-job-registry.test.ts`, `interactive-agent-tools.test.ts`, `agent-permission-mode.test.ts`, `agent.test.ts`, `shell.test.ts`, `tui-shell.test.ts`, and, from P1, `agent-task-notification.test.ts` — and the full suite: 10 401 pass, 20 skip, 0 fail on the P1 run (10 297 on the P0 run). | met (P0, re-proved P1) |
| M11 | A `hold` session reports a result that outlives the yield. | Final output of a `--print` turn. | `agent-task-notification.test.ts`: the turn waits for the completion and continues with the notification; the hold is abortable by `options.signal`; a task still running past `KERYX_SHELL_HOLD_MS` is killed with `hold-timeout` and reported. Paired with a LIVE smoke on a real process (`sleep 2` against `yieldMs: 300`): 3 rounds, elapsed 2 023 ms, one notification, `status="completed"` — journal, flow 265 T10. (AC9) | met (P1) |
| M12 | Automatic wakes are capped. | Completion-started turns without operator input. | `agent-task-notification.test.ts` proves the resolver by execution (`KERYX_SHELL_MAX_AUTO_WAKE`: default 5, malformed and negative fall back, explicit 0 disables); `shell.test.ts` and `tui-shell.test.ts` audit that both REPLs apply the cap and reset the counter on operator input. The multi-wake chain end to end is not executable: neither REPL has a headless seam. (AC10) | met (P1, audit) |
| M13 | Side workers cannot touch main-session tasks. | Side-worker tool list; `observed` flag; cursor. | Test: the side-worker tool list lacks kill/wait/`shell_job_output`; a side-worker `shell_task_output` of a terminal task leaves the main notification pending. (AC11) | planned |
| M14 | The cap never blocks a short command. | Running-task count; short-command result. | `shell-exec-background.test.ts` and `background-job-registry.test.ts`, flow-263 AC5: with the cap full a foreground call still returns its result, `background:true` is refused naming the running command, a promoted task is never killed for the cap, and running tasks stay at or below `maxConcurrent + 1`. (AC12) | met (P0) |
| M15 | Abort releases a wait without killing. | Time from abort to tool result; task status. | Test: abort during `shell_task_wait` with an injected timer; assert prompt return, `interrupted: true`, task still `running`. (AC13) | planned |
| M16 | Notifications never split a tool batch. | Message order in history. | `agent-task-notification.test.ts`: a completion arriving mid-batch "lands AFTER both tool results of a parallel batch and before the next round"; the drain sits at the round boundary, not at the tool-result push. (D-10) | met (P1) |

## Measurement discipline

- **No wall-clock assertions where a controlled seam exists.** Yield and idle
  timing are driven by an injectable clock/timer, not real sleeps, except for
  the two paired tests in M4 and M8 which need a real process.
- **Pairs, not single observations.** M4 and M8 each assert both the positive
  and the negative case, so "nothing happened" cannot pass as "the boundary
  held".
- **The incident is the test.** M2 is written from the real transcript, not from
  a paraphrase of the bug.
- **No claim without a `file:line` or a test.** Rows marked `met (P0)` or
  `met (P1)` name the test that proves them; everything else stays `planned`.
  See README §Status for what has shipped.

## Regression surface

| Surface | Existing proof that must keep passing |
|---|---|
| Synchronous shell behaviour | `src/harness/tool/builtin/shell-exec-tool.test.ts`, `shell-exec-timeout.test.ts` |
| Background registry bounds and process-group kill | `src/harness/tool/builtin/background-job-registry.test.ts` |
| Approval across modes | `src/commands/agent-permission-mode.test.ts` |
| Session-scoped sweep | `src/commands/shell.test.ts`, `src/tui/tui-shell.test.ts` |
| Tool-call budget split / repeatable tools | `src/commands/agent.test.ts` |

# Keryx Background Task Execution — Metrics and Validation
Version: 1.1.0

Every criterion in this package is stated as a measurable invariant with a
named proof. Nothing here is claimed as met: the package is `spec ready`, so
each row's status is `planned` and the "Proof" column names the test that will
have to exist for the row to move to `met`.

## Invariants

| # | Invariant | Measure | Proof (planned) | Status |
|---|---|---|---|---|
| M1 | A `shell_exec` call returns within `yieldMs` regardless of command duration. | Wall time from call to tool result. | Test: a fake runner that never exits; assert the result arrives at ~`yieldMs` and carries a task handle. | planned |
| M2 | The observed incident does not recur. | `shell_exec("sleep 120 && …")` with no flag must not block the turn for 120 s. | Regression test built from the incident transcript; assert return ≤ `yieldMs`. | planned |
| M3 | A command that exits within `yieldMs` returns the synchronous-shaped result. | Result shape and exit code. | Test: `echo hi`; assert output/exit code, no handle required. | planned |
| M4 | Idle-based killing, not wall-clock. | Kill time of (a) a chatty >120 s command, (b) a silent command. | Two paired tests: (a) emits output every second for 180 s and is **not** killed; (b) silent for `idleMs` and **is** killed with a stated reason. | planned |
| M5 | Completion is delivered without polling. | A turn that started a task receives a terminal event with no `shell_task_output` call. | Test: start a task, end the turn, assert the completion notification is delivered exactly once. | planned |
| M6 | Exactly one terminal event per task, delivered at most once. | Event count per task; delivery count per event. | Test: kill a task racing its own natural exit; assert one terminal event, one delivery, idempotent replay. | planned |
| M7 | A wait is interruptible by the operator. | Time from user message to the message's turn starting. | Test: a turn blocked in `shell_task_wait`; assert a queued message pre-empts it. | planned |
| M8 | Process-group kill reaches a grandchild. | Grandchild liveness after kill. | Test: `sh -c 'sleep 300 &'`; kill; assert the grandchild is gone (the flow-173 process-group test is the model). | planned |
| M9 | No unbounded growth. | Retained output and tracked-task count over a long session. | Test: many short tasks + one chatty task; assert the ring cap, the LRU bound, and cursor correctness after truncation. | planned |
| M10 | Approval, sandbox and session sweep are unchanged. | Existing test suites still pass. | `shell-exec-tool.test.ts`, `shell-exec-background.test.ts`, `background-job-registry.test.ts`, `agent-permission-mode.test.ts`, `shell.test.ts`, `tui-shell.test.ts`. | planned |
| M11 | A `hold` session reports a result that outlives the yield. | Final output of a `--print` turn. | Test: fake task exiting after `yieldMs`; assert the turn continues and reports it. Paired: a task past `holdMs` is killed with `hold-timeout`. (AC9) | planned |
| M12 | Automatic wakes are capped. | Completion-started turns without operator input. | Test: tasks that each start another task; assert exactly `maxAutoWake` turns, then the pending notification lands before the next operator line. (AC10) | planned |
| M13 | Side workers cannot touch main-session tasks. | Side-worker tool list; `observed` flag; cursor. | Test: the side-worker tool list lacks kill/wait/`shell_job_output`; a side-worker `shell_task_output` of a terminal task leaves the main notification pending. (AC11) | planned |
| M14 | The cap never blocks a short command. | Running-task count; short-command result. | Test: `maxConcurrent` background fakes running; assert `echo hi` returns synchronously and the count never exceeds `maxConcurrent + 1`. (AC12) | planned |
| M15 | Abort releases a wait without killing. | Time from abort to tool result; task status. | Test: abort during `shell_task_wait` with an injected timer; assert prompt return, `interrupted: true`, task still `running`. (AC13) | planned |
| M16 | Notifications never split a tool batch. | Message order in history. | Test: a completion arriving mid-batch; assert it follows the batch's last `tool` result. (D-10) | planned |

## Measurement discipline

- **No wall-clock assertions where a controlled seam exists.** Yield and idle
  timing are driven by an injectable clock/timer, not real sleeps, except for
  the two paired tests in M4 and M8 which need a real process.
- **Pairs, not single observations.** M4 and M8 each assert both the positive
  and the negative case, so "nothing happened" cannot pass as "the boundary
  held".
- **The incident is the test.** M2 is written from the real transcript, not from
  a paraphrase of the bug.
- **No claim without a `file:line` or a test.** This package claims no runtime
  implementation; see README §Status.

## Regression surface

| Surface | Existing proof that must keep passing |
|---|---|
| Synchronous shell behaviour | `src/harness/tool/builtin/shell-exec-tool.test.ts`, `shell-exec-timeout.test.ts` |
| Background registry bounds and process-group kill | `src/harness/tool/builtin/background-job-registry.test.ts` |
| Approval across modes | `src/commands/agent-permission-mode.test.ts` |
| Session-scoped sweep | `src/commands/shell.test.ts`, `src/tui/tui-shell.test.ts` |
| Tool-call budget split / repeatable tools | `src/commands/agent.test.ts` |

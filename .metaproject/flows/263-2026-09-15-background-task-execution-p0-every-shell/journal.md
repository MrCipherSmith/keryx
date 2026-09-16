# Flow Journal

- 2026-09-15T18:39:16.109Z - flow created
- 2026-09-15T19:31:21.138Z - task-done: T1: Collect remaining context
- 2026-09-15T19:31:21.301Z - task-done: T2: Implement per plan
- 2026-09-15T19:31:21.547Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-15T19:31:21.845Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-15T19:31:29.109Z - task-added: T5: RED tests for AC1-AC8
- 2026-09-15T19:31:29.253Z - task-added: T6: Registry: task ids, phase, statuses, killReason, waitForExit, promote, idle timer, config resolvers
- 2026-09-15T19:31:29.410Z - task-added: T7: shell_exec: bounded yield path, schema and description
- 2026-09-15T19:31:29.531Z - task-added: T8: TUI BackgroundJobStore: phase gating and new statuses
- 2026-09-15T19:31:29.649Z - task-added: T9: Verify: typecheck, AC9 suites, real-process incident smoke
- 2026-09-15T19:31:29.769Z - task-added: T10: Review the P0 diff and fix findings
- 2026-09-15T19:31:29.913Z - task-added: T11: Journal deviations and update prompt/comment text
- 2026-09-15T19:31:40.391Z - frozen: 9 criteria; checksum recorded
- 2026-09-15T19:31:40.577Z - started
- 2026-09-15T19:32:16.356Z - task-attempt: T5: started (attempt 1) — 263-T5 tests-creator dispatch

## Decisions and deviations from the requirements package

- **Registry evolved in place, not split into `shell-task-*.ts`.** Spec §2 names
  three new files. The P0 diff keeps `background-job-registry.ts` and
  `shell-exec-tool.ts` so the behavioural change is reviewable rather than hidden
  inside a rename; field names stay `jobId` while id values become
  `task-<n>-<pid>`. The split (and `taskId` naming) is P3 work.
- **Idle timeout pulled from P1 into P0.** Once a foreground command outlives its
  yield it needs a timeout; keeping the wall-clock deadline for it would need a
  `killReason` outside the D-14 enum. So AC3 (spec P1) is delivered here, and P1
  is left with completion delivery only.
- **`start()` default phase is `background`.** Existing direct callers of
  `JobRegistry.start` keep flow-173 semantics (cap check, initial buffer);
  `shell_exec` passes `phase: "foreground"` explicitly.
- **Completion choice: create PR, merge, complete** — the owner's standing
  instruction for multi-phase keryx work (merge and close each phase's flow
  without asking). Execution metrics not collected for this run.

## T5 result (DONE_WITH_CONCERNS) — accepted

RED run on the 5 touched files: 51 pass / 56 fail, every failure a missing
export/behaviour. API points the tests settled, adopted as the contract for T6-T8:
background-phase starts (incl. `background:true`) emit exactly one `phase` event
right after `start`; a repeat `promote` emits nothing; the registry stores a
per-task `idleTimeoutMs` unclamped (clamping is `shell_exec`'s); `waitForExit`
on a finished task returns `exited` at once; `sweepAll` kills foreground tasks
too (`session-exit`); store output before `phase` sends no hint, and a dropped
task stays dropped.

Concerns and decisions:
- `src/tui/background-job-inspector.test.ts` feeds `start` without `phase` and
  `src/tui/job-bridge.test.ts` uses `status: "exited"` — both folded into T8's
  scope (update to the new contract), not left to fail.
- Default 120 s idle timers per task must be `unref`'d/cleared so test processes
  do not linger — folded into T6.
- New exports are read through `import * as` in the tests to avoid bun link-time
  errors while RED; T6/T7 may switch them to named imports.
- The 400 ms background-only initial-buffer assertion is load-sensitive; watch it
  in T9.
- 2026-09-15T19:42:57.423Z - task-done: T5: RED tests for AC1-AC8
- 2026-09-15T19:42:57.557Z - task-attempt: T6: started (attempt 1) — 263-T6T7 task-implementer dispatch (registry + shell_exec, coupled tests)
- 2026-09-15T19:42:57.654Z - task-attempt: T7: started (attempt 1) — 263-T6T7 task-implementer dispatch
- 2026-09-15T19:42:57.749Z - task-attempt: T8: started (attempt 1) — 263-T8 task-implementer dispatch

## T8 result (DONE_WITH_CONCERNS) — accepted

Store tests green (session 19, inspector 11, bridge 5). Pending entries live in a
separate hidden map; a dropped foreground task is simply deleted (no growing
"dropped ids" set). `background-job-inspector.ts` and `tui-shell.ts` needed no
change. Concern: the T8 commit does not typecheck on its own — its 22 errors all
come from the registry's old event union, which T6/T7 replaces. Decision: commit
at the task boundary anyway; the clean `bun run typecheck` is an explicit T9 check
after T6/T7 lands, and any spelling mismatch in `KillReason`/`phase`/`killReason`
is fixed there.
- 2026-09-15T19:47:27.877Z - task-done: T8: TUI BackgroundJobStore: phase gating and new statuses

## T6/T7 attempt 1 hung (2026-09-16)

The combined 263-T6T7 dispatch produced nothing: its transcript stopped growing
at 23:43 (~10 h idle), `background-job-registry.ts`/`shell-exec-tool.ts` matched
HEAD, and none of the new API (`waitForExit`, `promote`, `KillReason`,
`resolveShellIdleMs`, `resolveShellYieldMs`) existed. The agent was stopped and
the attempt recorded as blocked on both tasks.

Change of strategy for attempt 2: dispatch the two tasks separately and narrower
— T6 edits exactly one production file (the registry) and runs one test file;
T7 follows once the registry API exists. Shrinking the dispatch is the only
variable changed; the contract is unchanged.

## T6 result, attempt 2 (DONE_WITH_CONCERNS) — accepted

Registry tests 50/50 green; typecheck reports 0 errors in the registry itself.
Notes kept for later phases:
- Every kill path funnels through one idempotent `requestKill(job, reason)`
  (first reason wins) — that is what holds "exactly one exit event per task"
  across the model/operator/idle/output-cap/session-exit rails.
- `resolveShellIdleMs` inlines the literal `"KERYX_SHELL_TIMEOUT_MS"` rather
  than importing `ENV_SHELL_TIMEOUT_MS` from `shell-exec-tool.ts`, which would
  close an import cycle once T7 imports the registry at runtime.
- `promote` over a full cap names the other running background commands and
  never kills; the hard bound holds because later background starts are refused.
- Concern: widening the `JobRegistry` interface broke two hand-rolled stubs
  outside T6's scope — `src/commands/interactive-agent-tools.test.ts` (missing
  `waitForExit`/`promote`) and `src/tui/background-job-inspector.test.ts`
  (missing `waitForExit`). Folded into T7's dispatch as mechanical fixes.
- The model-facing descriptions of `shell_job_output`/`shell_job_kill` still
  say "background:true"; T7 owns that text.
- 2026-09-16T05:44:06.597Z - task-attempt: T6: blocked (attempt 2) — implementer hung: no transcript activity for ~10h, no code changes landed; stopped and re-dispatched
- 2026-09-16T05:44:07.007Z - task-attempt: T7: blocked (attempt 2) — same dispatch hung (263-T6T7)
- 2026-09-16T05:52:58.282Z - task-done: T6: Registry: task ids, phase, statuses, killReason, waitForExit, promote, idle timer, config resolvers
- 2026-09-16T05:52:58.470Z - task-attempt: T7: started (attempt 3) — 263-T7-retry task-implementer dispatch (shell_exec only, narrowed)

## T7 finished by the orchestrator after a second stall

The narrowed T7 dispatch wrote the whole yield path and then stalled again
(transcript idle 758 s). Its last message reported typecheck clean and 107/110
tests passing, with one failure it had diagnosed but not fixed. Per the skill's
escalation rule the work was not re-dispatched a third time: the orchestrator
verified and finished it.

**The bug it found, and the fix.** `shrinkTerminatedOutput` runs inside `onExit`
and keeps only the last `TERMINATED_OUTPUT_TAIL_BYTES` (4 000) of the ring. The
synchronous-shaped result is capped FROM THE START, and `onExit` runs before the
awaiting `shell_exec` resolves — so a command emitting more than 4 000 bytes and
exiting within the yield lost its head, and the AC2 truncation test failed.

Fix: the registry now snapshots the first `TASK_OUTPUT_HEAD_BYTES` (24 000) of a
task's transcript into `info.outputHead`, append-only, never rebased by the
ring's truncation and never shrunk on exit; `shell_exec` builds the synchronous
result from it and keeps the drained buffer as the fallback. 24 000 sits above
the tool's own 20 000-byte cap so a truncated transcript is still distinguishable
from one that exactly fills the cap. The ring, its tail-shrink and the F-009
memory bounds are untouched.

Verification after the fix: 143 pass / 0 fail / 2 skip across the nine
registry + shell_exec + TUI test files, and `bun run typecheck` clean.

## T9 evidence

- Typecheck: `bun run typecheck` exit 0.
- Nine registry/shell_exec/TUI files: 143 pass, 0 fail, 2 skip. The two `skipIf`
  guards are win32-only, so the real-process tests DID run here: `-t grandchild`
  → 1 pass (AC6), `-t REAL` on the registry → 2 pass (AC3 pair).
- AC9 suites: `agent.test.ts`, `agent-permission-mode.test.ts`, `shell.test.ts`,
  `tui-shell.test.ts` → 276 pass, 0 fail.
- Live smoke of the incident (real processes, real tool, no fakes;
  `yieldMs: 3000`):
  - `shell_exec("sleep 120 && echo done")` with no flag returned in **3 006 ms**
    with `{task_id: "task-1-78420", status: "running"}` and one `phase` event —
    where the reported incident froze the turn for 120 s and then failed.
  - `shell_job_output` read it, `shell_job_kill` stopped it → status `killed`,
    `killReason: "model"`, and the OS process was gone (the live failure was
    `shell_job_kill … not running`, because the blocking call was never a job).
  - `echo hello && echo oops 1>&2` → `hello\noops`, `isError: false`.
  - `exit 7` → `isError: true`, `(no output; exit 7)`.
  - `sleep 30` with `idleMs: 800` → killed, output names `KERYX_SHELL_IDLE_MS`
    and `idle_timeout_ms`.
- Review note for T10: an idle-killed command renders as
  `(no output; exit 143)` before the idle notice. Correct but clumsy — a killed
  task reporting a signal-derived exit code reads like a real exit status.
- Full suite: `bun test --timeout 30000` → **10 297 pass, 20 skip, 0 fail**
  across 761 files (769 s). The `--timeout 30000` is deliberate: the default 5 s
  produces load-induced flakes on this suite.
- `keryx test analyze` re-run so the testing context is not stale at push time.
- 2026-09-16T06:06:35.294Z - task-attempt: T7: blocked (attempt 4) — second stall: transcript idle 758s with the implementation already on disk; orchestrator verifies and finishes it
- 2026-09-16T06:11:40.555Z - task-done: T7: shell_exec: bounded yield path, schema and description
- 2026-09-16T06:24:50.871Z - task-done: T9: Verify: typecheck, AC9 suites, real-process incident smoke
- 2026-09-16T06:25:11.327Z - task-attempt: T10: started (attempt 1) — review wave: review-logic, review-regression, review-testing-practices

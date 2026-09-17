# Flow Journal

## What this phase actually was

Not a tidy-up. The page `.metaproject/wiki/architecture/background-jobs.md` had a
banner written for P0 and a body that, after P1 and P2, asserted the OPPOSITE of
the product in six places: "Poll, not push"; "push wakeup — not shipped anywhere
surveyed"; "the model is told once, at start"; `shell_job_output` as the
model-facing read; "changes to the synchronous `shell_exec` path — untouched";
and a side-worker deny list of one name. In this repository a wiki page is an
input to the routing layer, so that page was actively sending the next agent the
wrong way, with confidence.

**Method: correct, do not rewrite.** Everything that survived all three phases —
process-group ownership, sandbox reuse, the unchanged approval gate,
session-scoped lifetime, the bounded rails — was kept verbatim. A full rewrite
would have buried four real corrections in hundreds of changed lines and made the
review worthless. AC8 was written to force exactly that discipline, and it did.

## Two findings, both mine, both from the phase's own edits

1. **The `Describes:` front-matter pointed away from the code.** It listed the
   five flow-173 modules; after the rewrite the page's subject included
   completion delivery (`agent.ts`), the `/demote` parser (`agent-commands.ts`)
   and the roster carrying the observer split (`interactive-agent-tools.ts`). The
   wiki's page↔code linkage is built from that list, so a reader following the
   page to the implementation would have been sent to the old modules only.
2. **Targeted edits left two sections about one subject.** Inserting the
   task-tool table near the summary left the older `### Model-facing tools`
   heading in Details holding risk, approval and budget. Two headings for one
   subject is how a page starts drifting again; the Details heading now says what
   its content is.

Both were found by re-reading the page end to end rather than by trusting the
edits, and both were fixed before the round was ingested (510e38bb).

## Process notes worth keeping

- **The routing hook reads the REASON text, not just the command.** Closing T11
  failed because the reason string contained a raw `git diff …` phrase, which the
  gdctx hook refused on sight. The gate was not refusing the work — my sentence
  tripped a guard. Rephrased to name the routed form instead.
- **`--timeout 120000` is what a clean full run needs now.** This was the first
  fully green full suite of the session (10 425 pass / 20 skip / 0 fail, 625 s).
  The earlier "failures" at 30 s were two tree-scanning tests exceeding the bound
  under load, not regressions — the memory note now says so with the numbers.
- **The wiki index belongs to its generator.** I hand-edited the index entry
  first; `keryx wiki validate` immediately reported the index out of date.
  `keryx wiki index` regenerates it from the page itself, which is also why the
  page's own summary is worth writing well: it becomes the index entry.

- 2026-09-16T15:01:29.386Z - flow created
- 2026-09-16T15:04:15.419Z - frozen: 13 criteria; checksum recorded
- 2026-09-16T15:04:15.541Z - started
- 2026-09-16T15:04:15.646Z - task-added: T5: Rewrite the wiki page around the supervised-task model, keeping what stayed true
- 2026-09-16T15:04:15.744Z - task-added: T6: Correct Prior art and Out of scope: poll-not-push, push wakeup, the synchronous path
- 2026-09-16T15:04:15.839Z - task-added: T7: Document the task tools, the deprecated aliases, side-worker rules and the operator levers
- 2026-09-16T15:04:15.931Z - task-added: T8: Refresh the wiki index entry for the page
- 2026-09-16T15:04:16.040Z - task-added: T9: Rewrite the test-catalogue rows TOOL-11 and BGJOB-01..03
- 2026-09-16T15:04:16.132Z - task-added: T10: Mark P3 in the requirements package (README, specification, PRD gap row)
- 2026-09-16T15:04:16.231Z - task-added: T11: Verify: wiki validate, retired-vocabulary grep, no src changes, health, full suite
- 2026-09-16T15:04:16.329Z - task-added: T12: Review round ingested against the head that will merge
- 2026-09-16T15:04:16.423Z - task-added: T13: Journal deviations and close the flow
- 2026-09-16T15:05:01.077Z - task-done: T1: Collect remaining context
- 2026-09-16T15:05:01.209Z - task-done: T2: Implement per plan
- 2026-09-16T15:05:01.302Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-16T15:05:01.391Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-16T15:05:01.489Z - task-attempt: T5: started (attempt 1) — rewrite the wiki page around the supervised-task model, correcting claims rather than re-deriving surviving prose
- 2026-09-16T15:09:42.956Z - task-done: T5: Rewrite the wiki page around the supervised-task model, keeping what stayed true
- 2026-09-16T15:09:43.077Z - task-done: T6: Correct Prior art and Out of scope: poll-not-push, push wakeup, the synchronous path
- 2026-09-16T15:09:43.178Z - task-done: T7: Document the task tools, the deprecated aliases, side-worker rules and the operator levers
- 2026-09-16T15:09:43.271Z - task-done: T8: Refresh the wiki index entry for the page
- 2026-09-16T15:09:43.379Z - task-done: T9: Rewrite the test-catalogue rows TOOL-11 and BGJOB-01..03
- 2026-09-16T15:09:43.491Z - task-done: T10: Mark P3 in the requirements package (README, specification, PRD gap row)
- 2026-09-16T15:24:41.818Z - task-done: T11: Verify: wiki validate, retired-vocabulary grep, no src changes, health, full suite
- 2026-09-16T15:28:38.388Z - task-done: T12: Review round ingested against the head that will merge
- 2026-09-16T15:28:50.791Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/576 (base: main)
- 2026-09-16T15:29:20.821Z - task-done: T13: Journal deviations and close the flow
- 2026-09-16T15:30:08.175Z - ac-confirmed: AC1: page reframed around the supervised-task model: H1 renamed, Status accepted, Version 2.0.0, the P0-only 'superseded in part' banner removed rather than amended; the summary opens with every shell_exec being a supervised task
- 2026-09-16T15:30:08.279Z - ac-confirmed: AC2: Prior art's 'Poll, not push' rewritten as the decision flow 265 reversed (D-02); Out of scope now distinguishes push-on-OUTPUT (still unbuilt) from completion delivery; the new delivery section names KERYX_SHELL_HOLD_MS (default 1800000) and KERYX_SHELL_MAX_AUTO_WAKE (default 5) and the round-boundary rule
- 2026-09-16T15:30:08.383Z - ac-confirmed: AC3: 'the model is told once, at start' corrected: a RUNNING task produces no message at all and a finished one exactly one; the page states which half of D-06 survived (no recurring reminder) and which changed (the message now arrives at the END)
- 2026-09-16T15:30:08.485Z - ac-confirmed: AC4: the 'Changes to the synchronous shell_exec path — untouched' entry is struck through with the reason: P0 replaced that path, every call goes through the bounded yield, and the wall-clock DEFAULT_SHELL_TIMEOUT_MS deadline was replaced by the idle timeout
- 2026-09-16T15:30:08.585Z - ac-confirmed: AC5: task-tool table added: shell_task_output with its explicit cursor, shell_task_wait with any/all and the clamp to 300000, shell_task_kill idempotent by refusal; the aliases are named deprecated for one release, with old job-* ids resolving for READS only and the reason spelled out
- 2026-09-16T15:30:08.685Z - ac-confirmed: AC6: side-worker section names all four denied tools (shell_task_kill, shell_job_kill, shell_task_wait, shell_job_output), explains why shell_task_output stays, and states that the side-worker copy never marks a task delivered; the REPEATABLE_TOOL_NAMES paragraph names its three current members and why the kill tools are not among them
- 2026-09-16T15:30:08.923Z - ac-confirmed: AC7: an 'operator's levers' section documents /demote <task_id> in both shells including the busy-dispatch allow-list, and that an interrupt ends the WAIT and not the command — the task is promoted, keeps its output, and its completion is still delivered
- 2026-09-16T15:30:09.107Z - ac-confirmed: AC8: surviving flow-173 material kept verbatim (process-group kill, sandbox reuse, approval gate, session lifetime with the exit sweep, bounded rails); the floor guard scanned 18 files and 946 changed lines across the whole phase, which is the size of a corrections list rather than a rewrite
- 2026-09-16T15:30:09.216Z - ac-confirmed: AC9: the index entry was regenerated by keryx wiki index (that file belongs to the generator, and hand-editing it made keryx wiki validate report the index out of date); it now carries the new title, accepted status and the supervised-task summary, with no superseded-in-part text
- 2026-09-16T15:30:09.326Z - ac-confirmed: AC10: TOOL-11 and the section-11 heading rewritten; BGJOB-01..03 now describe the yield handle, the explicit cursor and the idempotent kill; BGJOB-05..09 added for delivery, the --print hold, the capped wake, /demote and interrupt-does-not-kill. Statuses left at 'not yet tested' because none of it was exercised live on a PTY
- 2026-09-16T15:30:09.442Z - ac-confirmed: AC11: the retired-vocabulary search over the three files in scope returns six matches, every one historical or negated: 'does not have to poll', 'began as flow 173 opt-in background: true', 'a poll after truncation' (the cursor-rebasing rail, still true), 'the poll-on-demand read survives as shell_task_output', 'burden no longer rests on the model remembering to poll', and BGJOB-01's note that background:true now only SKIPS the wait. No present-tense claim of the old model
- 2026-09-16T15:30:09.546Z - ac-confirmed: AC12: README says the package is fully implemented and describes what P3 did; specification Status says fully implemented with P3 named; the PRD gap row for the documentation sweep is struck through and closed. The two rows the package deliberately does NOT meet (S4/M7) are named rather than hidden
- 2026-09-16T15:30:09.652Z - ac-confirmed: AC13: the routed diff restricted to src reports Changed files: 0 — the phase touched no source file; keryx wiki validate all checks passed; keryx health run PASS score 94; full suite 10425 pass / 20 skip / 0 fail across 769 files in 625s
- 2026-09-16T15:33:05.707Z - completing
- 2026-09-16T15:33:14.411Z - done: all gates passed

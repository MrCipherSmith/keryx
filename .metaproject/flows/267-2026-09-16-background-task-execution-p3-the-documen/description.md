# Background task execution P3: the documentation sweep

Status: formalized
Source: docs/requirements/keryx-background-task-execution (v1.1.0), phase P3

## Problem

P0, P1 and P2 shipped and are released (0.2.108, 0.2.109, 0.2.110). The
documentation still describes the model they replaced, and not vaguely — in
specific, enumerable claims that are now false:

- **`.metaproject/wiki/architecture/background-jobs.md`** carries a banner
  written for P0 alone ("superseded in part by flow 263"). Since P1 and P2 the
  body contradicts the product in at least six places:
  - "**Poll, not push**" in Prior art, and "push/event-driven model wakeup — not
    shipped anywhere surveyed" in Out of scope. P1 shipped exactly that.
  - "the model is told once, at start" — P1 delivers a completion notification,
    exactly once per task, at a round boundary.
  - `shell_job_output` described as the model-facing read. P2 made it a
    deprecated alias; the read is `shell_task_output`, with an explicit cursor.
  - "**Changes to the synchronous `shell_exec` path** — untouched; the background
    path is an additive sibling" in Out of scope. P0 replaced that path: there is
    no synchronous path any more, only a bounded yield.
  - The side-worker section and `REPEATABLE_TOOL_NAMES` describe sets that P2
    widened, and the deny list is no longer "only `shell_job_kill`".
  - The whole page is framed as "backgrounding, an opt-in capability" rather than
    "every command is a supervised task".
- **`.metaproject/wiki/index.md`** repeats the P0-only banner verbatim in the
  page's index entry, so the wrong summary is what a reader meets first.
- **`docs/verification/keryx-shell-tui-test-catalog.md`** rows TOOL-11 and
  BGJOB-01…03 specify behaviour that no longer exists: `background: true`
  returning a `job_id`, polling as the way to read output.

A wiki page that contradicts the code is worse than no page: it is read as
current by both people and agents, and this one is the page the requirements
package itself names as the accepted description of the superseded path.

## Expected Outcome

- The wiki page describes the supervised-task model as shipped across P0–P2,
  with its `Status` no longer `superseded-in-part`, and with every claim listed
  above either corrected or removed. What remains true of flow 173 — process-group
  ownership, sandbox reuse, the approval gate, session scoping, the bounded
  rails — stays, because rewriting accurate text is churn, not work.
- The index entry summarises the page as it now is.
- The test catalogue's rows describe the tools that exist (`shell_task_output`,
  `shell_task_wait`, `shell_task_kill`, `/demote`) and the behaviours P0–P2
  actually guarantee.
- The requirements package marks P3 done, and the package's own status stops
  saying "P3 spec ready / not implemented".

## Out of Scope

- Any behaviour change. This phase edits documentation only; if a claim cannot be
  made true by editing prose, that is a finding to raise, not a code change to
  slip in.
- Rewriting `docs/requirements/keryx-background-task-execution/` itself beyond
  its phase-status lines — it is a requirements record of what was decided, and
  its history is the point.
- Other packages' documents that mention background jobs in passing
  (`keryx-full-review-remediation`, `keryx-agent-first-core`): they describe
  their own scope and are not this package's to rewrite.
- The user-facing README and CLI help, unless a specific false claim is found
  there — in which case it joins the inventory rather than expanding it by
  assumption.

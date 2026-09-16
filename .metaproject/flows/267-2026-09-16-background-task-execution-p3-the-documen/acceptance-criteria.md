# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `.metaproject/wiki/architecture/background-jobs.md` describes the supervised-task model as its PRIMARY subject: every `shell_exec` call is a task that returns within a bounded yield, a command outliving the yield keeps running in the background, and the page no longer frames backgrounding as an opt-in `background: true` capability. Its `Status` is no longer `superseded-in-part`, and the P0-only "superseded in part by flow 263" banner is gone rather than amended.
- AC2: The page's "Poll, not push" claim in Prior art and the "push/event-driven model wakeup on new output" entry in Explicitly out of scope are corrected: completion delivery exists (flow 265), is exactly-once, arrives at a round boundary, and both the hold (`KERYX_SHELL_HOLD_MS`) and the capped auto-wake (`KERYX_SHELL_MAX_AUTO_WAKE`) are described with their env names and defaults.
- AC3: The page's "the model is told once, at start" claim is corrected to the shipped rule: a running task produces no message at all, a finished one produces exactly one, and there is still no recurring reminder — the D-06 decision survived and the page says which part survived and which did not.
- AC4: The page's "Changes to the synchronous `shell_exec` path — untouched" entry in Explicitly out of scope is removed or rewritten: that path was replaced in P0 by the bounded yield, and `DEFAULT_SHELL_TIMEOUT_MS` is no longer the deadline (the idle timeout is).
- AC5: The page documents the task tools that exist — `shell_task_output` with its EXPLICIT cursor, `shell_task_wait` with its `any`/`all` modes and clamped bound, `shell_task_kill` — and states that `shell_job_output`/`shell_job_kill` are deprecated aliases kept for one release, with old `job-*` ids resolving for reads only.
- AC6: The page's side-worker section names the current deny set (`shell_task_kill`, `shell_job_kill`, `shell_task_wait`, `shell_job_output`), explains that `shell_task_output` stays available because its cursor is explicit, and states that a side worker's copy never marks a task as delivered. The `REPEATABLE_TOOL_NAMES` paragraph names the current members.
- AC7: The page documents the operator's levers: `/demote <task_id>` in both shells including while the turn is busy, and that an interrupt releases a wait without killing the task, whose completion is still delivered.
- AC8: What remained TRUE across all three phases is still on the page and not re-derived: process-group kill (`-pid`), sandbox/env reuse, the unchanged approval gate, session-scoped lifetime with the exit sweep, and the bounded-resource rails. A diff of this file against its pre-P3 version reads as a list of corrections, not as a rewrite: unchanged sections stay unchanged.
- AC9: `.metaproject/wiki/index.md`'s entry for the page summarises the page as it now is, with no "superseded in part" text and no P0-only banner.
- AC10: `docs/verification/keryx-shell-tui-test-catalog.md` rows TOOL-11 and BGJOB-01, BGJOB-02, BGJOB-03 describe behaviour that exists: no row claims `background: true` is how a command is backgrounded, and the rows name the current tools and the behaviours P0-P2 guarantee.
- AC11: A search for the retired vocabulary over the pages in scope returns nothing that asserts the old model: `keryx ctx rg "background: true|job_id|poll"` over `.metaproject/wiki/architecture/background-jobs.md`, `.metaproject/wiki/index.md` and `docs/verification/keryx-shell-tui-test-catalog.md` yields only historical mentions that are explicitly labelled as such (e.g. the compatibility alias), never a present-tense claim.
- AC12: The requirements package marks P3: README §Status, specification §Status and the §7 shipped-so-far paragraph, and the PRD gap row for the documentation sweep. No row claims a phase that has not shipped.
- AC13: Nothing behavioural changed: `git diff` for this flow touches no file under `src/`, and `bun run typecheck`, `keryx wiki validate`, `keryx health run` and the full suite all pass.

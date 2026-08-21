# Implementation Plan

Status: implemented (PR #378). Not formalized against a docs/requirements/
PRD + specification pair the way SLATE's own phases were —
`description.md` + this plan stand as the spec.

**SLATE numbering: SLATE-27, corrected before the PR was opened.** The
2026-08-21 same-day check that first assigned SLATE-22 ran against a stale
local working tree (fetched but not pulled) and missed PR #377's
concurrent SLATE-22..26 merge to `origin/main` minutes earlier — see
`description.md`'s note on this. Re-verified against `origin/main` directly
this time: SLATE-26 (PR #377) is the highest claimed number as of this
writing; this proposal is SLATE-27.

## Approach

Extend `/goal` with an opt-in `--auto [N]` flag rather than building a
parallel goal subsystem. The loop's stop condition is the check
`closeSlateOnFlowDone` already runs today (`isCourseDone`/`courseFromSlate`)
— reused, not duplicated. The only genuinely new runtime behavior is: (a)
auto-provisioning a Task Manager flow when `--auto` is used without one
already bound, (b) the round loop itself, and (c) one verifier
`spawn_subagent` call before the loop concludes "done."

Everything else this proposal touches is composition of existing, unchanged
pieces: `runAgentTurn`, `resolveApprovalDecision`, `SlateSessionRef`,
`keryx flow` CLI, `spawn_subagent`.

## Steps

1. **Parse `--auto`**: extend `parseGoalArgs` (`goal-command.ts`) to
   recognize a trailing `--auto` or `--auto <N>`, composable with
   `--workspace` in either order at the tail (mirrors the existing
   trailing-flag convention documented in that function's own docstring —
   `--auto`'s value, like `--workspace`'s, must never be swallowed from
   ordinary goal prose). A non-positive-integer `--auto` value is a parse
   error, not silently ignored or defaulted.
2. **Auto-provision a flow when none is bound** (DONE, T7): after the
   existing `--workspace` validation and slate-open (`runGoalCommand`'s
   current sequence, unchanged), if `--auto` was given and
   `(await readSlate(dir))?.course.flowRef` is unset, call
   `createFlowService().init({cwd, title: goalText})` → write one real
   acceptance criterion (see below) → `.freeze()` → `.start()`, then bind
   `slate.course.flowRef = id` via the existing `writeSlate` read-modify-
   write pattern `runGoalCommand` already uses for `workspaceId`. Failure
   at any step here degrades the same way the existing slate-bookkeeping
   try/catch does — log via `systemLine`, run the turn anyway, `--auto`
   simply does not arm for this attempt.

   **Revised during implementation**: this step originally called for
   `keryx flow plan <id>` between `init` and `freeze` (a "model-suggested
   task breakdown — already exists, reused as-is"). On reading
   `runPlan` (`src/commands/flow.ts`), it is purely advisory console
   output — it calls `narrate()` with a system prompt that says outright
   "This is a suggestion only — it does not modify flow state" — and
   returns nothing structured a caller could turn into real tasks. Dropped
   from the sequence entirely. v1 uses `flow init`'s built-in default
   four-task scaffold (context/implement/test/review) unmodified, and
   writes exactly ONE acceptance criterion tied to the goal text itself
   (required regardless — `flow freeze` refuses an unmodified placeholder
   AC file) — deliberately the SAME thing T10's verifier subagent will
   check, so there is one completion definition, not two that could
   disagree. Reused directly: `src/flow/service.ts`'s `createFlowService`
   (its `init`/`freeze`/`start` methods only — the same object
   `src/commands/flow.ts`'s CLI handlers call, not a re-implementation),
   constructed with `tracker: null` and a never-called `healthGate` stub
   (neither `init`, `freeze`, nor `start` read either).
3. **Arm the loop, in-memory only** (DONE, T8): on successful provision/bind
   (or reuse of an already-bound flow), set `slateSession.autoGoalRounds`
   (`SlateSessionRef`, `src/session/slate-lifecycle.ts`) — never written to
   `slate.json`. This is what makes AC7 (no silent cross-session
   inheritance) structural rather than a convention someone has to
   remember: a resumed/forked session's brand-new `SlateSessionRef` simply
   never has this field set.
4. **The loop** (DONE, T9): after the first `runAgentTurn` call returns
   (same call site `runGoalCommand` already has), while
   `slateSession.autoGoalRounds` is armed, rounds remain, AND
   `slateSession.opened` is still `true`:
   - synthesize a continuation message (round N of the flow's current task
     list, fetched via `FlowService.get()` — the same instance
     `autoProvisionFlow` uses, not a re-parsed `flow status --json`) and
     call `runAgentTurn` again with the same `skipCloseTrigger: true`
     `/goal` already uses;
   - decrement the remaining-rounds budget; stop the loop (not the whole
     command) when it reaches zero.
5. **Verifier pass before the final stop** (DONE, T10): once the ordinary
   rounds loop exits (`slateSession.opened` false, or the round budget
   exhausted), dispatch exactly one call through the SAME `spawn_subagent`
   tool instance already in `deps.tools` (`mode: "read_only"`) —
   `runGoalVerifier`, not a second dispatch mechanism — prompted to
   independently check the goal's stated outcome against the current repo
   state and return `{achieved: boolean, gaps: string[]}`
   (`parseVerifierVerdict` extracts it from free text, tolerant of
   surrounding prose, never throws). On `achieved: false`, surface `gaps`
   via `systemLine` and — if round budget remains — run exactly ONE more
   round: if the course had already closed, first reopen the slate
   (`ensureSlateOpened`, fresh Anchors injected exactly like the initial
   open) and rebind it to the SAME flow/workspace snapshotted at T8's arm
   time (`boundFlowRef`/`boundWorkspaceId`), never re-provisioning. If
   budget is exhausted, surface the gaps and stop anyway. The verifier is
   invoked AT MOST ONCE per `/goal --auto` call — a single second chance,
   not a re-verify loop — matching "run one more round" (singular) rather
   than looping until the verifier is satisfied.
6. **Existing close/wrap-up path, untouched**: once the loop actually stops
   (course confirmed done + verifier agrees, or budget exhausted),
   `runAgentTurn`'s own `finally` block (`closeSlateOnFlowDone`) runs
   exactly as it does for a non-`--auto` `/goal` today — no second SAC
   write path, no change to `dispatchWrapUpBestEffort`.
7. **Budget/telemetry**: reuse whatever token/turn accounting already
   exists elsewhere in the harness (context-usage tracking) rather than
   inventing a second counter — needs a context read during T1 to confirm
   the right existing hook, not assumed here.
8. **Surfacing in the TUI/readline shells**: both `shell.ts` and
   `tui-shell.ts` currently call `runGoalCommand` once and return; the loop
   itself lives inside `runGoalCommand`, so per-surface wiring changes are
   expected to be minimal (a progress line per round via the existing
   `io.onSystem`/`systemLine` path) — confirm during implementation whether
   either shell's own event loop needs anything beyond that to not appear
   to hang during a multi-round `--auto` run.

## Risks

- **Reusing `isCourseDone` assumes every `--auto` goal ends up flow-backed.**
  A goal whose auto-provisioned flow creation fails (step 2's error path)
  has no stop signal at all except the round budget — acceptable (fails
  toward "stops early, not runs forever"), but worth a test making that
  degradation explicit rather than accidental.
- **Task-breakdown granularity — confirmed, not just a risk** (see T7's
  revision above): `flow init`'s default four-task scaffold
  (context/implement/test/review) is coarse by construction. `isCourseDone`
  tracking a 4-task flow means the continuation loop's real stop signal is
  closer to "did the umbrella phases get marked done" than a fine-grained
  per-subtask signal — the loop will lean more on T10's verifier subagent
  than on task granularity to catch premature stops. A genuinely granular,
  model-generated breakdown would need NEW work (a structured, non-advisory
  version of what `flow plan` does today) — explicitly out of scope for
  this flow; noted as a candidate follow-up, not blocking v1.
- **Verifier subagent cost**: one extra model call per stop attempt is
  cheap next to a full evidence-catalog system, but a goal that flaps
  between "verifier says gaps remain" and "one more round" could still burn
  the whole round budget on verification overhead alone — the round
  counter must count verifier-triggered continuations too, not just
  genuine work rounds (ties to AC5).
- **Scope creep toward rebuilding qwen-code/grok-build's full machinery** —
  mitigated by this plan's explicit "one verifier call, not an evidence
  catalog; reuse Task Manager, not a new event-sourced record" framing
  throughout.

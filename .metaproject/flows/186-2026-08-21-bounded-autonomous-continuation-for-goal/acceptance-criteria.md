# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: `description.md` + `plan.md` (this flow has no separate
docs/requirements/ PRD/specification pair — see `plan.md`'s status note).

## Criteria

- AC1: `parseGoalArgs` recognizes a trailing `--auto` (optionally followed by
  a positive-integer round cap, e.g. `--auto 5`, ONLY when that value is the
  very last token), composable with `--workspace` in either tail order, each
  flag consumed at most once. Revised during T6 implementation (was: "a
  non-positive-integer value is a parse error") — `--auto`'s value is
  optional, so unlike `--workspace` there is no structurally-unambiguous
  dangling shape to hang a hard error on; when `--auto` is followed by a
  non-positive-integer token, `--auto` is not recognized as a flag at that
  position at all, and the whole tail stays part of the goal text. This
  mirrors `parseGoalArgs`'s own documented "Review finding 5" resolution for
  `--workspace` (no content-based way to tell a real flag from prose that
  happens to contain the token) rather than reintroducing that corruption
  class for `--auto`.
- AC2: When `--auto` is set and the slate's course has no bound `flowRef`,
  `/goal` provisions a new Task Manager flow (`flow init` → `flow freeze` →
  `flow start`) and binds it to `slate.course.flowRef` before the first turn
  runs; when a flow is already bound, no new flow is created and the
  existing one is reused. Revised during T7 implementation (was: "`flow
  init` → `flow plan` → `flow freeze` → `flow start`") — `keryx flow plan`
  (`runPlan`, `src/commands/flow.ts`) turned out to be purely advisory
  console output that writes nothing to flow state ("This is a suggestion
  only"), so there is no structured task breakdown to reuse
  programmatically; v1 uses `flow init`'s default four-task scaffold
  instead, plus one acceptance criterion tied directly to the goal text
  (written before `freeze`, since `flow freeze` refuses an unmodified
  placeholder AC file).
- AC3: The continuation loop's stop condition is the SAME
  `isCourseDone`/`courseFromSlate` check `closeSlateOnFlowDone` already
  runs today — no second, parallel "is it done" detector is introduced.
  Refined during T9 implementation: the loop does not call `isCourseDone`
  a second time itself — `closeSlateOnFlowDone` already runs inside every
  `runAgentTurn` call's own `finally` block (including each continuation
  round's), and flips `slateSession.opened` to `false` exactly when the
  course is done, archiving the slate in the same step. The loop's `while`
  condition reads `slateSession.opened` directly, observing that SAME
  check's already-computed result rather than invoking a second
  implementation of it (which, once the course is genuinely done, would
  have nothing left to read — the slate is already archived by then).
  Verified by a test that flips a bound flow's status to `"done"` mid-loop
  and confirms the loop stops on the very next round boundary.
- AC4: Before the loop finally stops (course done, or round budget
  exhausted), exactly one `spawn_subagent` verifier call
  (`mode: "read_only"`) runs, returning a structured
  `{achieved: boolean, gaps: string[]}`; on `achieved: false` with round
  budget remaining, one more round runs; `gaps` are always surfaced to the
  user via `systemLine`, never silently discarded. Implemented in T10
  exactly as planned, plus one detail plan.md's speculative wording didn't
  spell out: when the course was already done (the slate already archived
  and wrap-up already dispatched, AC8), "one more round" first reopens the
  slate (`ensureSlateOpened`, fresh Anchors injected — mirrors the initial
  open exactly) and rebinds it to the SAME flow/workspace it was already
  bound to (snapshotted at arm time, T8) — never re-provisioning a new
  flow. This is a single "second chance," not a re-verify loop: at most
  one extra round is ever added, and the verifier itself is called at most
  once per `/goal --auto` invocation, never re-invoked after that round.
- AC5: The loop is capped by round count (a documented default, `--auto <N>`
  overrides it) — a goal whose flow never reaches `isCourseDone` stops at
  exactly the cap, verified by a test with a fixed round count that never
  resolves. Verifier-triggered continuation rounds count against the same
  cap as ordinary work rounds — no separate, unbounded verification budget.
- AC6: Every individual tool call inside every continuation round still
  goes through the existing `resolveApprovalDecision` gate unchanged —
  verified by a test asserting `--auto` introduces no new bypass path for
  `ask`/`trust`-mode approval, and that a rejected approval inside a
  continuation round behaves identically to one inside the very first
  `/goal` turn.
- AC7: The armed `--auto` state lives only on the in-memory
  `SlateSessionRef` for the current attempt — a resumed or forked session
  (`keryx sessions fork`, `/resume`) never silently inherits it; re-arming
  a continuation requires a fresh `--auto` flag on a new `/goal` call,
  verified by a test that a forked session's `SlateSessionRef` does not
  carry the flag even when the source session had it armed.
- AC8: On loop stop (course done + verifier agrees, or round budget
  exhausted), `closeSlateOnFlowDone`/`dispatchWrapUpBestEffort` run exactly
  as they do today for a non-`--auto` `/goal` — no second SAC write path,
  no change to what `keryx workspace review` sees, verified by the existing
  SLATE-18 wrap-up test suite continuing to pass unmodified plus one new
  test confirming a `--auto` run's wrap-up dispatch is indistinguishable
  from a non-`--auto` one at the same stop point.
- AC9: `--auto` has no chat-mode meaning, mirroring `/goal` itself being
  `AGENT_ONLY` (SLATE-15) — attempting `--auto` outside agent mode is
  rejected the same way `/goal` already is, not a silent no-op.

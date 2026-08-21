# Bounded autonomous continuation for `/goal` (SLATE-27)

Status: implemented (PR #378). Written from a comparative survey of
`/goal`-equivalent mechanisms in 13 competitor coding-agent CLIs
(`~/sandbox/forks`), not from an issue or user bug report.

**SLATE-27, not SLATE-22 (renumbered 2026-08-21, before opening the PR)**:
this flow originally self-assigned SLATE-22, verified against a repo-wide
search of the LOCAL working tree at the time (last confirmed used: SLATE-21,
flow 166 done). That check was stale: a concurrent PR (#377, "Slate v3:
private MCP slate lifecycle for external hands") had already merged
SLATE-22..26 to `origin/main` minutes earlier, and the local check ran
against a `git fetch`-updated remote ref without a corresponding `git pull`
of the checked-out branch's own working tree — the files actually grepped
were still the pre-#377 versions. The collision surfaced as a genuine merge
conflict in `docs/requirements/slate/specification.md` when this branch was
finally pushed. Lesson for next time: verify a shared sequential id against
`git show origin/main:<file>` (or an actual `git pull`/`reset --hard
origin/main`) directly, never a merely-fetched-but-not-merged local
checkout, when there is any chance of a concurrent session claiming the
same number.

## Problem

`src/commands/goal-command.ts`'s `/goal <text> [--workspace <id>]` is
deterministic but strictly one-shot: it opens the session Slate, binds a SAC
workspace, runs exactly one `runAgentTurn`, and stops. Whether the goal was
actually achieved is never checked by anything other than the model's own
narrative — there is no loop, and nothing re-drives the agent toward the
stated objective if the first turn leaves it unfinished.

Three of the 13 surveyed competitors — qwen-code, grok-build, and
deepseek-harness — independently built exactly this missing piece: a bounded,
multi-round autonomous continuation loop that does **not** trust the model's
own "I'm done" claim, verifying it against evidence, an adversarial
re-check, or an authority proof before stopping. None of the three have
anything resembling keryx's SAC — durable, cross-session, human-reviewed
project memory. The two capabilities are complementary, and keryx currently
only has one of them.

## Expected Outcome

An opt-in `/goal <text> --auto [N]` mode that:

- reuses keryx's own Task Manager (`keryx flow`) as the durable "is this
  goal done" record, instead of inventing a new goal-state file — when the
  slate's course has no bound flow yet, `--auto` provisions one
  (`flow init` + `flow freeze` + `flow start`, plus one acceptance
  criterion tied to the goal text) and binds it. (`flow plan`'s
  model-suggested breakdown was in the original design here — dropped
  during T7 implementation once it turned out to write nothing to flow
  state at all; see `plan.md`.);
- re-drives `runAgentTurn` in a loop, using the **existing**
  `closeSlateOnFlowDone`/`isCourseDone` check (`src/commands/agent.ts`) —
  already re-derived live from real flow-task completion, already
  independent of the model's own narrative — as the loop's authoritative
  stop signal, rather than adding a second, parallel "is it done" detector;
- adds exactly one thing none of that existing machinery does today: before
  the loop actually stops, one `spawn_subagent` (`read_only` mode, already
  a real tool) verifier call checks the claimed outcome against the current
  repo state and reports `{achieved, gaps}` — the minimal version of what
  qwen-code's evidence-catalog and grok-build's skeptic-subagent both do,
  right-sized to keryx's existing tools rather than a new subsystem;
- is capped by round count and never changes who approves an individual
  tool call — `resolveApprovalDecision` still gates every write inside every
  round exactly as it does today;
- is armed only for the current attempt (`SlateSessionRef`, in-memory) —
  a resumed or forked session never silently inherits an unattended loop,
  mirroring deepseek-harness's `GoalActivation` authority boundary in
  keryx's own terms.

Full comparative research this proposal is drawn from:
`docs/requirements/goal-continuation/competitor-survey.md`.

## Out Of Scope

- No new persistent goal-state file or event log — Task Manager's
  `flow.json` is the durable record; `slate.json` stays exactly the
  session-scoped object SLATE-15/16 already defined.
- No cross-session autonomous resumption. An armed `--auto` loop does not
  survive a process restart, a `keryx sessions fork`, or a `/resume` —
  consistent with `SlateSessionRef.opened` already not surviving those today.
- Not a general adversarial multi-skeptic committee (grok-build's full
  design) — one verifier call per stop attempt for v1, not N parallel ones.
- No change to approval-mode semantics, `resolveApprovalDecision`, or the
  write-gating boundary anywhere.
- No chat-mode meaning — mirrors `/goal` itself being `AGENT_ONLY`
  (SLATE-15).
- Does not touch SAC/Seeds/`keryx workspace review` — `closeSlateOnFlowDone`
  and wrap-up dispatch run exactly as they do today once the loop stops;
  this feature only changes how many turns run before that point.

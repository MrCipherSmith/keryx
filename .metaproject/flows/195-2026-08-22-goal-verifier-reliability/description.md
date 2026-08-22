# /goal --auto verifier reliability (issues #389, #392, #394 — one code path, sequenced together)

Status: formalized
Source: https://github.com/MrCipherSmith/keryx/issues/389 (primary); also covers
https://github.com/MrCipherSmith/keryx/issues/392 and
https://github.com/MrCipherSmith/keryx/issues/394

## Problem

Three related reliability gaps in `/goal --auto`'s T10 verifier machinery
(`src/commands/goal-command.ts`), all confirmed live in the same code path
during the 0.2.55 testing campaign:

- **#389 — silent success/unavailable.** `runGoalVerifier` calls
  `tool.invoke()` directly on `spawn_subagent`, bypassing the normal
  `executeCall` tool-call path entirely — no `io.onToolCall`/`onToolResult`,
  nothing pushed to `history`. The only visible branch anywhere in
  `runGoalCommand` is `!verdict.achieved`; "verified and approved" and
  "verifier never actually ran" are observably identical.
- **#392 — verdict can contradict session evidence.** `autoProvisionFlow`'s
  generic T1-T4 template is never marked done by design (its own AC text
  defers completion judgment to the verifier, not to task checkboxes), but
  `runGoalVerifier` only hands the child the bare goal text — not the
  Seeds/`workspace_propose` records the run actually produced. A verifier
  that leans on `flow_status` (always "incomplete" for this class of goal)
  reports "not achieved" even when the deliverable demonstrably exists in
  the same session.
- **#394 — round loop can't exit early.** The while loop
  (`while (roundsLeft > 0 && slateSession.opened)`) only exits early via
  `isCourseDone`/`courseFromSlate` flipping `slateSession.opened` to
  `false` — and nothing in the model's actual tool set can do that
  (confirmed live twice, the model says so itself mid-transcript). The
  loop always burns its full round budget, making the "one more round if
  the verifier disagrees" branch (`goal-command.ts:626`) structurally
  unreachable in normal use.

## Expected Outcome

Per the campaign's consolidated fix plan (`docs/verification/fix-plan.md`,
P1 section), implement in this order — each fix makes the next easier to
validate:

1. Route the verifier dispatch through the same visibility path as any
   other tool call (or at minimum emit a `systemLine` on every outcome —
   achieved / not achieved / unavailable) and persist the dispatch +
   verdict into `history`. Closes #389.
2. Point the verifier at the run's actual evidence (recent Slate Seeds,
   this run's `workspace_propose` records) instead of leaving it to
   rediscover "done" via `flow_status` alone; and/or instruct it not to
   weight flow-task-checkbox state for goals whose own AC already defers
   completion to the verifier. Closes #392.
3. Give the loop (or the model) a real, deterministic way to signal "this
   round's work is done" short of full round-budget exhaustion — e.g. a
   lightweight `mark_course_done`-shaped tool, or a cheap intermediate
   check each round. Closes #394.

## Out of Scope

Any SAC/wiki-review changes (flow 194, issue #391). Redesigning the flow
auto-provisioning template itself beyond what's needed for #392/#394.

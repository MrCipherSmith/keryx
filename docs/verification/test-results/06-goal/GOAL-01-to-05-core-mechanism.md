# GOAL-01 to GOAL-05 — `/goal` core mechanism (formalized from the prior live-testing pass)

**Area:** 6. `/goal` — one-shot and `--auto` · **Date:** 2026-08-22 (evidence originally gathered
2026-08-21) · **Status:** PASS (all five)

This report formalizes five already-executed, already-evidenced test cases from
`docs/verification/keryx-0.2.55-live-testing-2026-08-21.md` §4 into the catalog's per-case
format. The underlying runs are not repeated here — the sessions, on-disk artifacts, and exact
transcript excerpts already exist and are cited below. Executed by the parent session directly
(not a dispatched subagent), against real `keryx 0.2.55`, real `deepseek/deepseek-chat`.

## GOAL-01 — `--auto`/`--workspace` recognized only when trailing

**Test case:** `/goal --auto [N]` must be recognized only at the end of the line, never leading,
to avoid corrupting ordinary goal text that happens to mention "--auto".

**What was actually run:** Session `263da4a5` (`c390c024-6b6a-4c1d-8b50-4b6c263da4a5`) —
`/goal --auto 1 <text>` (flag FIRST) silently failed to arm anything: no error, the whole string
including `--auto 1` was sent as plain goal text. Session `df8710d6`
(`4f3b7eb5-a514-476e-8732-6087df8710d6`) — `/goal <text> --auto 1` (flag TRAILING) worked
immediately: Flow 188 auto-provisioned, round loop armed.

**Summary:** Confirmed exactly as designed (`parseGoalArgs`'s own docstring in
`src/commands/goal-command.ts:54-105` explains this is deliberate, protecting ordinary goal text
that merely mentions "--auto" mid-sentence).

**Analysis:** This is a real, reproducible gotcha for anyone typing `/goal` from habit (flag
before args, as most CLIs do) — not a bug, since the design rationale is sound and documented,
but worth flagging in-product.

**Improvement/fix suggestion:** Consider having the shell surface a hint when a `/goal` line
contains `--auto`/`--workspace` NOT in trailing position — e.g. "note: --auto only takes effect
at the end of the line; it was not recognized as a flag here" — so a user gets real-time feedback
instead of silently getting the one-shot behavior they didn't ask for.

---

## GOAL-02 — one-shot `/goal <text>` opens Slate + injects Anchors, runs exactly one turn

**What was actually run:** Session `df8710d6` — `/goal <count .ts files in src/harness/provider>`.

**Captured evidence:** `slate-archive/*.json` for the session shows `anchors.touched` populated,
`workspaceId` bound, exactly one turn's worth of tool calls before the model's final answer.

**Summary:** Confirmed. Slate opened deterministically (bypassing the action-intent heuristic),
Anchors were injected once at turn start, and the turn ran to completion normally.

**Analysis/Improvement:** None — behaves as documented.

---

## GOAL-03 — `--auto [N]` auto-provisions a Flow when none bound

**What was actually run:** Same two sessions as GOAL-01/02's successful run.

**Captured evidence:** `.metaproject/flows/188-*` and `.metaproject/flows/189-*` — real,
on-disk, git-trackable Flow packages, titles matching the goal text verbatim, generic T1-T4
scaffold + one AC tied to the goal.

**Summary:** Confirmed — `autoProvisionFlow` (`goal-command.ts:257`) really runs and really
creates a durable Flow package, not just an in-memory marker.

**Analysis/Improvement:** None — behaves as documented.

---

## GOAL-04 — round loop continues while Flow isn't done and rounds remain

**What was actually run:** Session `1be94528` (`4d71504a-fdd3-47aa-b91a-88231be94528`),
`--auto 2` — real `systemLine`s captured verbatim: `/goal --auto: round 2/3 — continuing toward
the goal.` and `/goal --auto: round 3/3 — continuing toward the goal.`

**Summary:** Confirmed — the loop re-drives the turn with a Flow-aware continuation message
(`buildContinuationMessage`, `goal-command.ts:302`) exactly `roundsCap` additional times.

**Analysis/Improvement:** None — behaves as documented.

---

## GOAL-05 — verifier runs before final stop

**What was actually run:** Both sessions above hit the verifier. `df8710d6`'s verifier ran
**silently** (no visible trace, consistent with an `achieved:true` or `undefined` verdict — both
are silent per source, see issue #389). `1be94528`'s verifier ran **visibly** (the `!achieved`
branch prints), and its stated reasoning was later found to contradict real evidence in the same
session (see issue #392).

**Summary:** Confirmed the verifier genuinely dispatches (`runGoalVerifier`, `goal-command.ts:379`)
before every final stop — but see GOAL's two filed reliability gaps: #389 (silent on
success/unavailable) and #392 (verdict can be factually wrong).

**Analysis:** This is the one sub-case of the five where "PASS" means "the mechanism fires as
designed" rather than "the mechanism is trustworthy" — the trustworthiness gaps are real and
already tracked as separate issues, not re-litigated here.

**Improvement/fix suggestion:** See #389 and #392 directly — both have concrete suggested
directions already filed.

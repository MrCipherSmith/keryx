# GOAL-06 and GOAL-07

**Area:** 6. `/goal` — one-shot and `--auto` · **Date:** 2026-08-22 · **Status:** GOAL-06 FAIL (real finding, filed) · GOAL-07 PASS

## GOAL-06 — a disagreeing verifier grants exactly one extra round, never a re-verify loop

### Test case (from the catalog)

> Not yet directly confirmed — the earlier live run hit round budget exhaustion at the same
> moment the verifier disagreed, so the "one more round" branch (`goal-command.ts:626`) never
> actually fired. Needs a run with `roundsLeft > 0` remaining when the verifier says
> `achieved: false`.

### What was actually run

```bash
printf '/mode trust\n/goal Скажи одним словом: сколько будет 2+2 --auto 3\n' | DEEPSEEK_API_KEY="$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")" keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp
```

Session id: `74b508d5`, fresh session, `--auto 3` (roundsCap=3, totalRounds=4).

Goal deliberately chosen to be trivially, immediately answerable in round 1 — the hypothesis
being that a genuinely-complete goal would let the round loop exit *early* (via
`isCourseDone`/`courseFromSlate` flipping `slateSession.opened` to `false`), leaving
`roundsLeft > 0` by the time the verifier runs, which is the only way `goal-command.ts:626`'s
"one more round" branch can ever fire.

### Captured output (terminal text capture)

```text
❯   Session 74b508d5 · per-project (keryx shell -c to continue)
    Permission mode: trust
❯   4
/goal --auto: round 2/4 — continuing toward the goal.
  [model reasons at length: "the goal is already achieved... I have no tool to complete a flow
  task directly... this is a synthetic test of the harness" — answers "4" again]
/goal --auto: round 3/4 — continuing toward the goal.
  [same reasoning, answers "4" again]
/goal --auto: round 4/4 — continuing toward the goal.
  [same reasoning, final answer "4", explicitly notes the T1-T4 template tasks don't apply]
 [system] No tool calls were emitted. Re-run this request now and emit ONE tool call instead of
 a narrative sentence.
  ⚙ flow_status(id=191)
  ↳ Flows (1): ...
  [final answer, turn ends — no visible verifier message either way]
❯
```

### Cross-checks

Flow 191 (auto-provisioned for this goal) confirmed on disk under
`.metaproject/flows/191-*` with the generic T1-T4 scaffold, exactly as the model itself
diagnosed mid-transcript.

### Summary

**The round loop consumed its FULL budget (all 3 additional rounds) even though the model
recognized and stated, starting in round 2, that the goal was already achieved.** By the time
the verifier ran (silently — consistent with #389), `roundsLeft` was `0`. This is the second
independent live observation of this exact pattern (the first being the `1be94528` session from
the prior pass, also `--auto`, also ran every round to exhaustion).

### Analysis

`slateSession.opened` only flips to `false` mid-loop via `closeSlateOnFlowDone`'s
`isCourseDone`/`courseFromSlate` check — and nothing in the model's actual tool set can mark a
Flow's tasks as done (the model itself reasoned exactly this, verbatim, in its own thinking:
*"I don't have a tool to complete flow tasks directly"*). The model can only narratively assert
completion; it cannot durably record it in the one place (`flow.json`'s task states) that
`isCourseDone` presumably reads. Two-for-two real runs show the SAME consequence: the while loop
(`goal-command.ts:601`, `while (roundsLeft > 0 && slateSession.opened)`) always runs to full
`roundsCap` exhaustion in practice, because `slateSession.opened` never flips early.

**Consequence for GOAL-06 specifically:** the "one more round after the verifier disagrees"
branch (`if (roundsLeft > 0)`, `goal-command.ts:626`) requires `roundsLeft` to be nonzero at the
exact moment the verifier is consulted — but the verifier is *only* consulted after the while
loop exits, and the while loop structurally cannot exit early under real conditions (no tool ever
satisfies its exit condition). **This makes the documented "second chance" feature effectively
unreachable in normal `/goal --auto` usage** — not a crash, not an error, just a code path with
no real trigger.

### Improvement / fix suggestion

Filed as GitHub issue — see below. Suggested direction: either give the model (or the loop
itself, deterministically) a real way to signal "this round's work is done" short of the round
budget running out — e.g. a lightweight `mark_course_done`-shaped tool, or have the loop itself
ask a cheap intermediate check each round (similar in spirit to the final verifier, but gating
early-exit rather than only running once at the end) — otherwise `--auto`'s round budget is
better understood as "always run exactly `roundsCap` extra rounds," not "run more only while
actually needed," which contradicts the feature's own stated design (`goal.md`'s own docs: "while
the Flow isn't done and rounds remain").

---

## GOAL-07 — non-integer `--auto` argument falls through as ordinary text, not a parse error

### What was actually run

```bash
printf '/goal explain how --auto mode differs\n' | DEEPSEEK_API_KEY="$(...)" keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp
```

Session id: `284aaf18`, fresh session.

### Captured output

The model treated the entire line as a genuine goal/question, read
`wiki/architecture/permission-modes.md` via `wiki_ask`/`read_wiki`, and gave an accurate,
detailed answer about how `--auto` differs from `ask`/`trust` — no parse error, no flag
consumed, `--auto` stayed part of the goal text exactly as `parseGoalArgs`'s docstring promises
(`goal-command.ts:80-94`: `--auto <token>` is only an override when `<token>` is the LAST token
AND a positive integer; here "mode" follows it, so it's never recognized as a flag).

### Summary

Confirmed exactly as documented. No divergence.

### Analysis / Improvement

None — behaves as designed, and the design is sound (protects ordinary goal text that happens to
mention "--auto" from being corrupted).

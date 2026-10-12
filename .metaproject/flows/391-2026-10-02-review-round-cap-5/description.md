# Review round cap 5

Status: draft
Source: user description (origin: human-request, channel message 178020)

## Problem

The review loop is bounded at three rounds: `REVIEW_ROUND_CAP = 3` in `src/flow/review-gate.ts` (it only adds a note, never blocks) and the sentence "Allow at most **three** review/fix attempts" in the `flow-orchestrator` skill. The operator wants five review rounds before a flow is handed to a human.

## Expected Outcome

The review round bound is five, in the gate and in the `flow-orchestrator` skill (bundled copy and its `.metaproject` mirror, byte-identical), and the docs and tests say five. The `job-orchestrator` bound (`max_review_iterations`, 3) and the `task-implementer` self-fix bound (3) are different loops and stay at 3. The gate's behaviour is unchanged: the cap only adds a note, and only a human can dismiss a finding.

## Outcome criteria

- Запрос (дословно): «Давай подними лимит раундов до 5» (the operator, channel message 178020, after asking where the 3-round review limit comes from in 178010).
- Эффект (формализация агента): a review that needs rounds 4 and 5 is not cut off by the cap note and the orchestrator skill allows five review/fix attempts.
- Как наблюдать (предложение агента): the gate note reads "round cap (5)"; the next flow that needs a fourth review round proceeds without the cap note.

## Out of Scope

Changing `job-orchestrator` and `task-implementer` bounds, the `/goal --auto` bound (8), making the cap a blocking gate, changing the stuck-on-repetition check.

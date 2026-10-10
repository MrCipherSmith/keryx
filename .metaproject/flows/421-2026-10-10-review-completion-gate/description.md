# Shell review completion gate

Status: formalized
Source: user description (origin: human-request)

## Problem

The shell's model ends a managed review run at the first friction (a refused `keryx review` flag, an unclear Step 1) and the harness accepts the text-only finish. Plan follow-through is capped and halts on a blocked item; the loop guard halts on three identical `plan_get` calls. A review package stays open and the operator restarts the run by hand.

## Expected Outcome

A managed review run in the shell ends only when `keryx review complete` accepts the package, or at an explicit stop (cap, no new artifact, one real blocker) that reports the state.

## Outcome criteria

- Запрос (дословно): «Да: гейт, релиз 0.3.94, обновить глобально и в проекте, седьмой прогон» (source: telegram poll 127)
- Эффект (формализация агента): The shell does not accept a stop while a review-flow package is open and `review complete` still refuses; it continues with the refusal reasons.
- Как наблюдать (предложение агента): A `[review-gate]` line in the pane for each continue; `keryx review status` shows the package closed at the end of a live run.

## Out of Scope

Stage 2 (small-model judge, routing category, Jev as fast judge, operator escalation) is recorded as a follow-up flow.

# Keryx Review: arbiter sub-agent answers orchestrator questions by written rules

Status: draft, awaiting operator approval of the criteria
Source: operator proposal the chat bot 197442, 2026-10-11; related to the completion judge (decision 196244).

## Problem

When the review orchestrator hits a question, today a human answers it, or `review-auto` takes the recommended option by a word heuristic. The first stalls an unattended run; the second cannot judge a case (is 60% coverage enough, retry with a smaller slice, spend more budget). Claude Code resolves such points by judgment.

## Expected Outcome

A small arbiter sub-agent with a written, numbered rule set answers the orchestrator's policy questions in review runs where no human is present. The orchestrator acts on the verdict. Safety floors never go to the arbiter.

## Outcome criteria

- Запрос (дословно): «дать права, что естли у оркестратора возникнет все таки вопрос, он может спросить у этого агента что бы тот дал ответ» (source: the chat bot 197442, 2026-10-11T07:17Z)
- Эффект (формализация агента): in `review-auto` and in the autonomous profile, an orchestrator question of a known kind gets a verdict `allow`, `deny` or `escalate` with the id of the rule it rests on; `escalate` becomes a safe refusal when nobody is present.
- Как наблюдать (предложение агента): in the PR 7435 autonomous run read `arbiter.log` and see each question, verdict, rule id, model and cost.

## Out of Scope

- Safety floors: destructive, credentials, publish, hook-ask and calls after untrusted content stay with the human or the hard policy.
- The completion judge of Stage 2 (decision 196244, its own flow) beyond sharing the runner.
- Training or fine-tuning a model.

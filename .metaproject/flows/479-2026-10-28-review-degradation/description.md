# review-degradation: a reviewer that checks whether the code got worse than on the base branch

Status: frozen with the PRD `docs/requirements/keryx-review-degradation/prd.md` (operator, 2026-10-28).
Source: user description (origin: human-request)

## Problem

`review-regression` checks only the dependents of a change through the code graph and its ingest screen refuses everything below `major`. Human lead reviewers of a large frontend project mostly ask a different question of the diff itself and of every consumer of a shared symbol it touched: is the code worse than on the base branch? Seven classes recur: behaviour delta, silent default change, diff versus description, debt introduced, performance delta, cross-PR hazard, and a test that cannot see the regression. Each was filed with evidence; findings without evidence were questions.

## Expected Outcome

A generic keryx reviewer skill `review-degradation`, shipped in the npm package in profile `full`, whose findings carry a class and evidence, with the evidence rule enforced in code at ingest. After a trial on the operator's own PRs, its cost and effectiveness are measured and the operator decides on promotion.

## Outcome criteria

- Запрос (дословно): «мне нужно, чтобы ты понял, нашел или предложил работать дополнительный скилл-ревьюер, который бы чекал именно подобные проблемы с регрессией, с ухудшением кода.» (source: helyx chat -1003908750902, voice message 230791, 2026-10-28)
- Эффект (формализация агента): a review round in profile `full` also asks "is the code worse than on base" and returns classified, evidenced findings; major and above without evidence arrive as `info` and are listed as unproven.
- Как наблюдать (предложение агента): `keryx review` on a diff with a behaviour change shows a `review-degradation` finding with class and evidence kind in the TUI review panel and in `scope.md`; the trial report gives reproduced-versus-ground-truth counts and the round cost.

## Out of Scope

- Any change to `review-regression`, its screen or scope B dispatch.
- Any change to the severity ladder or the exit criterion in `review-orchestrator`.
- Wiring the reviewer into any private project's own review pipeline.
- Style, naming and architecture of code the change did not touch.

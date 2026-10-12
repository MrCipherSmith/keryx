# Recommendation journal: what the agent recommended and what the human chose

Status: draft
Source: user description (origin: human-request; operator, 2026-10-02 07:24 UTC, confirmed 07:26 UTC)

## Problem

Every question the agent puts to the operator (a poll, a shell question, a question before freeze) carries the agent's own recommendation, usually marked and listed first. The operator's judgement then drifts into choosing between "accept the recommendation" and "reject it", and the system keeps no record of which one happened. Nobody can tell how often the human decides and how often the human ratifies.

## Expected Outcome

A decision journal records every agent question that has options: the flow and stage, the question, the options, the agent's recommendation and why, how the question was shown, in what order, what the human chose and how long it took, and an optional reason when the human deviated. About one question in three is asked blind: no "recommended" mark, random option order, the recommendation recorded before display and revealed after the answer. `keryx decisions report` turns the journal into the share of matches by mode and stage and a list of deviations with reasons, deterministically and without a model. Nothing blocks and nothing slows a question down.

Decisions taken with the operator on 2026-10-02 (poll 40):

- Blind mode is chosen at random, probability 1/3 per question.
- Irreversible actions are a fixed list in config (release, delete, push to something others own); blind mode never applies to them.
- The deviation reason is an optional field, asked once after a deviation.
- In blind mode the recommendation is shown right after the choice, and the journal records whether the human changed the answer (both entries are written).
- Two small follow-ups of flow 390 are fixed here: `originSet` inherits the previous quote/source when switching kind, and `/flow origin` without an id prints far too much.

## Outcome criteria

- Запрос (дословно): «Мне нравится про потерю замысла и пункт про то что суждение превращается в выбор рекомендации. Тут можно глубже, поскольку рекомендация это как раз то что предлагает агент. И это сильнее размывает роль человека.» (source: operator 2026-10-02 07:24 UTC, confirmed 07:26 UTC)
- Эффект (формализация агента): the share of decisions where the human accepted the agent's recommendation is measurable, and comparable between blind and ordinary questions.
- Как наблюдать (предложение агента): after two weeks of use `keryx decisions report` shows at least 20 decisions, at least 5 of them blind, with the match share by mode and stage.

## Out of Scope

Blocking or delaying a question; asking a model to judge decisions; changing how polls are delivered; applying blind mode to irreversible actions; any use of the journal as a gate.

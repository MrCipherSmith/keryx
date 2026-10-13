# Intake: own model route for card assessment

Status: draft (AC not yet shown to the operator; do not freeze)
Source: operator poll 95 (2026-10-05T18:26Z), from a screenshot of the Telegram Intake topic

## Problem

The intake poll of MrCipherSmith/keryx reports `model: 1 assessment(s) failed: no model is configured for intake (it borrows the route of the project's digest schedule)` (run ink-20261005T175031-512a1cd0). `src/intake/assess.ts` takes its model dispatch from `digestDispatch(root)`, so a project without a digest schedule has no assessment model at all: every card goes out unassessed and each poll reports a failure. Intake is read-only on GitHub and runs on a schedule of its own, so tying its model to an unrelated schedule is a coupling that fails for any project that never set up a digest.

## Expected Outcome

Intake resolves its assessment model from its own configuration (with a documented fallback), a project without a digest schedule gets assessed cards, and the poll report no longer lists a failure when a model is available. When no model is configured anywhere, the report says exactly what to set and where, once, not as a per-poll failure.

## Outcome criteria

- Запрос (дословно): «Отдельный flow: собственный маршрут модели для intake (рекомендую)» (source: operator poll 95, 2026-10-05T18:26Z)
- Эффект (формализация агента): intake assessment no longer depends on a digest schedule; it has its own model route in project config, and the digest route is at most a fallback.
- Как наблюдать (предложение агента): on a project with no digest schedule but an intake model set, `keryx intake poll` makes assessed cards and its report shows no model failure; with nothing set the report names the setting to add.

## Out of Scope

- The 401 from openrouter on the «Разобрать» button (ci-triage): a credential problem in the hub environment, not a routing one.
- Changing what the assessment says or how cards look.
- TUI surfaces are in scope only as AC for the new setting (sidebar/modal/command per the standing TUI rule); the design goes into the AC draft for the operator.

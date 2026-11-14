# Merge commit/push/pr into one git-publish skill and make Red Flags optional

Status: formalized
Source: user description (origin: human-request)

## Problem

`quality/commit`, `quality/push` and `quality/pr` (255 lines together) teach a frontier model
things it already does, around a handful of safety rules that do matter. A behaviour eval
(`eval/`, 2026-11-14) ran six git scenarios — dirty tree with an `.env`, failing pre-commit
hook, rejected push, missing upstream, unpushed PR branch, push of a dirty `main` — two runs
each with the three skills, two runs each with a 35-line rule (`eval/arm-rule.md`), one run
with no guidance. Scored from repository state, not from agent reports: skills 38/38, rule
38/38, no guidance 18/19 (it pushed a dirty `main` without asking). The rule keeps the
quality; the safety lines are the part that earns its place.

keryx does not inject `alwaysApply` rules into an agent's context; a skill reaches the agent
through routing on "commit"/"push"/"open a PR". So the tested text ships as one skill, not as
a rule, to keep the delivery the eval assumed.

The anatomy lint (`anatomy:sections` in `src/gdskills/bundled-eval.ts`) requires a Red Flags
table in every skill. The eval arm that passed 38/38 had none. The requirement forces every
skill into the long template and blocks this merge.

## Expected Outcome

- One bundled skill `quality/git-publish` whose body is the eval-tested rule text, with a
  description that routes commit, push and pull-request requests to it.
- `commit`, `push` and `pr` are gone from the bundled tree, the mirror and every registry.
- The anatomy lint no longer requires a Red Flags section; it still requires the "NOT for"
  clause and a Verification section, and it still checks a Red Flags table that exists.

## Outcome criteria

- Запрос (дословно): «Пошли по плану, но перепроверяй, что качество не упадет» (source: desktop session 2026-11-14)
- Эффект (формализация агента): три git-скила заменены одним коротким, и поведение агентов на git-задачах не хуже, чем со старыми скилами.
- Как наблюдать (предложение агента): замер из `eval/` на новом скиле даёт не меньше 38/38; тесты маршрутизации и скилов зелёные.

## Out of Scope

- `changelog`, `dependency-update`, `db-migrate`, `deploy`, `test-gen`: not covered by the eval.
- Removing existing Red Flags tables from other skills.
- The length-ceiling policy.

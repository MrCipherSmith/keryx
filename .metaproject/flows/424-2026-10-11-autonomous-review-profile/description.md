# Keryx Review: autonomous review profile for scheduled and triggered runs

Status: draft, awaiting operator approval of the criteria
Source: operator request helyx 197432, 2026-10-11, after run 19 of flow 417 AC16.

## Problem

A review today needs a human at the keryx shell: modals, nudges, a model that sometimes stops. In the night of 2026-10-10/11 one modal held the run for about seven hours. Claude can run a review without a person; keryx shell cannot be put into a schedule or a trigger. The pieces exist apart (`keryx shell --print`, `--trust`, `--review-system review-auto`, `--events-file`) but there is no one profile, no exit codes, no budget, and no rule for what happens when a question comes up and nobody is there.

## Expected Outcome

One command starts an autonomous review of a PR or branch. It never waits for a person, ends within a stated budget, and leaves a package and a machine-readable summary that a scheduler or a trigger can read and publish.

## Outcome criteria

- Запрос (дословно): «в keryx shell я бы хотел просто ключ, профиль, автономный ревьюер, который гонит прогон автономно, Например, что бы потом добавить в расписание в триггер» (source: helyx 197432, 2026-10-11T07:11Z)
- Эффект (формализация агента): `keryx review run --autonomous` (profile `review-autonomous`) runs a full managed review without a terminal and without input, and ends with a stated status and exit code.
- Как наблюдать (предложение агента): start it from cron or a trigger on PR 7435 with no TTY, read `summary.json` and the exit code, and see the package accepted by `keryx review complete`.

## Out of Scope

- The arbiter that answers orchestrator questions (flow 425).
- Posting the result to GitHub (a later flow; the summary is the hand-off).
- Running a project's tests or a browser (source-only stays the default).

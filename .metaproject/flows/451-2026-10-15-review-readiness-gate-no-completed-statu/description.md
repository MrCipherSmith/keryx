# Review readiness gate: no completed status and no GitHub publish until a checklist passes

Status: draft
Source: user description (origin: human-request)

## Problem

On 15 Oct 2026 the review of Presight-AI/vantage-frontend PR #7932 (package `pr7932-r1`, 25 changed files) was published to GitHub as "Request changes" while it was incomplete, and the agent could not later explain why.

Facts from the session transcript and the package:

- Blast radius is capped at 40 files (`DEFAULT_BLAST_RADIUS_MAX_FILES`, flow 204: measured on 80 commits, F1 falls from 0.65 to 0.29 as context grows). 301 of 341 candidates were dropped with `reason: "cap"` and the line "It was NOT reviewed".
- The remedy already exists: `keryx review chunks plan|estimate|next|record|merge` cuts the dropped list into waves, with a ceiling (25 passes x 40 files) above which an interactive run waits for the operator's yes, and `ChunkPass` sums the findings and keeps `uncoveredFiles`. The orchestrator never called it. The only pointer is one sentence in the middle of a 1600-line `SKILL.md`, and `review blast-radius` prints no command.
- `ledger build` returned NOT READY (about 130 findings without a disposition, four reviewers never run, the regression reviewer returned no JSON). The agent published anyway, with `gh api .../reviews`, and never called `ingest` or `complete`. The package stayed a draft, while `coverage.md` listed all 19 reviewers as "run".
- Every existing gate sits on `review complete`, and it is bypassed by not calling it. Publishing to GitHub has no keryx command and no gate at all. The checks (ledger, coverage, dispatch errors, head, parity warnings, chunk blocker) are spread over separate commands, and nothing lists them together.
- A second trap in the same session: a recount with `--ref develop` produced 1547 changed files and 5424 candidates instead of 25 and 341. Only a reader's eye caught it.

## Expected Outcome

A review gets the status `completed`, and a review reaches GitHub, only through one checklist ("readiness") that every route shares, whatever the review ends with: a published review, a report only, a partial one. Each item of the checklist reuses an existing check, names the exact command that fixes it, and a failing item is either repaired or waived with the operator's own words, which are written into the record and into the report header. The orchestrator is pushed into the chunk waves when the blast radius is cut, instead of being told once in prose.

## Outcome criteria

- Запрос (дословно): «также разработай гейт и чек-лист, который необходимо выполнить перед публикацией на GitHub или перед тем, как мы можем сказать, что ревью вообще завершено» (source: helyx 206417, 2026-10-15T05:33Z)
- Эффект (формализация агента): ревью нельзя пометить completed и нельзя опубликовать на GitHub, пока не пройден единый чек-лист готовности; срез blast radius ведёт в волны (chunks), а не заканчивается словами "coverage was partial".
- Как наблюдать (предложение агента): на пакете формы pr7932-r1 (ledger NOT READY, 301 файл не покрыт, четыре ревьюера без волн) `keryx review readiness` печатает NOT READY со списком пунктов и командой для каждого, `review complete` и `review publish` отказывают, а попытка `gh api .../reviews` в сессии агента блокируется с указанием на `review publish`.

## Out of Scope

- Changing the default of 40 files or the depth of the blast radius (measured, deliberate).
- Changing which reviewers run, or the severity rubric.
- Making the reviewers' judgement better; the gate checks that the work was done and recorded, not that it was right.
- Publishing from CI or a non-Claude agent that bypasses the keryx shell guard (named as a limit in the docs).

# Close the review gate hole for PR URLs under any target; autonomous prompt: skill path and shell guard

Status: draft
Source: user description

## Problem

Two defects from the 7643 clean autonomous run (flow 446 follow-up).

1. `completeHeadGate` returned early when the package target kind was not `pr`. A package ingested with `--target report --ref <PR URL>` therefore closed with a recorded head that was not the PR's head, with no check.
2. The autonomous prompt did not say where the review skills are (the run looked for `review-orchestrator/SKILL.md` at a path that does not exist) and did not say how to get past the routing guard that refused a raw `git diff` in the child shell. When the loop guard ended a run after a floor refusal, the summary reason led with the floor.

## Expected Outcome

- A package whose ref is a pull request URL is PR-bound under every target kind; a recorded head that differs from the PR head cannot close it unless the report names the reviewed SHA and says the PR moved, or `complete --head` replaces the head (with the warning of #1015, unchanged).
- The autonomous prompt names `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md` and the `keryx ctx` / `# keryx:raw <why>` ways past the guard.
- A run that ended on the loop guard says so first in the summary reason; status and exit code stay `floor`.

## Outcome criteria

- Reading `summary.json` of a run that the loop guard ended shows the loop guard in `reason`.
- `keryx review complete` on a report-kind package with a PR URL ref and a stale head is refused.

## Out of Scope

- The hash-budget guard counting identical `read_file` arguments after the file changed: not confirmed in the code or in events 316-400 of the run (the file was unchanged), so not touched.
- Version bump, tag and release.

## Origin

- Запрос (дословно): «Исправляй к 1014 и 1015 сливай и выпускай релиз» (helyx 205583, in answer to 205576 «Какие мы нашли недочеты и проблемы?»).
- Эффект (формализация агента): the head gate covers every package bound to a PR URL; the autonomous prompt carries the skill path and the guard escape; the loop-guard stop is named in the summary.
- Как наблюдать (предложение агента): the tests in `complete-head-gate.test.ts` fail without the change; the next autonomous run's `summary.json` and events show no search for the skill path and no raw `git diff` refusal.

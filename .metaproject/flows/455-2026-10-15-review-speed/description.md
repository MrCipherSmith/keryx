# Reviews finish faster, complete, with an early verdict

Status: formalized
Source: user description (origin: human-request)

## Problem

Two `keryx review` rounds on vantage-frontend on 2026-10-15 took 2 h (PR #7927, 4 files,
110 lines) and 3.5 h (PR #7931, 129 files). Neither delivered on time: #7927 had its verdict
at minute 55 but held it to minute 119 behind the mutation gate and paperwork, and the PR
merged first; #7931 ended with 27 of 41 slices covered, no tests or mutation on the last HEAD.

Checked against main 2cf8c94a5, the causes that are real in keryx are:

- `review mutate` copies the repo to `tmpdir()` with a symlinked `node_modules`
  (`src/review/mutate.ts:127,146`); in vantage-frontend the baseline goes red there and the
  command fails without printing the baseline output (`:150`). ~60 min lost on #7927.
- A reviewer that finishes after the spawn deadline writes its result file, but the parent
  has already abandoned it (`spawn-subagent-tool.ts:1944-1949`); nothing reads the late file
  back, so the same wave is re-dispatched (#7931 `resume08`).
- The skill holds the verdict until ingest + `complete`; the verifier starts only after all
  reviewers (`SKILL.md:1067`); there is no early verdict.
- Every round runs the full reviewer set even for a small, low-risk diff, and the skill gives
  no estimate of assignments/duration before a role × slice dispatch.
- `dispatch-check` does not check that `skill_path` / `context_doc` exist (6 dispatches lost
  on #7931); `review required` has no `--package`; `--help` of `start`, `ingest`,
  `required`, `mutate`, `blast-radius`, `complete`, `status` dumps the whole 33 KB help;
  `review start` blocks on a synchronous graph rebuild.
- SKILL.md:88-90 (shell host "cannot open a path") contradicts :94 (slices via
  `context_files`).

Post-mortem claims NOT reproduced on main and out of this flow unless re-observed:
`blast-radius --json` stdout noise, `layers block` overwriting a current `layers.json`,
`ingest` rejecting fileless findings / dropping verifier claims, stale `graph@head` label.

## Expected Outcome

A review round on a small low-risk PR gives its verdict in about 20 minutes; a round on any
PR gives the operator a verdict as soon as reviewers and the verifier are done, before
mutation/ledger/complete; a round on a large PR states its expected assignments and
duration before dispatch and reaches full coverage without re-dispatching finished work;
`review mutate` works in a vantage-frontend-shaped repo or says why it cannot.

## Outcome criteria

- Запрос (дословно): «Создавай план, спецификацию, запускай фло: эффект: ревью должны проходить быстрее и качественнее и до завершения. Что проверить и как: я буду проводить ревью, через 2-3 дня смогу дать ответ.» (source: claude-code session 2026-10-15, after post-mortem of vantage-frontend PR #7927/#7931)
- Эффект (формализация агента): ревью в vantage-frontend на выпущенной версии keryx
  отдают вердикт рано (маленький PR вне risk-класса — около 20 мин; любой PR — сразу после
  ревьюеров и верификатора), доходят до полного покрытия без повторных волн, а
  `review mutate` не падает молча.
- Как наблюдать (предложение агента): владелец проводит 2–3 реальных ревью в
  vantage-frontend на релизе с этим фло (минимум одно маленькое и одно большое) и через
  2–3 дня сообщает: время до вердикта, дошёл ли раунд до `complete`, были ли повторные
  dispatch и падения `mutate`.

## Out of Scope

- Rewriting or shrinking SKILL.md as a whole (only the sections this flow changes).
- The four post-mortem claims not reproduced on main (listed above).
- Reviewer prompt quality / finding precision beyond the early-verifier change.
- Fixing F-001 in vantage-frontend (separate repo).

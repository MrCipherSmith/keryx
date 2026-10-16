# Large-PR reviews scale by risk, not by graph reach, and find more

Status: formalized
Source: user description (origin: human-request)

## Problem

Two reviews on keryx 0.3.118 (vantage-frontend #7931, #7947) planned 222 and 420
reviewer dispatches plus 123 and 189 mandatory regression chunks over 3370 and 4695
graph-related files, and finished neither. Verified causes (anchors from main):

- Blast radius is a file-level BFS over reverse imports with no symbol resolution, no
  barrel traversal and no hub damping (src/gdgraph/affected.ts:41-91,
  src/review/blast-radius.ts:107-110,303,365); a hub like `src/i18n/index.ts`
  (fan-in 1689) pulls in every importer.
- Every cap-dropped file becomes a mandatory chunk; readiness item `blast-radius` and
  the coverage gate refuse completion until all are read (src/review/chunks.ts:92,139,419;
  readiness.ts:23,127; coverage-complete.ts:172). No reasoned omission exists.
- Roles own every slice unless one of five path gates applies; `frontend-conventions`
  matches any `.ts` (coverage.ts:51-57, waves.ts:5-8). jev-risk/jev-select exist but
  are not wired in. `estimate` only prints (estimate.ts:40-64).
- Bugs: `waveBytesOf` yields NaN on a manifest without sizes and the byte check then
  passes silently (slice.ts:66, dispatch-check.ts:78,144); chunk halves record
  proportional, not real, sizes (chunks.ts:270-281); blast-radius changed files come from
  the working tree, layers base falls back to HEAD~1 (review.ts:3811, layers.ts:570).

A harness audit (keryx shell, Claude Code, Codex, autonomous, triggers) found more:
in Claude Code nobody writes `raw/`/drivers so `complete` refuses; the shared
`.metaproject/data/review/raw` leaks earlier rounds into `verdict`/`retry-plan`; child
reviewers cannot run commands so the verifier is capped at `unverifiable`; the autonomous
prompt runs `required` without scope (always full) and up to 5 rounds on one head;
`isAttendedRun` makes headless runs refuse; `chunks estimate --mode automatic` and
`publish --yes` bypass the operator; mutation waiver / override / `comments reply --final`
have no card or TTY gate; item 10 is unobservable outside keryx shell; wave bytes are
sized for keryx's 5-min deadline on hosts without it; `review_wave` guidance is missing;
the 16000-char child output cut fails the result gate; Codex/other hosts are declared
compatible but BLOCK; plus stale skill text (nine vs ten readiness items, `--all`
default, `gh pr review`, etc.).

## Expected Outcome

A large-PR round reads every changed line, routes each slice to the roles its content
needs, goes deep where the risk is, treats graph-reachable but unaffected files as
reasoned context, asks the operator before an expensive plan, and completes in every
supported harness. Measured on historical keryx PRs with known defects, the new plan
finds at least the known blocker/major defects (better: more) with far fewer dispatches.

## Outcome criteria

- Запрос (дословно): «нужно не только что бы не упало но и улучшилось, тебе задание - исправить то что нашли, затем еще раз перепроверить весь ревью процесс, учитывая и то что он запускаеся в keryx shell и так же может запускаться в других харнесах. Проверь на разных ПР - можшь брать keryx и закрытые. Я утром надеюсь увидеть отчет и новый релиз» (source: claude-code session 2026-10-16, after two 0.3.118 large-PR review reports (vantage-frontend #7931, #7947))
- Эффект (формализация агента): ревью больших PR планирует в разы меньше запусков,
  без обязательного чтения тысяч графовых файлов, доходит до `complete` в keryx shell,
  Claude Code и автономном режиме, и на эталонных PR keryx находит не меньше известных
  blocker/major (лучше — больше), чем прежний план.
- Как наблюдать (предложение агента): отчёт eval в пакете фло (старый vs новый план на
  #424, #939, #940, #1005: найденные эталонные дефекты, новые находки, запуски, время);
  утром — релиз 0.3.119; дальше — следующее ревью большого PR владельцем.

## Out of Scope

- Changing reviewer skills' review content beyond routing/inputs.
- A general symbol-level gdgraph rewrite (only the review radius uses symbol reach).
- vantage-frontend-specific tuning.

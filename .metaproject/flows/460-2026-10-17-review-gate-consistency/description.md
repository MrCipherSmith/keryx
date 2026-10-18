# Review gates agree: readiness, complete, overrides, nudges, child results and artifacts tell one story

Status: formalized
Source: owner (origin: human-request)

## Problem

A live keryx 0.3.120 review of vantage-frontend PR #7975 (keryx shell, Codex model, a 2-file / 38-line diff, package under `output/review-pr-7975/.metaproject/reviews/…-r03`) turned a finished review into a long loop:

- A. `review readiness` said READY 10/10 while `review complete` refused ("dispatch covers 3 of 11 reviewers that mode all requires"; "the diff could not be resolved from git"). Root causes (code-confirmed): the light-round recheck runs `git diff <target.ref>...<head>` where `target.ref` is the PR URL, so git always fails and the full set applies; git runs at `projectRootOfPackage` (the dir holding `.metaproject`, here a subdirectory), not the repository top level; readiness never runs the coverage gate.
- B. Three confirmed `reviewer-override` decisions did not let complete pass: coverage reads operator decisions only when the dispatch carries `override`, which nothing writes.
- C. A control nudge kept pointing at another PR's package (#7912): the completion gate scans only `<cwd>/.metaproject/reviews`, picks the newest open package, ignores the active-review pointer and session start.
- D/E. A child that returned no text came back `Completed`, ok; a DONE reply without `slices` claims every assigned slice (`scopeComplete: true`) even when the child said it could not read its inputs.
- F. `research.json` kept "Not run: mutation (light round)" after a mutation pass ran; coverage/manifest listed only `review-orchestrator` while three reviewers ran.

From the flow 459 review of PR #1043 (cost ~12M subagent tokens, 7 rounds):
- G. `review ingest` refused the whole round because some reviewer quotes did not match the file exactly, so no round was recorded and rounds 2+ could not run as automatic deltas.
- H. Nothing records per-dispatch token use, so the cost of a review cannot be stated.
- I. Flows 458 and 459 are implemented and released but not closed in Task Manager.

## Expected Outcome

One effective reviewer set and one depth decision, computed once and used by required, readiness, ledger and complete; a recorded operator override counts; git diffs for a package run at the repository top level against the real base; the shell nudges about the review this session is running; an empty or input-starved child never counts as coverage; package artifacts reconcile with what actually ran; an ingest keeps a finding whose quote it cannot place (no guessed anchor, flagged) instead of refusing the round, so `review plan` finds the previous round and the next round is a delta; every dispatch's token use lands in the package and the report states the review's spend.

## Outcome criteria

- Запрос: «как закончишь, изучи новый отчет» (PR #7975 process report) → «Фло 460 после релиза 459»; «А откуда так много дифа? И сколько потратили на ревью?» (claude-code session 2026-10-16/17).
- Эффект: маленький PR закрывается одним проходом без ручных обходов; повторный раунд после фиксов сам становится дельтой; стоимость ревью видна в отчёте.
- Как наблюдать: на следующем PR vantage-frontend readiness и complete согласны с первого раза, override работает, уведомления про свой PR; на keryx PR раунд 2 планируется как delta автоматически и в отчёте есть токены.

## Out of Scope

- Changing what reviewers look for.
- A new confirmation path for operators without a terminal or keryx shell (separate task).

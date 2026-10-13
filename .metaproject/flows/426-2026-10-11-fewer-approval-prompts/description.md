# Keryx Shell: fewer approval prompts in trust and review-auto

Status: draft, awaiting operator approval of the criteria
Source: live run 19 of the PR 7435 review (flow 417 AC16), 2026-10-11; operator question the chat bot 197414.

## Problem

In `trust` with `--review-system review-auto` the shell still stopped for an operator answer many times during one review: about 25 modals in the night of 2026-10-10/11 and three repeats of the same refused `keryx harness wave` in run 19. Causes seen:

- The rule "a call that follows untrusted external content cannot authorize itself" applies to every command that is not in the short trust routine list (`keryx review`, `keryx ctx`, read-only `keryx flow`, `gdgraph`, `git`, `bun test`). Read-only help and listing commands (`keryx harness --help`, `keryx agents external list`, `keryx review ledger build`, slate notes) fall outside it and ask.
- The denial memory (flow 422/PR 960) keys on the exact command, so the model retries a call with slightly different arguments and gets a fresh modal.
- The operator cannot tell why a prompt appeared, or why a typed message sits in the queue.

## Expected Outcome

A review in `trust` + `review-auto` asks the operator only for the floors no mode lifts. Every prompt that does appear says why. A call the operator already refused never comes back as a modal.

## Outcome criteria

- Запрос (дословно): «А почему вообще возникают вопросы? разве мы не ввели моды? То есть где то внутри должно быть так что бы вопрос даже не появлялся?» (source: the chat bot 197414, 2026-10-11T06:57Z)
- Эффект (формализация агента): in `trust`/`review-auto`, read-only keryx commands run without a prompt even after untrusted content; a refused call, in any argument spelling, is answered with an immediate refusal to the model and not shown again; each prompt and each queued message states its cause.
- Как наблюдать (предложение агента): replay the approval log of runs 17-19 (`~/notes/evidence/run17/approvals.log`) through the classifier and count the prompts left; repeat the PR 7435 review and watch for modals.

## Out of Scope

- Lifting any hard floor (destructive, credentials, publish lease, hook-ask).
- Changing the `ask` mode.
- The autonomous profile (flow 424) and the arbiter (flow 425).

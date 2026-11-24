# Desktop Review v2 stage 2: Review entity, rounds and the Reviews tab

## Problem

Desktop stores every review attempt as an independent row in `runs.sqlite` (`src/review/desk-run-store.ts`). Attempts of one PR are not grouped, a run has no link to the run of the previous round (spec O12), and the whole review interface (history, publication, rules) lives inside the Pull requests panel. Until a Reviews tab exists, stage 0 lets a local review that waits on the user light the Pull requests tab indicator (deviation (b) of the implementation plan), and the outdated-review action keeps the interim label "Review again" (decision (d)).

Source: `docs/requirements/keryx-desktop-review-v2/` — PRD R8, the rest of R4, R12; specification sections «Сущности», «Хранение», «Reviews», «Контракты данных»; implementation plan v0.1.3, stage 2 row and «Передача следующим этапам».

## Expected outcome

- Every attempt in `runs.sqlite` belongs to exactly one Review (`reviews` table, key repository id + PR number + viewer, D3) and carries its round number and the id of the attempt it follows (`review_id`, `round`, `previous_run_id`). Existing databases are migrated in place; new attempts are assigned when they are recorded.
- A project tab **Reviews** (order Sessions, Flows, Reviews, Pull requests, Issues, Metaproject — D4) shows one card per Review with its own columns, list view, filters and a panel with the rounds and the review interface moved out of the Pull requests panel (history, report, publication), and the Review rules button.
- The Reviews tab indicator lights for `needs_answer`, `ready` without a publication decision and `stopped`. The Pull requests indicator no longer lights from a local review (closes deviation (b)).
- The outdated-review action is relabelled to say it starts a new round of the same Review (decision (d)); the update round itself is stage 3.
- F-024 (`secondaryNote` text comparison) is gone.

## Out of scope

- Update round, `keryx review advance`, `on_head_move` behaviour, publication variants for a moved head (stage 3). The `on_head_move` column is stored with default `ask` (D2) but nothing reads it yet.
- Session-package registration and shared publication code (stage 4).
- The PR card work row and its review link (stage 1, PR #1300); this flow exposes the round on the badge so stage 1's link can show it after both merge.
- Persistent per-finding identity across rounds (`Finding` entity) beyond what round packages already record.

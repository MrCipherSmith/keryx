# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

These four are created by `keryx flow init` as a default checklist. Add your
own with `keryx flow task add`; a scaffold row your plan supersedes is closed
with `--disposition skipped --reason "<why>"`, not left open.

| ID | Kind | Title |
|----|------|-------|
| T1–T4 | — | Scaffold rows superseded by T5–T10 |
| T5 | implement | D1: publish as is for the reviewed commit — `desk-publication.ts`, `desk-publication-types.ts`, `ReviewPublishDialog.tsx`, tests (plan A) |
| T6 | implement | D2: `on_head_move` — `src/review/head-move.ts` + test (plan B) |
| T7 | implement | Prior-attempt selection — `src/review/update-round.ts` + test; settings test in `prior-round.test.ts` (plan C) |
| T8 | implement | Item 3: "Review again" as an update round of the same Review — blocked until stage 2 (flow 519) pushes the rounds migration (plan D) |
| T9 | verify | Backend and Desktop review suites, typecheck, lint, invariant diff (AC8) |
| T10 | review | review-orchestrator round on the branch |

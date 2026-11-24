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
| T8 | implement | Item 3: "Review again" as an update round of the same Review — implemented after stage 2's rounds landed, by T12 (backend) and T13 (Desktop); originally blocked until stage 2 (flow 519) pushed the rounds migration (plan D). Must, in the same change: replace the live previous-run rule in `desk-run-service.ts` (no second rule left), relax `prior-round.ts` packageTrust and `round-record.ts` REVIEWED_STATUSES for partial rounds, align `findingsKnown: undefined` handling with `pr-context.ts`/`desk-run-legacy.ts` (review round 1: architecture F-001, degradation F-002), and settle where the `on_head_move` default is resolved for a Review mixing manual and scheduled attempts (architecture F-002) |
| T9 | verify | Backend and Desktop review suites, typecheck, lint, invariant diff (AC8) |
| T10 | review | review-orchestrator round on the branch |
| T11 | implement | Fix round 1: findings of review round 1 on PR #1303 |
| T12 | implement | Item 3 backend: update round builds on the previous round (prior selection, partial package, trust rule) |
| T13 | implement | Item 3 Desktop: Update review action and finding answers carried by id |
| T14 | implement | Fix round 2 backend: prior selection fallback, one prior rule for answers, registry lock and vouch API, compare cache, superseded as-is |
| T15 | implement | Fix round 2 Desktop: Update busy/guard/autoPublish/Sessions, tests, docs |

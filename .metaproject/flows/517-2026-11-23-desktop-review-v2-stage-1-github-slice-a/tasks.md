# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

These four are created by `keryx flow init` as a default checklist. Add your
own with `keryx flow task add`; a scaffold row your plan supersedes is closed
with `--disposition skipped --reason "<why>"`, not left open.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | implement | Subject storage: `flags.json` `subject`, `_keryx/session_flags`, issue binding writes `subject` (plan slice 1; AC8) |
| T6 | implement | Issues source `repository` in `keryx issues list` (plan slice 2; AC13 backend) |
| T7 | implement | PR board GitHub-only lanes, grouping, quick filters, GitHub reason (plan slice 3; AC1–AC4, AC14) |
| T8 | implement | PR work row, signed actions, PR-bound sessions, `/review` and Create Flow from session (plan slice 4; AC5–AC10) |
| T9 | implement | Issues board GitHub grouping, repository default, work row (plan slice 5; AC6, AC11–AC13) |
| T10 | test | Scenario test PR → session → `/review` → link on card (AC16) |
| T11 | verify | Focused suites, typecheck, attachBadges/localBadge agreement (AC15, AC18) |
| T12 | verify | Mutation check of edited attention-set lines (AC14) |
| T13 | verify | Toolbar re-measure if `.flows-toolbar` changed (AC17) |
| T14 | docs | Implementation plan: stage 1 state, deviation (a) status (AC19) |

T1 done (context in `context.md`); T2 and T3 skipped as superseded; T4 is the review/PR step.

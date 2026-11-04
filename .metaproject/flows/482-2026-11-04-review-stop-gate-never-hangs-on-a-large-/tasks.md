# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

These four are created by `keryx flow init` as a default checklist. Add your
own with `keryx flow task add`; a scaffold row your plan supersedes is closed
with `--disposition skipped --reason "<why>"`, not left open.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Stop gate: bounded, scratch-skipping, abortable signature walk; holdReviewGate passes the turn signal (AC1-AC4) |
| T3 | test | Add/adjust tests and make them pass (folded into T2/T5: each worker writes its tests red-first) |
| T4 | review | Review round on the PR |
| T5 | implement | Mutation pass: skip linked worktrees in copyTree, owner marker, sweep stale scratch; help + guide text (AC5, AC6) |
| T6 | verify | Before/after measurement of one gate evaluation on a fixture with large scratch + nested worktree (AC8) |

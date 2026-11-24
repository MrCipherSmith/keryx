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

Scaffold rows T1–T4 are closed as skipped; the plan uses:

| ID | Kind | Title |
|----|------|-------|
| T5 | implement | Head moved procedure in review-orchestrator (both copies) + preflight test |
| T6 | context | Divergence map of session and Desktop publish paths with extraction plan |
| T7 | implement | Shared publish code (blocked on stages 2 and 3) |
| T8 | implement | Session and Desktop prompt use the same update command (blocked on stage 3) |
| T9 | review | Review round on the branch via review-orchestrator |
| T10 | verify | Real-PR scenario: session review published from Desktop |

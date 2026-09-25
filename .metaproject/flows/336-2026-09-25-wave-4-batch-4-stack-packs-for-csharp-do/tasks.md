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

T1 was done inline by the runner (reading W1/W2/rubric-guide specs and the
python/go/angular/vue templates before dispatch) rather than delegated — see
context.md "Agent Findings". T2 is split into 4 parallel worker dispatches
(one per stack id) plus runner-only shared-file wiring, per plan.md.

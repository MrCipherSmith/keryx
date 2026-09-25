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
| T5 | implement | Lane A: project hook trust gate and tighten-only built-ins (R700-01/02, hooks.ts writes) |
| T6 | implement | Lane B: contained observer/impact-evidence writes and ratchet coverage (R700-03/04) |
| T7 | implement | Lane C1: CLI help, usage, registry and docs (R700-05/07/08/09/13/18) |
| T8 | implement | Lane C2: update idempotence, labels, import provenance, update.ts (R700-06/10/11/12/14) |
| T9 | verify | Re-run the review's 12-step manual test plan in a scratch repo; step 12 must pass |
| T10 | review | PR review/fix loop and CI |

T2/T3/T4 are the init scaffold; they close when T5-T8 (implementation + tests) and T10 (review) close.

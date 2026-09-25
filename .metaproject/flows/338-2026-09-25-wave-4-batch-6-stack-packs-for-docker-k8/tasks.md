# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

These four are created by `keryx flow init` as a default checklist. Add your
own with `keryx flow task add`; a scaffold row your plan supersedes is closed
with `--disposition skipped --reason "<why>"`, not left open.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context — skipped, superseded by T5-T11 |
| T2 | implement | Implement per plan — skipped, superseded by T6/T7/T8 |
| T3 | test | Add/adjust tests and make them pass — skipped, superseded by T10 |
| T4 | review | Self-review and prepare draft PR — skipped, superseded by T11 |
| T5 | implement | Extend authoring-lint.ts for extensionless filename globs + STACK_EXTENSIONS entries |
| T6 | implement | Author docker-k8s-terraform pack |
| T7 | implement | Author ci-github-gitlab pack |
| T8 | implement | Wire both packs into install-manifest.json |
| T9 | docs | Update W1/W2 docs with batch 6 implementation notes |
| T10 | test | Offline integrity/lint checks + commit per pack |
| T11 | review | Push branch, report READY_FOR_GATE, wait for go-ahead |

Phase B tasks (calibration, honest gate, PR, opus review, merge) will be
added once the orchestrator confirms PR #719 and flow 334 are merged.

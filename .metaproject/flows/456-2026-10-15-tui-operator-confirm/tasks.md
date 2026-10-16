# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title | Depends | AC |
|----|------|-------|---------|----|
| T1 | context | Collect remaining context (done at init: context.md) | | |
| T2 | implement | Implement per plan (superseded by T5-T8) | | |
| T3 | test | Tests (superseded: ship with each task) | | |
| T4 | review | Self-review (superseded by T9) | | |
| T5 | implement | Framework: operator-confirm helper, registration, unattended list, TUI card | | AC1 |
| T6 | implement | Review gate tools: chunks answer, publish, waive coverage, waive readiness | T5 | AC2, AC4 |
| T7 | implement | Other gate tools: flow confirm, external apply, learn, schedule actions | T5 | AC3, AC4 |
| T8 | docs | Redirect refusals, skills and decision record | T6, T7 | AC5, AC6, AC7 |
| T9 | review | Verify + review round + PR | T8 | AC8 |
| T10 | verify | Patch release after merge | T9 | AC9 |
| T11 | verify | Owner live check in keryx shell | T10 | AC10 |

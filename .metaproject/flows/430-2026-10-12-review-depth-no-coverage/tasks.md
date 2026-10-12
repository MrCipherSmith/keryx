# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Draft: the scaffold rows below are placeholders. Replace them with
`keryx flow task add` (and close superseded scaffold rows with
`--disposition skipped --reason "<why>"`) after the operator approves the PRD and criteria.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context; write the anonymous attribution table (AC6) |
| T2 | implement | Proposed: slice shape in retry-plan, schema and prompt (AC1, AC2) |
| T2b | implement | Proposed: driver `definition` and raw triage (AC3, AC4) |
| T2c | implement | Proposed: `keryx review diagnose` and TUI surfaces (AC5, AC8) |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR; docs, CHANGELOG (AC8, AC9) |
| — | judged | Release, `keryx update` in the bench, live rerun (AC10) |

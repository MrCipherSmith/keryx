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
| T5 | implement | Read-only checkout catalog, containment, snapshot evidence and link rows |
| T6 | implement | OpenSpec requirement and delta parser with archive semantics |
| T7 | test | Portable fixtures and catalog, history, search regression coverage |
| T8 | implement | Shared read service, artifact detail and scoped stable search |
| T9 | implement | Explorer v2 projection, evidence and v1 compatibility |
| T10 | implement | OpenSpec CLI, Shell routing, guide and core CI discovery |
| T11 | implement | Desktop OpenSpec reader, tabs, history and graph navigation |
| T12 | verify | Verify focused core and Desktop checks in GitHub CI |
| T13 | verify | Verify packaged Desktop, Shell parity and large-fixture usability |
| T14 | review | Review all implementation lanes and record verification evidence |
| T15 | implement | Honor the whole discovery budget on the documented archive fixture |
| T16 | implement | Close review findings on delta summaries, search and evidence parity |
| T17 | implement | Close Desktop review findings on global search pages and source links |
| T18 | implement | Resolve cross-entry OpenSpec Markdown artifacts by indexed owner |

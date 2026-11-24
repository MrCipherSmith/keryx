# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context (done in the orchestrating session: plan, spec, stage 1 diff) |
| T2–T4 | — | Scaffold rows superseded by T5–T13 |
| T5 | implement | Store: reviews table, rounds and attempts, migration and its test, badge round with parity |
| T6 | implement | Reviews read model, `keryx review reviews --json`, bridge arg and platform call |
| T7 | implement | Reviews tab: navigation, board/list/filters, Review panel with the moved review interface, indicator |
| T8 | implement | Pull requests board: indicator without local review, "New review round" label, F-024 |
| T9 | verify | Migration on a copy of the local working database |
| T10 | verify | Test suites, typecheck and lint |
| T11 | verify | Reviews toolbar measurement at 1100/760/560px |
| T12 | review | review-orchestrator on the PR |
| T13 | docs | Implementation plan stage 2 state, deviation (b) closed, CLI reference |

Details for each implementation task are in `plan.md`.

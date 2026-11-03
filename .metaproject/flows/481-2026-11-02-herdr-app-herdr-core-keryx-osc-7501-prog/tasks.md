# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title | Depends | ACs |
|----|------|-------|---------|-----|
| T1 | context | Collect remaining context (context.md "Agent Findings") | — | — |
| T2 | implement | Implement per plan — superseded by T5–T9 | — | — |
| T3 | test | Add/adjust tests — superseded: tests-first inside T5–T9 | — | — |
| T4 | review | Review (review-orchestrator) and prepare the PR | T10, T11 | all |
| T5 | implement | OSC 7501 encoder, herdr-core mapper, reporter | — | AC1–AC5 |
| T6 | implement | TUI wiring, render-safe writer, debug env | T5 | AC5, AC6 |
| T7 | implement | `keryx shell "<task>"` initial prompt | T6 | AC7 |
| T8 | implement | `<hc from>` framing + herdr-core context section | T7 | AC8, AC9 |
| T9 | implement | `keryx herdr install/remove/status` + registry + icon + template | — | AC10–AC12 |
| T10 | docs | Guide, CLI reference, upstream snippet | T8, T9 | AC16 |
| T11 | verify | Live run under an isolated herdr-core session | T8, T9 | AC13, AC14 |
| T12 | verify | Live check in the operator's Herdr app (go-ahead needed) | T11 | AC15 |

AC17 (typecheck, lint, terminal suite) is checked on the PR's CI run.

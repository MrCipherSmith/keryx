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
| T4 | review | Self-review and prepare draft PR (opus review of the PR diff, review/fix loop) |
| T5 | implement | Gate plumbing: eval --runner wiring, multi-skill pack eval gate, pack guards, agents verify resolvers (AC4, AC6) |
| T6 | implement | Pack ts-js-node (AC1, AC2) |
| T7 | implement | Pack react, extends ts-js-node (AC1, AC2) |
| T8 | implement | Pack python completion (AC1, AC2) |
| T9 | implement | Pack go (AC1, AC2) |
| T10 | implement | Agent pair generator + 8 generated agents + agent-refs.json (AC5) |
| T11 | implement | Install manifest modules/components/profiles (AC7) |
| T12 | test | Gate run: eval every pack skill with the ollama runner, record eval.json, mark stable (AC3) |
| T13 | test | Gate check: agents verify, stocktake vs baseline, guard tests, audit-harness, install dry-runs (AC5-AC10) |
| T14 | docs | W1/W2 spec updates; coverage count in journal after gate (AC11) |

T2/T3 are superseded by T5-T13 (closed skipped). Dependencies: T5-T9 parallel;
T10/T11 after T6-T9; T12 after T5+T10/T11; T13 after T12; T14 after T13.

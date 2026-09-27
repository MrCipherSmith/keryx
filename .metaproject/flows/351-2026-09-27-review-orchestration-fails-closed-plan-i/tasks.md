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
| T5 | implement | Plan follow-through opt-in, snapshot order, prompt wording (items 1, 3) |
| T6 | implement | Toolless reprompt narrowing + nudge envelope (items 8, 9) |
| T7 | implement | Tool-call budget wrap-up round + BudgetExhausted surfaced (item 2) |
| T8 | implement | spawn_subagent cwd (item 6) |
| T9 | implement | Reviewer inventory source + not-found (item 7) |
| T10 | docs | review-orchestrator fail-closed gate, publication draft gate, bridge timing (items 4, 5) |
| T11 | verify | Typecheck, targeted tests, live scripted-provider run (AC12) |
| T12 | review | review-orchestrator on the branch diff |

T1–T4 closed as `skipped`: superseded by T5–T12.

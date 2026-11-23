# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Model | Title |
|----|------|-------|-------|
| T1 | context | — | Collect remaining context (done by the audit in this session) |
| T2–T4 | — | — | Scaffold rows superseded by T5–T11 |
| T5 | implement | sonnet | Board behaviour: no filter bypass, stable order, Done lane on demand, narrowed tab indicator |
| T6 | implement | opus | Outdated review result in the card badge (SQL + localBadge + types) |
| T7 | implement | sonnet | Show the outdated review on the card and in the list |
| T8 | implement | haiku | Keep the board toolbar on one row with the detail panel open |
| T9 | verify | orchestrator | Test suites, typecheck, lint and a live check in the browser dev build |
| T10 | review | orchestrator | review-orchestrator on the branch |
| T11 | docs | orchestrator | Requirements package keryx-desktop-review-v2 and roadmap entry |

Model choice: opus for the task that changes a shared SQL projection and a cross-host contract; sonnet for multi-file UI behaviour with DOM tests; haiku for a bounded CSS change.

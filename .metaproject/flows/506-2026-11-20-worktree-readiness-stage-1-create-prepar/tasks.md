# Tasks
Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context (done in init: context.md) |
| T2 | implement | superseded by T5-T8 |
| T3 | test | superseded: tests ship with each task |
| T4 | review | Self-review and prepare draft PR |
| T5 | implement | Foundations: config loader, checkout label, git helpers, env-files, deps |
| T6 | implement | Ports journal and worktree env/exec |
| T7 | implement | prepare/create/status/remove/promote and the keryx worktree CLI |
| T8 | implement | Integration: agent lines, trigger run, subagents, external agents, doctor |
| T9 | verify | End-to-end demo and full checks |

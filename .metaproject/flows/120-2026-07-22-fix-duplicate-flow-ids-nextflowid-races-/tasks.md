# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Depends | Title |
|----|------|---------|-------|
| T1 | context | — | Collect remaining context (decide the repair policy and the `flow check` severity; see plan.md "Open questions") |
| T2 | implement | — | Implement per plan (umbrella; the concrete work is T5–T9) |
| T3 | test | — | Add/adjust tests and make them pass (worktree allocation, non-git fallback, ambiguous resolve, harness fail-closed, renumber refusals) |
| T4 | review | — | Self-review and prepare draft PR |
| T5 | implement | T1 | Repo-wide id allocation: shared git-common-dir lock + ledger in `nextFlowId`/`init` (with non-git fallback) — AC1, AC2 |
| T6 | implement | T1 | Ambiguity-safe `resolveFlowDir` + fail-closed callers (flow CLI, `review --flow`, `ManagedFlowPort`) — AC3, AC4 |
| T7 | implement | T1 | Duplicate-id rule in `keryx flow check` + collision marker in `flow list` — AC5 |
| T8 | implement | T5 | `keryx flow renumber` command (move dir, rewrite `flow.json.id`, history event, old→new mapping) — AC6 |
| T9 | implement | T8 | Repair existing collisions 002/084/103 via renumber; handle the 002 AC checksum mismatch explicitly — AC7, AC8 |
| T10 | docs | T9 | Document repo-wide allocation + worktree rule in the flow skill and project memory — AC10 |

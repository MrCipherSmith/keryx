# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context (done by flow-orchestrator itself in Phase 1: gdgraph affected + ctx rg confirmed all design-doc line targets and call sites) |
| T2 | implement | Implement the orthogonal `readOnly` gate + `/plan` command end to end (permission-mode.ts, agent.ts wiring, agent-commands.ts, shell.ts, tui-shell.ts, busy-dispatch.ts), including the tests listed in plan.md step 6 |
| T3 | verify | code-verifier: lint, typecheck, and the touched test files pass |
| T4 | review | review-orchestrator over the diff (security/logic focus — this is an approval-gate change) |

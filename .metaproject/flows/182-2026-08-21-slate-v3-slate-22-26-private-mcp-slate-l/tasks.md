# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | test | Write failing tests for AC-34..40 (cross-hand isolation, idempotent open, self-reported Anchors, Seed provenance, no-propose-without-workspaceId, idle-TTL reclaim, non-goal preservation) |
| T3 | implement | Implement plan.md steps 1-6: external-slate.ts storage, SlateSeed origin/trust fields, idle-TTL reclaim, slate.open/writeSeed/close MCP tools, WrapUpSource "external-slate" branch, review UI origin rendering — make T2's tests pass |
| T4 | review | Self-review, code-verifier, review-orchestrator; fix findings; prepare PR |

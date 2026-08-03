# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | implement | Schemas: prior_findings + metaproject on reviewer-input, memory on review-context, class_scope on reviewer-finding |
| T6 | test | Schema guards written FIRST and confirmed failing: blocker without class_scope rejected, minor without it accepted, fix-round input without prior_findings rejected |
| T7 | implement | Orchestrator SKILL.md: memory sub-step in the Context Pack, fix-round scope rule, mandatory keryx review start/ingest around dispatch |
| T8 | test | Source-level guard over every reviewer skill, written before the sweep and red until all 15 carry the class_scope contract |
| T9 | implement | Sweep the 15 reviewer skills to the new finding format — no checklist item added, removed or reworded |
| T10 | implement | Promote the flow-128 lesson draft -> accepted, reindex memory, confirm a scoped search returns it |
| T11 | test | Prove the managed-review loop on this branch: review start -> report -> ingest -> status reads it back |
| T12 | test | Mutation-check every guard this flow adds and record what went red in journal.md |
| T13 | review | Verification gates: tsc --noEmit, full bun test, keryx health run, schema validation |

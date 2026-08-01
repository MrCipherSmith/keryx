# Flow Journal

- 2026-08-01T15:27:59.707Z - flow created
- 2026-08-01T15:30:48.480Z - task-added: T5: Schemas: prior_findings + metaproject on reviewer-input, memory on review-context, class_scope on reviewer-finding
- 2026-08-01T15:30:48.560Z - task-added: T6: Schema guards written FIRST and confirmed failing: blocker without class_scope rejected, minor without it accepted, fix-round input without prior_findings rejected
- 2026-08-01T15:30:48.643Z - task-added: T7: Orchestrator SKILL.md: memory sub-step in the Context Pack, fix-round scope rule, mandatory keryx review start/ingest around dispatch
- 2026-08-01T15:30:48.722Z - task-added: T8: Source-level guard over every reviewer skill, written before the sweep and red until all 15 carry the class_scope contract
- 2026-08-01T15:30:48.805Z - task-added: T9: Sweep the 15 reviewer skills to the new finding format - no checklist item added, removed or reworded
- 2026-08-01T15:30:48.890Z - task-added: T10: Promote the flow-128 lesson draft -> accepted, reindex memory, confirm a scoped search returns it
- 2026-08-01T15:30:48.970Z - task-added: T11: Prove the managed-review loop on this branch: review start -> report -> ingest -> status reads it back
- 2026-08-01T15:30:49.053Z - task-added: T12: Mutation-check every guard this flow adds and record what went red in journal.md
- 2026-08-01T15:30:49.140Z - task-added: T13: Verification gates: tsc --noEmit, full bun test, keryx health run, schema validation
- 2026-08-01T15:31:24.703Z - frozen: 11 criteria; checksum recorded
- 2026-08-01T15:31:24.865Z - started
- 2026-08-01T16:18:22.731Z - ac-updated: Formalization pointed at .metaproject/, which is an installed copy: the source of truth is src/gdskills/bundled/ and src/gdskills/contracts/, so the original AC1-AC4 would have been satisfiable by an edit the next keryx update reverts. Two finding schemas exist, and the strict one (additionalProperties:false) would reject the field the loose one gains. The bundle carries 20 reviewer skills, not the 15 the recommended profile installs. AC12 added to pin the installed copies against the sources.
- 2026-08-01T16:23:50.885Z - task-done: T1: Collect remaining context
- 2026-08-01T16:23:50.967Z - task-done: T6: Schema guards written FIRST and confirmed failing: blocker without class_scope rejected, minor without it accepted, fix-round input without prior_findings rejected
- 2026-08-01T16:23:51.051Z - task-done: T5: Schemas: prior_findings + metaproject on reviewer-input, memory on review-context, class_scope on reviewer-finding

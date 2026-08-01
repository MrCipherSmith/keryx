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
- 2026-08-01T16:34:01.676Z - task-done: T7: Orchestrator SKILL.md: memory sub-step in the Context Pack, fix-round scope rule, mandatory keryx review start/ingest around dispatch
- 2026-08-01T16:34:01.758Z - task-done: T8: Source-level guard over every reviewer skill, written before the sweep and red until all 15 carry the class_scope contract
- 2026-08-01T16:34:01.838Z - task-done: T9: Sweep the 15 reviewer skills to the new finding format - no checklist item added, removed or reworded
- 2026-08-01T16:34:01.920Z - task-done: T10: Promote the flow-128 lesson draft -> accepted, reindex memory, confirm a scoped search returns it

## Mutation-check record (T12)

Every guard this flow adds was removed or inverted, the suite run, and the guard
restored. A guard never observed failing is decorative, so this table is the
evidence that each one is not.

| Mutation | What was changed | Tests that went red |
|---|---|---|
| schema conditional dropped | `then` removed from `review-finding.schema.json` | 2 in `review-finding-class-scope.test.ts`: the `blocker` and `major` "without class_scope is rejected" cases |
| validator ignores conditionals | `if (schema.if)` forced false in `contracts.ts` | 3: the same two, plus "`then` applies when `if` matches" |
| contract dropped from ONE skill of fifteen | `required for blocker and major` reworded in `review-style/SKILL.md` | 1 in `review-skills-class-scope.test.ts`, naming `review-style` specifically |
| ingest guard removed | `classScopeViolations` check deleted | 1: "ingest refuses a blocker or major that does not enumerate its class" |

### What the guards caught that no reading did

Three defects in this flow's own work were found by executing the pipeline, not
by reviewing it. All three are the failure mode the flow exists to remove.

1. **The rule was enforced nowhere real.** `class_scope` landed in both finding
   schemas and in all 15 skills, and `keryx review ingest` still accepted a
   `major` finding without it at exit 0 — measured, not assumed. Reviewer skills
   emit markdown; the schema only applies to a JSON finding passed to
   `keryx skills contracts validate`, which nothing runs automatically. Fixed by
   `classScopeViolations` refusing at ingest, before the package is written.

2. **`normalizeFindings` read severity from the heading line alone.** Every
   reviewer format puts `- **Severity**: blocker` on the line below, so ingested
   findings were recorded as `minor` regardless of what they said — which also
   made the new class-scope rule unreachable for exactly the findings it governs.

3. **Fixing (2) introduced (3).** Reading heading-plus-body keyword-scanned the
   prose, and a `minor` finding whose text *discussed* blockers was recorded as a
   blocker. The guard then refused this flow's own review report. That is the
   third round in this repository's history where a fix shipped a defect inside
   itself — caught here in minutes because the loop was executed rather than
   described. An explicit `Severity:` declaration now outranks any keyword.

### Guards whose weakness is stated rather than claimed away

- The orchestrator-procedure assertions match markdown prose. A reworded but
  correct instruction turns them red; a reworded but wrong one can stay green.
  Recorded in the test header. The enforcement that bites is the schema.
- `reportsFindings` classifies a reviewer by whether its SKILL.md contains
  "blocker". All 20 skills were checked by hand and the classification is correct
  today, but the detector is approximate and is not claimed otherwise.
- `hasClassScope` is a shape check over markdown — it requires the block to name
  `class_scope` and supply both `sites` and `enumeration_method`. It is not
  schema validation and the source says so.

## Managed-review loop, executed (T11)

`keryx review ingest --report <self-review> --target branch --ref
fix/review-pipeline-metaproject-context` produced
`.metaproject/reviews/2026-08-01-ingest-fix-review-pipeline-metaproject-context`
with all seven required artifacts, and `keryx review status` read it back.
`findings.json` records 2 major, 2 minor, 1 info — the severities as declared,
which is itself the regression that defect (2) above would have hidden.

Before this flow, `.metaproject/reviews/` did not exist. Eleven review rounds
across flows 127 and 128 left no machine-readable finding anywhere.
- 2026-08-01T16:42:46.489Z - task-done: T11: Prove the managed-review loop on this branch: review start -> report -> ingest -> status reads it back
- 2026-08-01T16:42:46.575Z - task-done: T12: Mutation-check every guard this flow adds and record what went red in journal.md
- 2026-08-01T16:42:46.660Z - task-done: T13: Verification gates: tsc --noEmit, full bun test, keryx health run, schema validation
- 2026-08-01T16:42:46.738Z - task-done: T2: Implement per plan
- 2026-08-01T16:42:46.822Z - task-done: T3: Add/adjust tests and make them pass

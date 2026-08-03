# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json` declares `prior_findings` (array of findings conforming to the finding schema, plus the round number and the disposition claimed for each) and `metaproject` (memory entries, wiki pages, graph blast-radius), and a schema-validation test rejects an input that omits either when the orchestrator declares a fix round.
- AC2: `src/gdskills/bundled/skills/review/review-orchestrator/review-context.schema.json` declares a `memory` block, and the orchestrator's Context Pack step in SKILL.md requires a `keryx memory search` scoped to the changed paths, filtered to `--status accepted`, with the matched entries inlined into the reviewer input. The step names the command and states that unfiltered or draft memory must not be inlined.
- AC3: BOTH finding schemas declare `class_scope` with `sites` (every location of the shape) and `enumeration_method` (how the set was derived — the grep, the source-level guard, or the exhaustive list): the bundled `reviewer-finding.schema.json` AND `src/gdskills/contracts/review-finding.schema.json`, whose `additionalProperties: false` would otherwise reject the field the other one gains. Validation REJECTS a finding of severity `blocker` or `major` that omits `class_scope` while ACCEPTING one of severity `minor` or `info` that does, and `keryx skills contracts validate --schema review-finding` agrees with the bundled schema on the same fixture.
- AC4: every reviewer skill under `src/gdskills/bundled/skills/review/` — all 20, not the 15 the `recommended` profile happens to install into `.metaproject/` — carries the `class_scope` requirement in its finding format, and a source-level test derives that skill list from the filesystem rather than a literal and fails when any member lacks it. Adding a 21st reviewer skill without it turns the test red.
- AC5: the orchestrator's scope-detection section states that a fix round reviews `merge-base..HEAD` and not the fix commit alone, and additionally requires enumerating the files that NAME whatever the fix changed (the guard, the instruction, the refusal, the helper), with the enumeration recorded in `review_context.scope`.
- AC12: the installed copies under `.metaproject/skills/gdskills/review/` and `.metaproject/core/gdskills/contracts/` match the bundled sources after the change, demonstrated by a byte comparison, so the fix survives the next `keryx update` instead of being silently reverted by it.
- AC6: the orchestrator requires `keryx review start --target <kind> --ref <ref>` before dispatch and `keryx review ingest --report <path>` after synthesis, so every round leaves a machine-readable package under the managed-review data root; the SKILL.md states that a round without an ingested report cannot be cited as a completed round.
- AC7: running the documented sequence end to end on a real reference (`keryx review start`, then `ingest` of a report produced in the new finding format) exits 0 and produces a readable package that `keryx review status` reports, demonstrated on this flow's own branch.
- AC8: the flow-128 lesson `a-fix-round-needs-its-own-review-…` is promoted from `draft` to `accepted` with the flow-128 evidence recorded, so it is eligible for AC2's `--status accepted` filter; a memory search scoped to `src/lib/config-dir.ts` returns it.
- AC9: mutation-checked — for each new guard added by this flow, removing or inverting it turns a named test red for the stated reason, and the record of what went red is written to `journal.md`. Any guard whose mutation does NOT go red is documented as untested rather than claimed.
- AC10: no reviewer checklist item is added, removed, or reworded by this flow — `git diff main` over the reviewer skills touches only finding-format, context, and scope sections. Verified by reading the diff, and stated explicitly in the completion report.
- AC11: gates — `bunx tsc --noEmit` exits 0, full `bun test` has 0 failures, `keryx health run` reports PASS, and any JSON Schema changed by this flow validates against Draft 2020-12.

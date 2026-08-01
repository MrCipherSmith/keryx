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
- 2026-08-01T16:43:33.765Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-01T16:43:35.545Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/218
- 2026-08-01T16:44:06.636Z - ac-confirmed: AC1: src/gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json declares prior_findings (round, finding $ref-ed to review-finding.schema.json, claimed_disposition, claimed_evidence) and metaproject (memory/wiki/graph), with if/then requiring both when is_fix_round is true. review-input-fix-round.test.ts: 'a fix round WITHOUT prior_findings is rejected' and 'WITHOUT metaproject is rejected' both assert the error path names the missing field; 'a first-pass review needs neither' and 'is_fix_round: false is still a first pass' pin the negative. 8 tests pass.
- 2026-08-01T16:44:06.760Z - ac-confirmed: AC2: review-context.schema.json declares a memory block with query, status_filter (enum: accepted only), entries and searched, so a round that searched and found nothing stays distinguishable from one that never searched. SKILL.md gained '### Memory (required)' naming 'keryx memory search ... --status accepted', the scoping rule, and the draft prohibition ('A draft entry is a hypothesis'). Pinned by review-skills-class-scope.test.ts: 'the Context Pack requires an accepted-only memory search' and 'memory is required, not best-effort'.
- 2026-08-01T16:44:06.842Z - ac-confirmed: AC3: class_scope with sites (minItems 1) and enumeration_method landed in BOTH src/gdskills/contracts/review-finding.schema.json (additionalProperties:false, which would otherwise reject it) and the bundled reviewer-finding.schema.json, each with the same if/then on severity. review-finding-class-scope.test.ts drives blocker and major without it (rejected, error path names class_scope), with it (accepted, errors empty - which is the half that catches additionalProperties:false), and minor/info without it (accepted). A drift guard compares the two shapes and their if/then. 12 tests pass. Mutation: dropping 'then' turns 2 red; making the validator ignore 'if' turns 3 red.
- 2026-08-01T16:44:06.925Z - ac-confirmed: AC4: All 15 reviewer skills under src/gdskills/bundled/skills/review/ that report a severity carry the contract. review-skills-class-scope.test.ts derives the list with readdirSync (not a literal), classifies by whether SKILL.md uses the severity vocabulary, and asserts the complement is empty; 5 skills are exempt by name with a reason each (4 legacy free-prose profiles, review-pr-feedback which classifies incoming human comments). It was red naming all 15 before the sweep. Mutation: rewording the marker in review-style/SKILL.md alone turns it red naming review-style. Also asserts the denominator is >15 so it cannot pass vacuously, and that every exemption names a real skill.
- 2026-08-01T16:44:07.006Z - ac-confirmed: AC5: SKILL.md gained 'Step 0: Is this a fix round?' stating 'Review merge-base..HEAD, never the fix commit alone' with the reason (narrowing hides the blast radius by construction), plus 'Enumerate what NAMES the thing the fix changed' with the PR #216 evidence (one instruction of four corrected, the other three silently broken), and requires the enumeration recorded in review_context.scope.files. Pinned by 'a fix round is scoped to the branch, not to the fix commit'.
- 2026-08-01T16:44:07.087Z - ac-confirmed: AC6: SKILL.md 'Managed Review Feedback Loop' now says a fix round is managed, not optional: keryx review start before dispatch, keryx review ingest after synthesis, and a round whose findings were never ingested cannot be cited as completed - with the measured reason (.metaproject/data/reviews/ did not exist after eleven rounds). Pinned by 'a fix round must be recorded through the managed-review CLI'.
- 2026-08-01T16:44:07.170Z - ac-confirmed: AC7: Executed on this branch: keryx review ingest --report <self-review> --target branch --ref fix/review-pipeline-metaproject-context produced .metaproject/reviews/2026-08-01-ingest-fix-review-pipeline-metaproject-context with all seven required artifacts (manifest, scope, coverage, report, findings.json, learning, decisions); keryx review status read it back reporting mode ingest, target branch, coverage 1. findings.json records 2 major / 2 minor / 1 info as declared. The first attempt was REFUSED by the new guard for a false positive, which is how defect 3 in the journal was found.
- 2026-08-01T16:44:07.251Z - ac-confirmed: AC8: The lesson is Status: accepted at Version 0.3.0 with the flow-128 and flow-129 evidence recorded in its changelog, including why promotion was mechanically necessary (AC2's --status accepted filter would otherwise exclude the one lesson naming this exact failure). keryx memory index reindexed 4 entries; 'keryx memory search "fix round review config-dir" --status accepted' returns it ranked first at 2.398.
- 2026-08-01T16:44:07.333Z - ac-confirmed: AC9: Mutation table in journal.md: 4 guards, each removed or inverted, each red for the stated reason - schema 'then' dropped (2 red), validator ignores 'if' (3 red), contract dropped from one skill of fifteen (1 red naming review-style), ingest guard deleted (1 red). Three guards are documented as untested-in-part rather than claimed: the markdown procedure assertions, the substring reportsFindings detector, and hasClassScope as a shape check rather than schema validation.
- 2026-08-01T16:44:07.413Z - ac-confirmed: AC10: No reviewer checklist item was added, removed or reworded. Every one of the 15 skill diffs is a single insertion of the '### Class scope' block immediately after the existing '## Finding Format' or '## Output Contract' heading; the insertion script reported the line number per file and touched nothing else. The orchestrator additionally gained the Memory, Step 0 and managed-round sections, none of which are checklist items.
- 2026-08-01T16:44:07.492Z - ac-confirmed: AC11: bunx tsc --noEmit exits 0 with no output. bun test: 2666 pass / 14 skip / 0 fail across 278 files. keryx health run: PASS, score 93, trend stable, no gate conditions triggered. Every schema changed by this flow is Draft 2020-12 and is exercised by the validator in the tests above; the managed-review manifest schema validation in createManagedReviewPackage still passes.
- 2026-08-01T16:44:07.575Z - ac-confirmed: AC12: bun ./src/cli.ts skills install --profile recommended re-synced the installed copies, then diff -q confirmed byte equality for reviewer-input.schema.json, review-context.schema.json, reviewer-finding.schema.json, review-orchestrator/SKILL.md, review-logic/SKILL.md and core/gdskills/contracts/review-finding.schema.json. The fix therefore survives the next keryx update instead of being reverted by it - the defect that would have made the original AC1-AC4 satisfiable by an edit with no effect.
- 2026-08-01T16:44:12.066Z - completing
- 2026-08-01T16:44:13.672Z - completion-failed: pull-request: PR checks not green
- 2026-08-01T18:56:48.783Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/218
- 2026-08-01T18:56:48.946Z - completing
- 2026-08-01T18:56:50.578Z - done: all gates passed

# Implementation Plan

Status: formalized

## Approach

Three of the five causes are schema changes, one is an orchestrator procedure
change, and one is a finding-format change replicated across 15 skills. The
sequencing follows from that: schemas first, because the orchestrator procedure
and the reviewer skills both have to name fields that exist; the 15-skill sweep
last, because it is the one with a class-shaped guard and the guard has to be
written against the finished contract.

The alternative considered and rejected was implementing
`docs/requirements/flow-reviewer/` instead. It is the correct long-term home for
per-reviewer durable history and supersedes part of what is patched here, but it
is a whole specification-ready package and this problem is costing rounds today.
Recorded as out of scope in `description.md`, with this flow deliberately shaped
so nothing in it has to be undone when that package lands: the schema fields and
the `class_scope` contract are what `flow-reviewer` would consume anyway.

## Steps

1. **Schemas.** Add `prior_findings` and `metaproject` to
   `reviewer-input.schema.json`; add the `memory` block to
   `review-context.schema.json`; add `class_scope` to
   `reviewer-finding.schema.json` with the severity-conditional requirement
   (Draft 2020-12 `if`/`then` on `severity`). Validate each against the
   metaproject contract validator.

2. **Schema tests first, and failing.** Before any orchestrator prose: a test
   that a `blocker` without `class_scope` is rejected and a `minor` without it is
   accepted; a test that a fix-round input without `prior_findings` is rejected.
   Confirm both fail for the stated reason before implementing.

3. **Orchestrator procedure.** In
   `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md`: the
   Context Pack step gains the `keryx memory search --status accepted` sub-step
   with the scoping rule and the draft-memory prohibition; the scope-detection
   section gains the fix-round rule (`merge-base..HEAD` plus files that NAME what
   the fix changed); the dispatch section gains the mandatory
   `keryx review start` before and `keryx review ingest` after.

4. **The 15-skill sweep, with its guard written first.** Write the source-level
   test that derives the reviewer list from the filesystem and asserts each
   carries the `class_scope` requirement — confirm it fails naming all 15 — then
   add the section to each skill until it goes green. This is the shape that
   worked in flow 128 (`config-dir.writers.test.ts`): the denominator comes from
   the code, and the complement must be empty.

5. **Promote the lesson.** Move
   `a-fix-round-needs-its-own-review-…` from `draft` to `accepted` with the
   flow-128 evidence, then `keryx memory index` and confirm a scoped search
   returns it.

6. **Prove the loop on this branch.** Run `keryx review start` against this
   branch, produce a report in the new format, `keryx review ingest` it, and
   confirm `keryx review status` reads it back. This is AC7 and it is the only
   thing that distinguishes "documented" from "works".

7. **Mutation-check every guard added**, record the table in `journal.md`, then
   gates and draft PR.

## Risks

- **The 15-skill sweep is exactly the per-site shape this flow exists to
  eliminate.** Mitigated by writing the guard before the edits (step 4) so the
  test is red until all 15 are done, and by deriving the list from the
  filesystem rather than typing it.
- **Draft 2020-12 conditional requirement is easy to write and not verify.** The
  `if`/`then` on `severity` can silently never fire. Mitigated by step 2: both
  the accept case and the reject case are tested before implementation, and the
  guard is mutation-checked in step 7.
- **`keryx review` has been documented-but-unused for eleven rounds, so its
  real behaviour is unproven here.** Its CLI surface was probed during
  formalization (`start`/`ingest` accept `--target`/`--ref`), but no package has
  ever been created in this repo. If step 6 finds the runtime cannot do what
  SKILL.md describes, that becomes a recorded finding and AC6/AC7 are re-scoped
  through `keryx flow ac update` rather than quietly weakened.
- **Reviewer prompts grow.** Memory and prior findings cost tokens in every
  reviewer prompt. Mitigated by D2's filter (accepted only, scope-intersecting
  only) and by the orchestrator already owning `token_policy.omissions`, which
  must record what was dropped.

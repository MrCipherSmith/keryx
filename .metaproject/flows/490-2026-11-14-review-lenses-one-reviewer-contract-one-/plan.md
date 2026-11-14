# Implementation Plan

Status: approved by owner 2026-11-14 ("Запускай")

## Approach

Edit the lens skills where they contradict the orchestrator, not the orchestrator to fit the lenses — except for the one sentence that lists what a reviewer may run, where the lenses' read-only layer commands are the intended design (pinned by `reviewer-layer-block.test.ts`) and the orchestrator sentence is the outlier.

Every lens edit lands in `src/gdskills/bundled/skills/review/<lens>/SKILL.md` and is mirrored byte-for-byte to `.metaproject/skills/gdskills/review/<lens>/SKILL.md`; each touched skill bumps `metadata.version`; `src/gdskills/skill-length-ceilings.ts` is lowered to the new length where a file shrinks (it may only go down; a file that grows needs its ceiling raised with a stated reason in the journal).

A new test `src/gdskills/review-lens-contract.test.ts` pins the mechanical invariants (no stale references, no in-tree mutation instructions, schema shape, the orchestrator's command list) so they cannot drift back.

Quality guard: a recall bench before and after, reusing the scratch bench of this session (historical diffs with known fixed blocker/major, lens reviewers with the bench brief, blind judges). Baseline = the 150 KB-slice runs already recorded for c02/c03/c05/c09 (logic, security-code; regression on c02) plus new testing-practices baseline runs; the after-runs use the edited lens files with everything else identical.

## Steps

1. T1 contract + schema: orchestrator command list; `sites` minItems 0 with `enumeration_method` (check every validator/consumer of the schema, incl. `src/review/chunk-findings.ts`); merge the duplicated `known_findings`.
2. T2 no in-tree mutation: testing-practices, review-verifier, review-degradation, review-ui-ux.
3. T3 one severity rubric across highload, backend, security-code, architecture, clean-code, style, performance, frontend.
4. T4 stale references + missing-input fallbacks (pr-contract, security-code, performance, frontend, logic, architecture, verifier, highload, regression, degradation, ui-ux).
5. T5 retarget performance and highload to CLI/TUI hot paths and this repo's concurrency.
6. T6 pinning test + registries (mirror, versions, ceilings) + `bun test src/gdskills src/review`.
7. T7 recall bench after, compare with baseline.
8. Review round, PR, completion choice.

State × event matrix: not applicable — instruction text and JSON schemas, no UI or held state.

## Risks

- Rewording a lens changes what it finds. Mitigation: T7 bench; edits remove contradictions and add targeting, they do not delete detection checklists (highload's Flags conditions are kept as conditions, only their severity labels go).
- Schema relaxation (`sites: []`) could let an unenumerated class through. Mitigation: require a non-empty `enumeration_method` when `sites` is empty.
- Parallel edits to the same files across tasks. Mitigation: tasks are split by file; one worker per file set.

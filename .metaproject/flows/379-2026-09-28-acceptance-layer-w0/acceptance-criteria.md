# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `flow ac kinds <id>` parses a criteria file containing all four markers plus one unmarked line and reports `exec`, `invariant`, `judged`, `none` and `unclassified` with the counts and the per-criterion records defined in the specification's Data contracts [verify: exec `bun test src/flow/ac-kinds.test.ts`]
- AC2: A second `[verify: …]` marker on one line, an `exec` or `invariant` marker without a backticked command, and a bare `none` without a reason are each a parse error that names the offending criterion id and exits non-zero [verify: exec `bun test src/flow/ac-kinds-errors.test.ts`]
- AC3: Every one of the acceptance-criteria files in `.metaproject/flows/` parses without error and reports every criterion that carries no marker as `unclassified`, with zero parse failures across the corpus (written and green before any other code in this flow) [verify: exec `bun test src/flow/ac-kinds-corpus.test.ts`]
- AC4: `flow freeze` on a flow whose criteria are all `none` completes normally and prints the distribution; no code path refuses a freeze, a confirmation or a completion on the basis of a kind [verify: invariant `bun test src/flow/ac-kinds-never-gates.test.ts`]
- AC5: The text handed to `extractCriterionTokens` and `classifyNotCheckable` excludes the trailing marker, and a criterion carrying a marker produces byte-identical facts to the same criterion without one [verify: exec `bun test src/flow/check-ac.test.ts`]
- AC6: `flow ac update` re-seals the file and rewrites `acKinds` so the derived field and the sealed file never disagree; a test mutates a kind, re-updates, and asserts both the new checksum and the new record [verify: exec `bun test src/flow/ac-reseal.test.ts`]
- AC7: `governance report` shows acceptance coverage per flow, and a flow predating this package reads as fully `unclassified` rather than as zero criteria [verify: exec `bun test src/commands/governance.test.ts`]
- AC8: `requirements-package-standard.mdc` (and its bundled copy) states the per-requirement verification field, and the docpack Verify phase fails a package whose requirement omits it, naming that requirement [verify: judged]
- AC9: The format proved workable in practice: this flow's own criteria carry kinds, at least one is honestly `none`, and the journal records any line that was awkward to write [verify: none — a judgement about writing ergonomics, which no check can settle; the journal entry is the evidence and a human reads it]
- AC10: `bun run typecheck` is clean and the full `src/flow` suite passes on the branch [verify: exec `bun run typecheck && bun test src/flow`]
- AC11: `requirements-package-standard.mdc` splits the PRD success contract into release criteria and outcome criteria, states that an outcome criterion names its observation or declares `not measured — <reason>`, and the docpack Verify phase fails a package that has no outcome list while accepting one whose entries are all `not measured` [verify: judged]
- AC12: The acceptance-layer package's own PRD carries both lists, and its outcome list contains at least one entry that is honestly `not measured` with a reason [verify: exec `grep -q 'not measured —' docs/requirements/keryx-acceptance-layer/prd.md`]
- AC13: The TUI shows the distribution: the flow surface that lists a flow's acceptance criteria renders each criterion's kind, and the freeze distribution line is visible there, asserted by a rendered-row test [verify: exec `bun test src/tui/ac-kinds-surface.test.ts`]

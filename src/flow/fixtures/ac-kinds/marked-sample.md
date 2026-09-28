# Acceptance Criteria

Fixture for `src/flow/ac-kinds-corpus.test.ts`: criteria carrying markers, in the
shape flow 361 (the flow that introduced them) uses, plus one unmarked line. Every
marked line must parse to the kind it declares; the unmarked one to `unclassified`.

## Criteria

- AC1: `flow ac kinds <id>` parses a criteria file containing all four markers plus one unmarked line [verify: exec `bun test src/flow/ac-kinds.test.ts`]
- AC2: A second `[verify: …]` marker on one line, an `exec` marker without a backticked command, and a bare `none` without a reason are each a parse error [verify: exec `bun test src/flow/ac-kinds-errors.test.ts`]
- AC3: `flow freeze` never refuses on a kind; no code path gates a freeze, a confirmation or a completion [verify: invariant `bun test src/flow/ac-kinds-never-gates.test.ts`]
- AC4: The standard states the per-requirement verification field, and the Verify phase fails a package whose requirement omits it [verify: judged]
- AC5: The format proved workable in practice [verify: none — a judgement about writing ergonomics, which no check can settle]
- AC6: This criterion is unmarked and reads as unclassified, like every criterion frozen before the marker existed.
- AC7: A shell command with a bracket in it still parses as the last thing on the line [verify: exec `grep -q '[a-z]' docs/requirements/keryx-acceptance-layer/prd.md`]

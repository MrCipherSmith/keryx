# Review Report — MrCipherSmith/keryx#499, round 2

## Verdict: APPROVE_WITH_SUGGESTIONS

## Summary

Round 2 exists for two reasons, one procedural and one substantive.

The procedural one: round 1's dispositions cited no commit SHA, and the
completion gate refused them. The record of an outcome and the outcome are one
record, so `keryx review complete` refused to overwrite the citation in place
and told us to record the correction as a new round. That is this round.

The substantive one is worth more. Round 1's two findings were raised, fixed and
verified by the same person. An independent verifier was run over both fixes,
executing rather than reading — and while confirming both, it found that the fix
for R1-LOGIC-001 left the same hole one level in.

`isWasIsRow` asked whether a ROW was a was-to-is record and applied that one
answer to every occurrence on the row. A row holding a genuine pair plus an
unrelated cell instructing the reader to run a retired spelling was therefore
exempt in full. Confirmed by running it before anything was changed: occurrences
rose from 59 to 61 while undeclared stayed at 0.

This is the third instance in this PR of the defect class the repository keeps
recording — a mechanism reporting something it could not establish. It is also
the argument for independent verification stated as a fact rather than a
principle: the author's own verification of R1-LOGIC-001 ran the reviewer's
exact counterexample, saw it caught, and stopped there. The bypass needed
someone who had not decided in advance what the fix was.

## Findings

### R1-LOGIC-001, R1-LOGIC-002 — carried from round 1

Unchanged in substance; re-recorded here with commit citations. Both
independently confirmed by execution.

### R2-LOGIC-001 — a pair excused every cell sharing its row

Raised by the independent verifier. Fixed in e718d905: `isWasIsRow` becomes
`pairedCellRanges`, returning the character ranges of the cells that earned the
exemption, and the scan asks which cell each occurrence actually sits in.
`isWasIsRow` remains as a wrapper, because "is this row a was-to-is row" is
still the right question for the tests that ask it.

Mutation-proved: restoring the row-level answer fails the new test on the
assertion — an empty list where one violation is expected — and not on an import
or syntax error. The tree is unchanged at 59 seen and 0 undeclared, so no
legitimate table row depended on the wider exemption.

## Verification

Independent verifier, method `execution` on all three findings, all three
`confirmed`. Every check ran the working tree, never the installed `keryx`.

- `scripts/check-retired-cli-spellings.test.ts`: 22 pass
- gate over the tree: 2318 files, 59 retired spellings, 0 undeclared
- `tsc --noEmit`: clean

## Open, not fixed here

The linter still cannot run locally — eslint, @eslint/js and typescript-eslint
are declared in package.json and absent from node_modules. Two lint errors
reached CI in this PR as a direct result. Environment, not code, and awaiting a
decision.

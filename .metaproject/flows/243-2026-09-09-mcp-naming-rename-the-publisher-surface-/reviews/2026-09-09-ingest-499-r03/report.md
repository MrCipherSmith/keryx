# Review Report — MrCipherSmith/keryx#499, round 3

## Verdict: APPROVE

## Summary

The round that closes PR #499, run against the head that actually merged
(f0b74c26). Two findings, both fixed in the PR, both re-checked after the fix by
an independent verifier that executed rather than read, and neither reproduces.

Rounds 1 and 2 are kept as the record of how this one was arrived at. Round 1
recorded dispositions with no commit citation, which the completion gate refused
— correctly, since "fixed" with nothing to point at is a claim, not a record.
Round 2 added the citations and the independent verdicts, and was itself refused
for a better reason: it was run against e718d905, a commit on a different branch
that is not in this PR at all. A clean round against a SHA that will not merge
proves nothing about what merges.

That refusal is the interesting one. Independent verification of the round-1
fixes found a third defect — the was-to-is exemption was still answered once per
table row and applied to every cell on it, so an instruction to run a retired
spelling rode out on a neighbouring cell's legitimate exemption. That is real,
and it is fixed in e718d905. But it is not fixed at THIS PR's head, so it is not
carried here: it belongs to its own pull request with its own round. Recording it
as clean against f0b74c26 would have been false.

## Findings

### R1-LOGIC-001 — the was-to-is exemption was exploitable by shape

Fixed in d5bb7005, merged as d15052d8. Verdict `refuted` after the fix: the
counterexample is now caught.

Worth carrying forward: this fix was itself incomplete, and the residual hole was
found only because someone who had not decided in advance what the fix was went
looking. The author's own verification ran the reviewer's exact counterexample,
saw it caught, and stopped there.

### R1-LOGIC-002 — `--remove --dry-run` removed for real

Fixed in d5bb7005, merged as d15052d8. Verdict `refuted` after the fix: the file
is byte-identical after a dry run, and the guard is load-bearing under mutation.

## Verification

Independent verifier, method `execution`, both findings re-checked after the fix
and neither reproducing. Every check ran the working tree, never the installed
`keryx`, which is 0.2.84 and predates this change.

- full suite: 8389 pass, 2 fail — both pre-existing and reproduced on clean HEAD
- `tsc --noEmit`: clean
- retired-spelling gate: 2318 files, 59 retired spellings, 0 undeclared
- CI on the merged head: 18 success, 1 skipped, 0 failed

## Carried out of this round

- R2-LOGIC-001, the row-level exemption hole. Fixed in e718d905 on
  `fix/retired-spellings-row-exemption`, with its own mutation proof and its own
  pull request.
- The linter cannot run locally: eslint, @eslint/js and typescript-eslint are
  declared in package.json and absent from node_modules. Two lint errors reached
  CI in this PR as a direct result. Environment, not code, and open.

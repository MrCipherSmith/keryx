# Flow 258 review round 2

Scope: the three round-1 fix commits — `b3fe5f4f` (rules), `c601a6b0` (skills),
`9c9583d1` (floor). Branch `skills/skill-gaps` at `9c9583d1`.

STATUS: DONE_WITH_CONCERNS

Every round-1 finding closed except the moved-suppression netting, which was
closed only in appearance. Five new findings, one of them a measurement the
author published.

## Closure

Fourteen of fifteen closed by execution — the exit matrix, the narrowing
re-measured over 200 commits of `main`, the symbol citations, the eleven/three/
eight count, the prose-and-code narrowing of the disabled-test detector, the
shallow-clone message, the severity-word sweep, the pointer resolution, the
rank-2 fallback, the phase citation, the three legal answers, the table count
and the credit ledger. The netting did not close: see R2-m1.

## Findings

```json keryx:findings
[
  {"id":"R2-m1","reviewer":"round-2","severity":"minor","file":"src/review/floor.ts","line":791,"problem":"The suppression netting matches by set membership rather than by count, so one removed marker forgives unboundedly many added ones — and the docstring claims it nets for the same reason as the assertion detector, which nets by count.","impact":"Deleting one stale suppression buys the rest inside the same window, which is precisely the trade the guard exists to make visible.","suggested_fix":"Build a multiset of removed trimmed texts and decrement on each match.","evidence":"A region removing one @ts-ignore and adding three identical ones reports 0 findings; the same three with nothing removed reports 3.","confidence":"high"},
  {"id":"R2-m2","reviewer":"round-2","severity":"minor","file":"src/review/floor.ts","line":421,"problem":"The adjacency narrowing lost threshold shapes the wide reader caught, including the ordinary TypeScript spelling of a threshold constant.","impact":"A real weakening in the language this repo is written in goes unreported, and the loss is not in the NOT DETECTED list.","suggested_fix":"Skip type-keyword tokens, let a named number carry an unnamed one, or name the losses.","evidence":"All silent at 80->70: const minCoverage: number = 80; thresholds: { global: 80 }; minScores[0] = 80; and { minCoverage: 80, count: 7 } -> { 70, 4 }.","confidence":"high"},
  {"id":"R2-m3","reviewer":"round-2","severity":"minor","file":"src/review/floor.ts","line":414,"problem":"The stated measurement does not reproduce: the docstring says 24 of 25 were markdown ordered lists and 3 for the narrowed reader; re-measurement gives 22 renumbered lists or steps, of which 14 carry an N. marker, and 2.","impact":"A number in a comment that nobody can re-derive is the defect this whole program exists to remove, and the same wrong figure is in the commit message that shipped it.","suggested_fix":"Re-measure, write what you measured, and state the method precisely enough that the next person gets the same number.","evidence":"git log -n 200, per-commit git diff sha^ sha, contextLines 3: 25 whole-line, 2 narrowed.","confidence":"high"},
  {"id":"R2-m4","reviewer":"round-2","severity":"minor","file":"src/commands/review.ts","line":1660,"problem":"A value-taking flag whose value was dropped — an unquoted empty variable in CI — is answered as a confident scan of the working tree with exit 0.","impact":"From the one command whose whole contract is exit-code honesty, a misconfigured CI step reports a clean bar.","suggested_fix":"Reject a --diff/--ref whose next token is another flag or absent as a validation error.","evidence":"keryx review floor --diff --json returns outcome:\"scanned\", scanned:{files:12,…}, exit 0.","confidence":"high"},
  {"id":"R2-m5","reviewer":"round-2","severity":"minor","file":"src/review/floor.ts","line":596,"problem":"The docstring cites describe.each(cases).skip as the motivation for allowing chained segments, but the pattern admits no call between segments, so that exact shape is quiet.","impact":"The stated justification for a rule is a case the rule does not cover.","suggested_fix":"Allow an argument list after a modifier segment, or move the claim to NOT DETECTED.","evidence":"describe.each(cases).skip('x',…) and test.concurrent.failing.skip( are both silent.","confidence":"high"}
]
```

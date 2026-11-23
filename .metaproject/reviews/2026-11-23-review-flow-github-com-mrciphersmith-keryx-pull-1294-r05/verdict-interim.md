# Interim verdict: 2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r05

verdict: no open blockers or majors; 5 minor to address
source: ingested round
round 3 (source: local-package; previous 2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r02 at 33fd9647afea; delta 33fd9647afea..8e6ecf1aa3da)
run mode: attended (default)
findings: 6 (0 blocker, 0 major, 5 minor, 1 info)
verified: 0, unverified: 6
excluded: 0 refuted, 0 dismissed, 0 acted on (fixed)
premise results: 5 finding(s) carry a premise judgement (research-evidence/premises.json)
reviewers reported: review-frontend, review-layout, review-logic, review-regression, review-security-code, review-testing-practices, review-ui-ux
reviewers not reported: review-architecture, review-backend, review-clean-code, review-degradation, review-highload, review-performance, review-pr-contract, review-style
excluded: review-frontend-conventions — overlap group frontend: review-frontend reads the same lines

## Minor findings to address

- F-034 [minor] apps/desktop/src/review/ReviewBoard.tsx:245 (review-logic, unverified): Incomplete fix of F-030 (T22). On a non-replacing load an identity change empties the carried attention set, but the `seeded` ref keeps the identity seeded e...
- F-035 [minor] apps/desktop/src/review/ReviewBoard.tsx:427 (review-logic, unverified): The F-012 hint counts carried numbers absent from the shown snapshot. That is right for historical and period views (the reset moves to the open scope, where...
- F-036 [minor] apps/desktop/src/review/ReviewBoard.tsx:441 (review-frontend, unverified): The count is named with aria-label on a plain span, which has no role that accepts a name (ARIA 1.2), and under the 760px container query the visible word is...
- F-037 [minor] apps/desktop/src/review/ReviewBoard.tsx:425 (review-ui-ux, unverified): The hint button names the cause ('N waiting on you hidden by filters') but not what a click does: it overwrites the viewer's saved filters with the defaults ...
- F-039 [minor] apps/desktop/src/review/ReviewBoard.dom.test.tsx:1140 (review-testing-practices, unverified): The new tests pin the named scenarios but never build the races the seed code guards: every load double resolves at once, so the seed always lands after its ...

Interim: written before ledger, mutation pass and `complete`; it does not replace the completion gate.

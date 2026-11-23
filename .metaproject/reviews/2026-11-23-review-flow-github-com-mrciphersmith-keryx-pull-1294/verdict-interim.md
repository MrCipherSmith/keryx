# Interim verdict: 2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294

verdict: 1 open major(s): resolve or justify before merge; 7 minor to address
source: ingested round
round 1 — no previous round found (sources tried: local-package: none, git-history: none, github-block: none, github-comments: none, flow: not consulted (the package is not bound to a flow))
run mode: attended (default)
findings: 14 (0 blocker, 1 major, 7 minor, 6 info)
verified: 0, unverified: 14
excluded: 0 refuted, 0 dismissed, 0 acted on (fixed)
premise results: 8 finding(s) carry a premise judgement (research-evidence/premises.json)
reviewers reported: review-architecture, review-degradation, review-frontend, review-highload, review-layout, review-logic, review-performance, review-pr-contract, review-regression, review-security-code, review-testing-practices, review-ui-ux
reviewers not reported: none
excluded: review-frontend-conventions — overlap group frontend: review-frontend reads the same lines

## Open blockers and majors

- F-001 [major] apps/desktop/src/styles/review.css:85 (review-layout, unverified): The board toolbar changed from wrap to nowrap with every child flex:none except the spacer and the search field (min 96px). At a board width of 560px - the d...

## Minor findings to address

- F-002 [minor] apps/desktop/src/review/ReviewBoard.tsx:122 (review-frontend, unverified): clearPrivateView decides whether to return focus to the search field by testing whether focus is inside `.review-workspace [role="dialog"]`. This change port...
- F-003 [minor] apps/desktop/src/review/model.ts:89 (review-ui-ux, unverified): laneReason returns the outdated-review text before attentionReason, while reviewLane still places the card by attentionReason. An open pull request with an o...
- F-004 [minor] docs/requirements/keryx-desktop-review-v2/README.md:4 (review-logic, unverified): README, implementation-plan and the roadmap 0.29.38 entry state that nothing in the package is implemented, while this pull request implements stage 0 of tha...
- F-005 [minor] apps/desktop/src/review/ReviewBoard.tsx:403 (review-ui-ux, unverified): Below a toolbar width of 1100px the labels and the count label are hidden. Filters and Review rules both use the checklist icon, so they become identical gly...
- F-006 [minor] src/review/desk-run-store.ts:403 (review-performance, unverified): The outdated lookup runs for every requested card, including cards that already have an active or current-range run, where localBadge discards its result. Fo...
- F-007 [minor] apps/desktop/src/review/model.test.ts:77 (review-testing-practices, unverified): The assertion that an outdated badge does not change the lane compares against `pr`, which is CHANGES_REQUESTED with a requested reviewer, so both sides are ...
- F-008 [minor] apps/desktop/src/review/ReviewBoard.tsx:342 (review-architecture, unverified): attentionPrs is derivable from the snapshot and the read receipts but is stored as state and written from two places with the same predicate (the load callba...

Interim: written before ledger, mutation pass and `complete`; it does not replace the completion gate.

# Interim verdict: 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1301-r02

verdict: 1 open major(s): resolve or justify before merge; 6 minor to address
source: ingested round
round 3 (source: local-package; previous 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1301 at f43a13c3f35e; delta f43a13c3f35e..b2043b98dba9)
run mode: attended (default)
findings: 19 (0 blocker, 1 major, 6 minor, 12 info)
verified: 1, unverified: 18
excluded: 0 refuted, 1 dismissed, 0 acted on (fixed)
verifier results applied: 0 claim(s) from research-evidence/verifications.json
premise results: 8 finding(s) carry a premise judgement (research-evidence/premises.json)
reviewers reported: review-architecture, review-clean-code, review-degradation, review-frontend, review-highload, review-layout, review-logic, review-performance, review-regression, review-security-code, review-style, review-testing-practices, review-ui-ux
reviewers not reported: unknown (the package does not record who was expected)

## Open blockers and majors

- r3-regression-w1-F-001 [major] apps/desktop/src/metaproject/useMetaprojectTree.ts:187 (review-regression, verified): Regression introduced by the fix for r2-ui-ux-w2-UX-001 / r2-frontend-w2-F-001. useMetaprojectTree.read() now returns right after onStale() on a stale-snapsh...

## Minor findings to address

- r3-architecture-w1-F-001 [minor] apps/desktop/src/metaproject/useMetaprojectTree.ts:24 (review-architecture, unverified): This answers r2-architecture-w1-F-001, which suggested treating the transport's 'unavailable' as a retryable back-off. The fix puts that classification in th...
- r3-clean-code-w1-F-001 [minor] apps/desktop/src/metaproject/useMetaprojectTree.ts:131 (review-clean-code, unverified): Documentation drift introduced by the fix for r2-architecture-w1-F-001 and r2-clean-code-w1-F-002. The rewritten MAX_TREE_READS doc (:14-17) now says the per...
- r3-clean-code-w1-F-002 [minor] apps/desktop/src/metaproject/useMetaprojectTree.ts:160 (review-clean-code, unverified): SRP, two change drivers in one function. read() was about 40 lines before this delta and is 56 now, past the 40-line threshold. It builds the request, schedu...
- r3-clean-code-w2-F-001 [minor] apps/desktop/src/metaproject/useMetaprojectTree.ts:37 (review-clean-code, unverified): Documentation drift in a symbol the delta changed. The new stale-snapshot branch in read() returns after onStale(). Its comment says: 'The row stays loading;...
- r3-logic-w5-F-002 [minor] apps/desktop/src/metaproject/MetaprojectTree.tsx:157 (review-logic, unverified): The hand-off anchors to the row just before the focused one. For a focused more:P row whose parent's last entry C is an expanded folder still loading, that a...
- r3-testing-practices-w2-F1 [minor] apps/desktop/src/metaproject/useMetaprojectTree.ts:164 (review-testing-practices, unverified): tdd-workflow.mdc Rule 3 (new branch with no test). The permit retry added in this round has two snapshot-generation guards: `|| !current()` before the wait a...

Interim: written before ledger, mutation pass and `complete`; it does not replace the completion gate.

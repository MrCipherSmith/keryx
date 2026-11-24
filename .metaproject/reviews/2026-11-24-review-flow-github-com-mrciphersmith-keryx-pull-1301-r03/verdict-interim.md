# Interim verdict: 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1301-r03

verdict: no open blockers or majors; 7 minor to address
source: ingested round
round 4 (source: local-package; previous 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1301-r02 at b2043b98dba9; delta b2043b98dba9..3ad918b66a99)
run mode: attended (default)
findings: 14 (0 blocker, 0 major, 7 minor, 7 info)
verified: 0, unverified: 14
excluded: 0 refuted, 1 dismissed, 0 acted on (fixed)
premise results: 8 finding(s) carry a premise judgement (research-evidence/premises.json)
reviewers reported: review-architecture, review-clean-code, review-degradation, review-frontend, review-highload, review-layout, review-logic, review-performance, review-pr-contract, review-regression, review-security-code, review-style, review-testing-practices, review-ui-ux
reviewers not reported: none
excluded: review-frontend-conventions — overlap group frontend: review-frontend reads the same lines

## Minor findings to address

- r4-clean-code-w2-F-001 [minor] apps/desktop/src/metaproject/MetaprojectTree.tsx:105 (review-clean-code, unverified): Documentation drift in a symbol this delta changed. The fix for r3-logic-w5-F-002 replaced the hand-off rule. A status row now anchors to its own parent: a L...
- r4-frontend-w2-F-001 [minor] apps/desktop/src/metaproject/useMetaprojectTree.ts:114 (review-frontend, unverified): A stale-snapshot read is parked as status 'stale' (or more: {status: 'stale'}) and only a change of `reload` re-reads it (the useEffect comparing loadedCatal...
- r4-logic-w2-F-001 [minor] .metaproject/flows/518-2026-11-23-desktop-metaproject-sidebar-tree/plan.md:49 (review-logic, unverified): plan.md (Desktop UI, WAI-ARIA bullet) still says focus is never moved by data arriving. Its state x event matrix has no row for a read answered stale-snapsho...
- r4-style-w2-F-001 [minor] apps/desktop/src/metaproject/MetaprojectTree.tsx:180 (review-style, unverified): Ternary chain (a ternary inside a ternary) added by this delta. The layout effect that restores focus now picks the focus target with `const target = at < 0 ...
- r4-testing-practices-w1-F1 [minor] apps/desktop/src/metaproject/MetaprojectTree.tsx:43 (review-testing-practices, unverified): tdd-workflow.mdc Rule 3 (new branch with no test). This round adds the `stale` state and three branches that decide what a parked read looks like and whether...
- r4-testing-practices-w1-F2 [minor] apps/desktop/src/metaproject/MetaprojectTree.tsx:144 (review-testing-practices, unverified): tdd-workflow.mdc Rule 3 (new branch with no test). In the reveal effect, a step folder parked as `stale` makes the reveal wait instead of giving up. Without ...
- r4-testing-practices-w1-F3 [minor] apps/desktop/src/metaproject/useMetaprojectTree.ts:265 (review-testing-practices, unverified): Mandatory under the lens's mutation rule: this gate was added in answer to the earlier round's major (r3-regression-w1-F-001). The reload effect re-reads par...

Interim: written before ledger, mutation pass and `complete`; it does not replace the completion gate.

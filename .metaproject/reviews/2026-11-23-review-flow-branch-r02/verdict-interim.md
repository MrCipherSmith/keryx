# Interim verdict: 2026-11-23-review-flow-branch-r02

verdict: no open blockers or majors; 8 minor to address
source: ingested round
round 2 (source: local-package; previous 2026-11-23-review-flow-branch at 60cbe1c565f4; delta 60cbe1c565f4..b1538097e636)
run mode: attended (default)
findings: 12 (0 blocker, 0 major, 8 minor, 4 info)
verified: 9, unverified: 3
excluded: 0 refuted, 1 dismissed, 0 acted on (fixed)
verifier results applied: 0 claim(s) from research-evidence/verifications.json
premise results: 9 finding(s) carry a premise judgement (research-evidence/premises.json)
reviewers reported: review-architecture, review-clean-code, review-degradation, review-frontend, review-highload, review-layout, review-logic, review-performance, review-regression, review-security-code, review-style, review-testing-practices, review-ui-ux
reviewers not reported: none
excluded: review-frontend-conventions — overlap group frontend: review-frontend reads the same lines

## Minor findings to address

- F-001 [minor] apps/desktop/src/metaproject/RelationshipList.tsx:217 (review-logic, verified): Answering F-022, groupRelationships() now drops every self-loop (`if (edge.from === edge.to) continue;`), but the empty state still tests `projection.edges.l...
- F-002 [minor] apps/desktop/src/metaproject/MetaprojectView.tsx:367 (review-logic, unverified): The quiet re-read added for F-004 goes through the catalog effect. On a hidden-to-visible change the visible effect (`if (!returned || !loaded.current) retur...
- F-003 [minor] apps/desktop/src/metaproject/MetaprojectView.tsx:392 (review-degradation, verified): A failed quiet re-read on return shows the loud catalog error over a working explorer. The fix round added a quiet catalog re-read when the explorer becomes ...
- F-004 [minor] apps/desktop/src/metaproject/MetaprojectView.tsx:572 (review-style, verified): The fix for round-1 F-006 moved the node-memory fill into an effect and wrote the map write inline, while the `remember` helper declared three lines above (`...
- F-006 [minor] apps/desktop/src/metaproject/MetaprojectView.tsx:190 (review-testing-practices, verified): Five gates of placeFiltersPopover and its resize cleanup are unpinned. Mutants run in a scratch copy, suite green: R2-2 (`needed > below` only: flips above a...
- F-007 [minor] apps/desktop/src/metaproject/MetaprojectView.tsx:379 (review-testing-practices, verified): The quiet catalog path added for round-1 F-004 is pinned by one fixture (same snapshot id, graph ready then stale) and one rebuild fixture. Surviving mutants...
- F-008 [minor] apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx:974 (review-testing-practices, verified): The test asserts only `expect(writes).toBe(0)` after patching Map.prototype.set, with no positive artifact that the effect still fills the memory. Deleting t...
- F-009 [minor] apps/desktop/src/App.tsx:596 (review-testing-practices, verified): The one line that makes the fixes for round-1 F-003 and F-004 work in the app is unpinned: removing `visible={view === "metaproject"}` (R2-28) leaves every s...

Interim: written before ledger, mutation pass and `complete`; it does not replace the completion gate.

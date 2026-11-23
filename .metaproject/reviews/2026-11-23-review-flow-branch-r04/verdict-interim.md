# Interim verdict: 2026-11-23-review-flow-branch-r04

verdict: no open blockers or majors; 4 minor to address
source: ingested round
round 2 (source: local-package; previous 2026-11-23-review-flow-branch-r03 at 8e0f656fb2aa; delta 8e0f656fb2aa..744d9ef7542f)
run mode: attended (default)
findings: 9 (0 blocker, 0 major, 4 minor, 5 info)
verified: 8, unverified: 1
excluded: 0 refuted, 1 dismissed, 0 acted on (fixed)
verifier results applied: 0 claim(s) from research-evidence/verifications.json
premise results: 5 finding(s) carry a premise judgement (research-evidence/premises.json)
reviewers reported: review-architecture, review-degradation, review-frontend, review-highload, review-layout, review-logic, review-performance, review-regression, review-security-code, review-style, review-testing-practices, review-ui-ux
reviewers not reported: none
excluded: review-frontend-conventions — overlap group frontend: review-frontend reads the same lines

## Minor findings to address

- F-001 [minor] apps/desktop/src/metaproject/MetaprojectView.tsx:317 (review-testing-practices, verified): The clear a read the user starts makes at its start (the effect body, line 380) and the clear a rebuild makes at its start (rebuild(), line 677) are pinned f...
- F-002 [minor] apps/desktop/src/metaproject/MetaprojectView.tsx:392 (review-testing-practices, verified): The order of the new clear against the 'superseded read' check and the latest-read guard of the failure write are unpinned. R4-8 (the clear moved above `if (...
- F-003 [minor] .metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results/T24.result.json:84 (review-logic, verified): A cell of T24's banner table cites a test that does not exercise the cell. The cell is about a standing failed rebuild (source `rebuild`) followed by a read ...
- F-005 [minor] .metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/verification/fix-round-3.md:12 (review-style, verified): The same red run is counted differently in two records. results/T24.result.json notes: `85 pass | 1 fail` for the file restored to HEAD, with `Green with the...

Interim: written before ledger, mutation pass and `complete`; it does not replace the completion gate.

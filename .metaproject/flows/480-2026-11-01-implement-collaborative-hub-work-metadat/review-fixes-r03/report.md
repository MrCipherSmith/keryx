# R03 finding dispositions

All 30 canonical findings are addressed: three majors and 27 minors. Detailed mechanisms, named tests, evidence references, and available commit references are in [dispositions.json](dispositions.json). The independent quality gate passed with the explicit limitations in [verification](evidence/final-verification.md). Each finding has a commit reference.

The three major regressions have tests-first red/green evidence: reviewer publication in `delivery-red.md` / `delivery-green.md`, public admission in `admission-red.md` / `admission-green.md`, and shared incident support in `storage-red.md` / `storage-green.md`, preserved under [evidence](evidence/). The incident test uses legitimate two-Intent lifecycle data and confirms shared waiver queries decrease from four to two.

Mutation testing confirms focused guards as documented in worker reports. `w1-events-inflight-wake` survived: independent peer review found the branch redundant and unreachable by current callers; it is not claimed killed. Some UI model cases use defensive or partial-cache fixtures, as qualified per finding.

The layout was measured in Chromium in English and Russian: the disclosure button narrowed from 150.5px to 24px at a 392px viewport. T24 is reconciled by a current-timestamp audit attempt and evidence links; [provenance](provenance.md) distinguishes this from a historical implementation attempt. The earlier runtime-cache packaging freshness failure was addressed by the parent rebuilding assets; final local packaging passed (14 tests, one optional offline integration skipped). CI for the new push is tracked separately; historical green CI is not a claim about this head.

| Canonical ID | Disposition |
| --- | --- |
| `review-degradation-w4:DEG-W4-001` | Use the loaded summary and defer exact query until the list succeeds and the selected revision is absent; suppress stale exact errors for listed items. |
| `review-highload-w5:HL-R03-W5-001` | Batch distinct incident Attempts into one projection and deduplicate shared criterion-waiver lookups, preserving related records. |
| `review-layout-w1:LY-001` | Restrict growth to the session name and keep disclosure compact. |
| `R03-L2-001` | Reconcile T24 through the flow CLI with a current-timestamp audit attempt and links to existing remediation evidence. |
| `R03-L6-001` | Allow writable authorized humans to publish and reauthorize after Git; recovery remains operator-only. |
| `review-security-code-w5:review-security-code-w31:SEC-W31-001` | Cap public readers while retaining global request and byte limits, deadlines, route classification and body cancellation. |
| `review-style-w7:STYLE-W7-001` | Remove unused steps accumulator and assignment; retain explicit fixture return fields. |
| `review-testing-practices-w1:W1-001` | Pin foreign revision ownership and approved-only affected-set boundaries. |
| `review-testing-practices-w1:W1-002` | Pin referenced Attempt selection and reject a wrong-kind parent. |
| `review-testing-practices-w1:W1-003` | Pin cancelled membership filtering at initialization and submission. |
| `review-testing-practices-w1:W1-004` | Pin late snapshot merge and no-snapshot observation invalidation. |
| `review-testing-practices-w1:W1-005` | Pin receipt wake during a pending poll in visible and hidden states, including immediate rescheduling. |
| `review-testing-practices-w1:W1-006` | Exercise later-page selection independently in candidate and evidence forms. |
| `review-testing-practices-w1:W1-007` | Pin path confinement and package identity of prepared cache entries. |
| `review-testing-practices-w1:W1-008` | Exercise preparation CLI permission, private-cache refusal and installer failure. |
| `review-testing-practices-w1:W1-009` | Assert late event, snapshot and attention responses cannot update cache after unmount. |
| `review-testing-practices-w1:W1-010` | Assert accepted Intent state, decision ID and canonical events via real demo adapter. |
| `review-testing-practices-w1:W1-011` | Pin explicit project override on revision pages. |
| `review-testing-practices-w1:W1-012` | Pin exact-summary errors on missing deep-linked revision. |
| `review-testing-practices-w2:review-testing-practices-w5:F-002` | Gate external Git and assert shutdown waits for durable completion. |
| `review-testing-practices-w2:W2-002` | Gate two inspections and assert third is rejected. |
| `review-testing-practices-w2:W2-003` | Send malformed archive request with fresh key and assert exact error and unchanged job. |
| `review-testing-practices-w2:W2-004` | Simulate remote branch changing between observation and fetch and assert refusal without Git writes. |
| `review-testing-practices-w2:W2-005` | Assert old reservation releases and replacement stays reserved. |
| `review-testing-practices-w2:W2-006` | Retry same key while publication is gated and assert pending and one adapter call. |
| `review-testing-practices-w2:W2-007` | Reject each mismatched native binding while preserving reservations. |
| `review-testing-practices-w2:W2-008` | Populate over fifty completed jobs and retain older active job. |
| `review-testing-practices-w2:W2-009` | Assert exact transition versions and stale CAS refusal. |
| `review-testing-practices-w2:W2-010` | Send oversized authenticated machine stream to real remote parser and assert cancellation and no mutation. |
| `review-testing-practices-w2:W2-011` | Exercise multi-hop lineage and session isolation. |

## Verification scope

Root lint, root and scripts typechecks, embedded-asset freshness, 555 backend tests and 217 Vitest web tests passed. Packaging/cache checks: 14 pass, one offline-cache integration skipped locally. The changed-test runner additionally passed 254 tests (overlaps the preceding suites). Madge was unavailable. Independent focused logic/security review found no actionable findings; this is not a formal R04 review. Production was not deployed and product outcomes were not accepted.

Admission keeps the hard global request ceiling; public requests can use at most half the slots, rounded down with a minimum of one. A configured total limit of one cannot reserve protected capacity while allowing login; tests document that boundary. Default limits reserve protected capacity.

Routing: graph_used yes (rebuilt by commit hooks); wiki_used yes (index, targeted module detail unavailable); ctx_used yes; raw_rg_used no.

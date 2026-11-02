# PR1113 round 2 repair report
Version: 1.0

All75 non-refuted major findings are fixed. The explicitly refuted `review-logic-w31:F-001` was left unchanged. Two related minor findings are verified fixed;169minor and26info items remain explicit follow-ups. The canonical input has171minor entries; the review prose says172. The273 canonical finding objects still match the initial input semantically; the original review package was not edited.

- [Per-ID commits, full regression names and evidence](dispositions.json)
- [Major findings table](findings.md)
- [Every deferred minor/info ID](follow-ups.md)
- [Owner decisions](operator-decisions.json)
- [Input/source provenance](provenance.json)
- [Independent final gate](evidence/final-verification.md)

## Behavior repaired

1. Native queue authority survives transient admission/configuration refusals. Only native terminal facts settle it; delayed edits and in-place edit/removal reconcile safely.
2. Scoped amendment commands load prior resolving Decisions. Flow/Intent aggregates include bounded indexed Evidence incident support with deduplicated Attempt loads.
3. One durable delivery service retains externally published facts across line/authority changes, exposes current jobs, supports human CAS/audited reconciliation and explicit completed-job cold archival. Archive retains exact lookup and idempotency history. Lost push replies remain uncertain until reconciled.
4. Admission accounts actual streamed body bytes and reuses nested MCP request slots. Bounded read deadlines, protected-route pre-auth, public handshake limits and recoverable WebSocket1013 overloads preserve service availability. Native reader cleanup cannot turn a completed MCP request into500.
5. Attention Evidence and public capability limits satisfy closed API/SDK/UI contracts.
6. All six Attempt contribution commands enforce the authenticated participant and human-method restriction.
7. Live UI events avoid discarded request fan-out, preserve newer records during snapshot races, wake after own partial receipts, and refresh attention/observations through retention gaps. Demo receipts now match live result scope.
8. Amendments include unapproved/cancelled manifest members for CAS, Flow-only empty affectedIntentIds is valid in every layer, cancelled required Intents do not poison summaries, draft choice values stay current, and collapsed machines retain approval actions.
9. Revisions page newest-first with stable continuation; UI/MCP can page and resolve exact selected/deep-linked revisions.
10. Managed reconciliation reads only indexed relevant lineage; normalized remote-only transactions do not parse/serialize legacy history. Legacy mutation snapshots, optimistic concurrency and rollback remain intact.
11. Startup detects rollback-writer changes and rebuilds session/legacy projections. Optional unpinned wiki history capacity does not freeze unrelated legacy writes; mandatory Work pins remain strict and immutable. Unarchived unpinned history may become unavailable outside the retained delta window; no archived pin is deleted.
12. Backups younger than14days are protected alongside newest-three and restore pointers. Terminal native queue history permits migration, unknown/corrupt old queues remain unresolved, package metadata format and actual nested CLI help work.
13. Default packaging tests perform no registry preparation. Explicit CI preparation supplies a private pinned cache, and real extracted-runtime tests verify offline install plus Hub/MCP startup. Delivery concurrency tests use barriers rather than a30ms timing assertion. A bounded scratch probe reproduced the old false failure and new passing behavior under the same80ms client-response delay; production source was unchanged.

## Verification

Verified source head: `2aadf1165ffef7ab2fb86293c6e2551c5c82c1d6`.

- Routed ESLint/TypeScript: zero findings.
- Strict full-round changed selection:392passed, zero failures; one intentional integration skip and one existing rewind TODO,394tests total.
- Full Hub:513passed,7,621assertions.
- Python adoption boundaries:29passed; migration14 and profile5 passed.
- UI:182passed; typecheck, lint and generated-asset freshness passed.
- Actual extracted, frozen, offline runtime Hub/MCP SDK proof passed on Bun1.3.14.
- Documentation/schema and shell checks passed. Unchanged UI/docs/script checks were reused explicitly on the four-path post-gate repair delta.

The independent gate first caught a bodyless legacy-queue boundary error and a real TCP MCP native-reader cleanup exception that in-process tests missed. Both were reproduced, fixed in separate commits and independently rechecked. Their failed and passing reports are preserved under evidence/.

Five previously unrun UI mutants were executed and killed;33 UI mutants were not rerun. Targeted backup count/age mutants were also killed in isolated copies. This is not a claim that all original36 surviving mutants or all blast-radius files have been independently reviewed.

## Owner handoff

PR remains a draft. No merge, release, production deployment, product acceptance or review-round completion was performed. GitHub checks on the pushed PR head are the authority for final CI status. The next review must use the round2 package as prior; the owner completes review rounds. See [next-review.md](next-review.md).

Routing audit: graph_used=yes; wiki_used=yes; ctx_used=yes; raw_rg_used=no. Shell deployment files are not indexed by gdgraph; bounded direct reads and executable tests were used for those files.

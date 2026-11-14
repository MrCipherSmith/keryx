# PR 1166 review dispositions (rounds 1 and 2)

Every blocker, major and minor finding of both rounds, mapped to the commit that fixed it. The flow gate's floor is
`minor`, so info findings are not listed. Findings already recorded as `dismissed-incorrect` by the operator
(round 1: review-architecture-w2:F-001, review-security-code-w2:F-001; round 2: review-degradation-w1:F-001) keep that
record and are not repeated.

Dispositions are written only by `review complete`, which is the operator's act. Two things to know before running:

- Round 1 is already closed. If keryx refuses to re-close it, these dispositions move to the flow-bound final round.
- Round 2 is still a draft. Its dispositions go into the same single close as the waivers: append the
  `--waive-coverage` / `--waive` flags with your own quotes to the round-2 command below.

The flow completion gate reads only rounds filed under this flow's `reviews/` folder. `acted-on` there also needs a
verifier `refuted` verdict whose evidence names the fixing commit, so the final round re-verifies each of these at the
PR head.

## Round 1: 18 acted-on
```bash
keryx review complete .metaproject/reviews/2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166 \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-architecture-w1:F-001' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): SKILL.detail.md item 7 rewritten: only the operator'\''s head waiver lifts it' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-architecture-w2:F-002' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): spawn notice names every field in SPAWN_SUBAGENT_IGNORED_FIELDS' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-architecture-w3:ARCH-1' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): research-error gate moved into evaluateCloseGates, shared by complete and publish' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-architecture-w3:ARCH-2' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): TaggedResearchError.items typed as ReadinessItemId' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-degradation-w2:F-001' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): review --help --head block no longer names the report-line escape' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-degradation-w2:F-002' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): SPAWN_SUBAGENT_IGNORED_FIELDS JSDoc moved above createSpawnSubagentTool'\''s own' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-degradation-w3:DEG-1' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): dead withoutPartialHeader removed' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-degradation-w3:DEG-2' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): complete-head-gate tests use close-gates.test-helpers' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-logic-w2:F-001' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): SKILL.detail.md item 7 rewritten for the operator-only head waiver' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-logic-w3:F-001' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): --head-reason without a relabelling --head is refused' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-logic-w3:F-002' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): review --help --head block rewritten' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-logic-w4:F-001' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): operator kept the strict behaviour; CHANGELOG states the break and repair (expanded in 86dda760a)' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-logic-w4:F-002' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): --head-reason without a relabel is refused instead of ignored' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-security-code-w3:SEC-1' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): src/review/seals.ts seals target, head override, waivers and verifications; unsealed-target hole closed in 86dda760a' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-testing-practices-w1:F-001' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): complete-head-gate.test asserts the relabel refusal' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-testing-practices-w2:TP-1' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): tests pin every research-error tag' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-testing-practices-w2:TP-2' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): verification fixture carries verdict, method and evidence; partial ones refused' \
  --finding '2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-testing-practices-w2:TP-3' --disposition acted-on --evidence 'fixed in commit c6d6f7a63 (PR 1166): publish.test covers every hostQuestionNotice source'
```

## Round 2: 19 acted-on
```bash
keryx review complete .metaproject/reviews/2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166 \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-security-code-w8:SEC-1' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): a PR-bound package without seals.target is refused; only --head with --head-reason seals it' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-degradation-w2:F-001' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): waiver on an unsealed package gets the '\''carries no target seal'\'' refusal, not a false mismatch' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-degradation-w4:F-001' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): same: unsealed target refused with the truthful message; repair in CHANGELOG' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-logic-w10:F-001' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): target check no longer keyed on the presence of manifest.seals' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-logic-w8:LOGIC-1' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): target check no longer keyed on the presence of manifest.seals' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-regression-w4:F-001' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): target check no longer keyed on the presence of manifest.seals' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-security-code-w1:SEC-R2-1' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): deleting seals no longer exempts the target check' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-security-code-w8:SEC-2' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): ingest seals the blocker/major key set (seals.heavyFindings); a lowered or deleted one still needs a verifier' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-architecture-w1:F-001' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): seals.ts header rewritten; CHANGELOG lists each pre-seal case' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-architecture-w4:ARCH-4' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): no legacy exemption keyed on manifest.seals' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-architecture-w6:F-001' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): one runsLiveCoverageGate rule shared by readiness and close-gates' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-degradation-w2:F-002' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): CHANGELOG lists every pre-seal package case and its repair' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-degradation-w2:F-003' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): AC9 carries [verify: exec `bun test src/review/seals.test.ts`]' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-degradation-w6:DEG-1' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): unreadable findings.json is an untagged integrity refusal checked first' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-logic-w4:F-001' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): cli-reference names --answered-by/--answer-text/--question-text for --head-reason/--waive/--waive-coverage' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-logic-w6:F-001' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): CHANGELOG records the seals breakage' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-style-w2:F-001' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): AC9 verify tag added' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-style-w4:F-001' --disposition acted-on --evidence 'fixed in commit 86dda760a (PR 1166): NO_VERIFICATION constant replaces the literal' \
  --finding '2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-style-w4:F-002' --disposition acted-on --evidence 'fixed in commit 818bf0da7 (PR 1166): sink and editManifest moved to close-gates.test-helpers.ts'
```


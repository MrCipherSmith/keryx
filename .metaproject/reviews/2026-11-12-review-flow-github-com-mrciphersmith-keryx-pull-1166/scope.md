# Review Scope

target: report
ref: https://github.com/MrCipherSmith/keryx/pull/1166
mode: ingest
flow: none
created_at: 2026-11-12T13:01:10.880Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

not recorded — no pre-filter scope was supplied to this package.
This is NOT `dropped 0`: nothing ran, so nothing is known.

### Refuted by the verifier

verification_mode: annotate
claims_received: 2
claims_applied: 2
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 2
refuted: 0
unverifiable: 0
unverified: 33

### Retained

findings_in: 35
findings_removed_by_verifier: 0
findings_retained: 35

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 35
findings_retained: 35
findings_truncated: 0
blockers_exempt: 19
reviewers_truncated: 0

_the findings cap ran and truncated nothing_

### Spend ceiling

not recorded — no spend ceiling was evaluated for this package.

### Concurrency cap

not recorded — no dispatch plan was supplied for this package.

## Scope B rejections

severity_floor: major
accepted: 0
rejected: 0
exempted: 0

_every scope-B finding was a regression claim inside the computed set._
scope_b_findings: 0
scope_b_exempted: 0
blast_radius_record: supplied by the caller (--blast-radius)

## Degradation evidence screen

rule: degradation-no-evidence
screened: 6
downgraded: 0

_every `major` or `blocker` from `review-degradation` carried an evidence kind._

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 35
dropped_prefilter: null — no `--scope` was supplied to this ingest. Nothing ran, so nothing is known — this is NOT `dropped 0`.
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 35

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Premise check

premise_judge: review-premise
premise_claims_received: 17
premise_claims_applied: 17
premise_claims_rejected: 0
premise_upheld: 13
premise_downgraded: 0
premise_challenged: 2
premise_owner_decision: 2
premise_held: 4

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-architecture-w2:F-001 | minor | challenged | The tier->model_class mapping is prose by plan (T9) and AC7. Should this PR make `keryx review tier` print model_class, or should that go to flow 490's 'rules in code' work? Options: dismiss — keep the prose mapping per T9/AC7 and track the coded mapping in flow 490 / uphold — make `keryx review tier` emit model_class in this PR |
| 2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-logic-w4:F-001 | minor | owner-decision | Packages closed under the old `Not verified` or first-line rules now read NOT READY in status surfaces and are refused by publish. Keep that and add a release note, or grandfather closed packages in the status surfaces only? Options: dismiss — strict everywhere per AC1, and note the break and its repair (waiver card or --partial) in the release CHANGELOG / uphold — grandfather items 4 and 7 on closed packages in readiness/status surfaces only, as plan.md:28 says; publish stays strict per AC1 |
| 2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-security-code-w2:F-001 | minor | challenged | With no recorded head the head gate already passes, so `--head` there loosens nothing; it is flow 448's recovery. Keep it quote-free, or still log a head_override{from:null}? Options: dismiss — keep flow 448's quote-free recovery for an absent recorded head / uphold — require --head-reason (or log head_override with from:null) whenever --head fills an absent head |
| 2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-security-code-w3:SEC-1 | major | owner-decision | Hand-editing package JSON (readiness_waivers, target.head, verification) can still pass the operator-only gates, as it already could at base. Fix it in this PR, or record it as a follow-up and reword the flow's Effect line? Options: uphold — bind operator decisions to a provenance record in this PR (flow 488) / dismiss for this PR — open a follow-up (flow 490 snapshot/provenance) and reword the Effect line to name hand-edited package JSON as out of scope |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

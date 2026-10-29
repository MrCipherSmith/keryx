# Review Scope

target: report
ref: origin/main
mode: ingest
flow: none
created_at: 2026-10-28T08:17:27.054Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 47
files_retained: 47
files_dropped: 0
blocks_seen: 78
blocks_retained: 78
blocks_dropped: 0
changed_lines_retained: 2310
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: annotate
claims_received: 1
claims_applied: 1
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 1
refuted: 0
unverifiable: 0
unverified: 68

### Retained

findings_in: 69
findings_removed_by_verifier: 0
findings_retained: 69

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 69
findings_retained: 69
findings_truncated: 0
blockers_exempt: 44
reviewers_truncated: 0

_the findings cap ran and truncated nothing_

### Spend ceiling

not recorded — no spend ceiling was evaluated for this package.

### Concurrency cap

not recorded — no dispatch plan was supplied for this package.

## Scope B rejections

severity_floor: major
accepted: 1
rejected: 0
exempted: 0

_every scope-B finding was a regression claim inside the computed set._
scope_b_findings: 1
scope_b_exempted: 0
blast_radius_record: supplied by the caller (--blast-radius)

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 69
dropped_prefilter: 0
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 69

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Quotes not located at the reviewed head

3 finding(s) quote code that could not be placed in their file. They are kept with no line (never relocated by similarity), flagged `quote_unlocated` in findings.json, and readiness item `quotes-located` lists them until each has a disposition or the operator waives it.

- 2026-10-28-review-flow-feat-review-degradation#F5 (review-architecture): src/review/managed.ts: the quote is ambiguous (candidate lines 1401, 2327, and the scan stopped there)
- 2026-10-28-review-flow-feat-review-degradation#RL-W2-4 (review-logic): src/review/degradation.ts: the quote is ambiguous (candidate lines 60, 86, and the scan stopped there)
- 2026-10-28-review-flow-feat-review-degradation#TP-008 (review-testing-practices): src/review/round-split.test.ts: the quote is ambiguous (candidate lines 94, 581, and the scan stopped there)

## Premise check

premise_judge: review-premise
premise_claims_received: 44
premise_claims_applied: 44
premise_claims_rejected: 0
premise_upheld: 44
premise_downgraded: 0
premise_challenged: 0
premise_owner_decision: 0
premise_held: 0

### Held for the operator (premise)

_none_

### Premise claims discarded

_none_

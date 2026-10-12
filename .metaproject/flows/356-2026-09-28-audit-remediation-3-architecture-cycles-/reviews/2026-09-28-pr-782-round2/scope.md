# Review Scope

target: report
ref: 081f092288f843c1149d182b1dd1940bb04e3695..7457ed83a6a4980594577810f53df98e2b232638
mode: ingest
flow: 356 (explicit-flow-id)
created_at: 2026-09-28T15:10:04.524Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 59
files_retained: 57
files_dropped: 2
blocks_seen: 145
blocks_retained: 145
blocks_dropped: 0
changed_lines_retained: 3795
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: filter
claims_received: 9
claims_applied: 9
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 9
unverifiable: 0
unverified: 0

### Retained

findings_in: 9
findings_removed_by_verifier: 9
findings_retained: 0

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 0
findings_retained: 0
findings_truncated: 0
blockers_exempt: 0
reviewers_truncated: 0

_the findings cap ran and truncated nothing_

### Spend ceiling

ceiling: 3 USD
spent: 0.55 USD
status: under

### Concurrency cap

not recorded — no dispatch plan was supplied for this package.

## Scope B rejections

not recorded — no blast-radius record reached this ingest, so the scope-B screen
did not run. No finding in this package was raised under scope B; had one been,
the ingest would have been refused rather than recorded unscreened.

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 9
dropped_prefilter: 0
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 9
dropped_scope_b: null — no blast-radius record reached this ingest, so the scope-B screen did not run. `rejected: 0` after a screen that ran is a different fact, and the record keeps them apart.
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
retained: 0

### by_reason

refuted:verifier-refuted: 9

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

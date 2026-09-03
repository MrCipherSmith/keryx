# Review Scope

target: report
ref: fix/tui-foreground-operation-cancellation
mode: ingest
flow: 219 (explicit-flow-id)
created_at: 2026-09-02T22:44:56.409Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 14
files_retained: 14
files_dropped: 0
blocks_seen: 93
blocks_retained: 93
blocks_dropped: 0
changed_lines_retained: 991
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: annotate
claims_received: 1
claims_applied: 1
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 0
unverifiable: 1
unverified: 0

### Retained

findings_in: 1
findings_removed_by_verifier: 0
findings_retained: 1

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 1
findings_retained: 1
findings_truncated: 0
blockers_exempt: 0
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

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 1
dropped_prefilter: 0
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
retained: 1

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

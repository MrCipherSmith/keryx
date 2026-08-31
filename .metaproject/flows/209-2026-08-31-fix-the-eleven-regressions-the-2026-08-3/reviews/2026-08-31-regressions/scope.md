# Review Scope

target: pr
ref: https://github.com/MrCipherSmith/keryx/pull/417
mode: ingest
flow: 209 (explicit-flow-id)
created_at: 2026-08-31T05:36:10.747Z
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
claims_received: 11
claims_applied: 11
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 11
unverifiable: 0
unverified: 0

### Retained

findings_in: 11
findings_removed_by_verifier: 0
findings_retained: 11

`annotate` records verdicts and removes nothing: 11 finding(s) are marked refuted and still reported.

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 20
findings_seen: 10
findings_retained: 10
findings_truncated: 0
blockers_exempt: 1
reviewers_truncated: 0

_the findings cap ran and truncated nothing_

### Spend ceiling

not recorded — no spend ceiling was evaluated for this package.

### Concurrency cap

not recorded — no dispatch plan was supplied for this package.

## Scope B rejections

severity_floor: major
accepted: 0
rejected: 1
exempted: 0

| finding | reviewer | rule | why |
|---|---|---|---|
| r209-06 | review-regression | outside-set | src/gdskills/bundled/skills is neither in the blast-radius set nor in the changed set. Scope B is bounded to the computed set; a finding outside it was not in scope for this round. |

Rejected findings are recorded, not deleted: raise them under scope A or as a separate review.
scope_b_findings: 1
scope_b_exempted: 0
blast_radius_record: supplied by the caller (--blast-radius)

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 11
dropped_prefilter: null — no `--scope` was supplied to this ingest. Nothing ran, so nothing is known — this is NOT `dropped 0`.
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 1
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
retained: 10

### by_reason

scope_b:outside-set: 1

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

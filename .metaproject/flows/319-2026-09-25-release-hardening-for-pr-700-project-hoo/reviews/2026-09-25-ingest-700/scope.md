# Review Scope

target: pr
ref: 700
mode: ingest
flow: 319 (explicit-flow-id)
created_at: 2026-09-25T11:34:13.332Z
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
unverified: 7

### Retained

findings_in: 18
findings_removed_by_verifier: 0
findings_retained: 18

`annotate` records verdicts and removes nothing: 11 finding(s) are marked refuted and still reported.

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 18
findings_retained: 11
findings_truncated: 7
blockers_exempt: 1
reviewers_truncated: 1

| reviewer | seen | retained | truncated | exempt | truncated ids |
|---|---|---|---|---|---|
| integration-review-r700 | 18 | 11 | 7 | 1 | R700-12, R700-13, R700-14, R700-15, R700-16, R700-17, R700-18 |

Truncated findings are removed from `findings.json`. The ids above are the whole of what was dropped — a truncating cap that named no ids would read as "there was nothing more".

### Spend ceiling

not recorded — no spend ceiling was evaluated for this package.

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

total: 18
dropped_prefilter: null — no `--scope` was supplied to this ingest. Nothing ran, so nothing is known — this is NOT `dropped 0`.
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: null — no blast-radius record reached this ingest, so the scope-B screen did not run. `rejected: 0` after a screen that ran is a different fact, and the record keeps them apart.
dropped_findings_cap: 7
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
retained: 11

### by_reason

findings_cap:integration-review-r700: 7

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

# Review Scope

target: pr
ref: https://github.com/MrCipherSmith/keryx/pull/415
mode: ingest
flow: 206 (explicit-flow-id)
created_at: 2026-08-30T17:48:17.954Z
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
claims_received: 6
claims_applied: 6
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 6
unverifiable: 0
unverified: 0

### Retained

findings_in: 6
findings_removed_by_verifier: 0
findings_retained: 6

`annotate` records verdicts and removes nothing: 6 finding(s) are marked refuted and still reported.

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 20
findings_seen: 6
findings_retained: 6
findings_truncated: 0
blockers_exempt: 1
reviewers_truncated: 0

_the findings cap ran and truncated nothing_

### Spend ceiling

not recorded — no spend ceiling was evaluated for this package.

### Concurrency cap

not recorded — no dispatch plan was supplied for this package.

## Scope B rejections

not recorded — no blast-radius record reached this ingest, so the scope-B screen
did not run. No finding in this package was raised under scope B; had one been,
the ingest would have been refused rather than recorded unscreened.

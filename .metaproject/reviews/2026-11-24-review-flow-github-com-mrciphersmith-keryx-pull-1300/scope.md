# Review Scope

target: pr
ref: https://github.com/MrCipherSmith/keryx/pull/1300
mode: ingest
flow: none
created_at: 2026-11-24T07:15:16.593Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 37
files_retained: 37
files_dropped: 0
blocks_seen: 226
blocks_retained: 226
blocks_dropped: 0
changed_lines_retained: 1813
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: annotate
claims_received: 3
claims_applied: 3
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 3
refuted: 0
unverifiable: 0
unverified: 30

### Retained

findings_in: 33
findings_removed_by_verifier: 0
findings_retained: 33

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 33
findings_retained: 33
findings_truncated: 0
blockers_exempt: 21
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

## Degradation evidence screen

rule: degradation-no-evidence
screened: 2
downgraded: 0

_every `major` or `blocker` from `review-degradation` carried an evidence kind._

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 33
dropped_prefilter: 0
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: null — no blast-radius record reached this ingest, so the scope-B screen did not run. `rejected: 0` after a screen that ran is a different fact, and the record keeps them apart.
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 33

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Quotes not located at the reviewed head

4 finding(s) quote code that could not be placed in their file. They are kept with no line (never relocated by similarity), flagged `quote_unlocated` in findings.json, and readiness item `quotes-located` lists them until each has a disposition or the operator waives it.

- 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1300#PC-005 (review-pr-contract): apps/desktop/src/review/ReviewBoard.tsx: the quote is absent from the file
- 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1300#PC-006 (review-pr-contract): .metaproject/flows/517-2026-11-23-desktop-review-v2-stage-1-github-slice-a/journal.md: the quote is absent from the file
- 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1300#PC-008 (review-pr-contract): docs/docs/cli-reference.md: the quote is absent from the file
- 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1300#TP-R3-004 (review-testing-practices): apps/desktop/src/review/ReviewBoard.tsx: the quote is absent from the file

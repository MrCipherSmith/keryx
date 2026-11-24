# Review Scope

target: report
ref: https://github.com/MrCipherSmith/keryx/pull/1301
mode: ingest
flow: 518 (explicit-flow-id)
created_at: 2026-11-24T07:39:36.810Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 17
files_retained: 17
files_dropped: 0
blocks_seen: 86
blocks_retained: 86
blocks_dropped: 0
changed_lines_retained: 809
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: annotate
claims_received: 0
claims_applied: 0
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 0
unverifiable: 0
unverified: 31

### Retained

findings_in: 31
findings_removed_by_verifier: 0
findings_retained: 31

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 31
findings_retained: 31
findings_truncated: 0
blockers_exempt: 12
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

total: 31
dropped_prefilter: 0
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: null — no blast-radius record reached this ingest, so the scope-B screen did not run. `rejected: 0` after a screen that ran is a different fact, and the record keeps them apart.
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 31

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Paths missing at the reviewed head

1 finding(s) cite a file that does not exist at the reviewed head. They are kept, flagged `path_missing` in findings.json; check the path before acting on them.

- 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1301#r2-pr-contract-w2-PC-001 (review-pr-contract): .metaproject/reviews/2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1301/pr-context.md

## Premise check

premise_judge: review-premise
premise_claims_received: 12
premise_claims_applied: 12
premise_claims_rejected: 0
premise_upheld: 10
premise_downgraded: 0
premise_challenged: 2
premise_owner_decision: 0
premise_held: 2

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1301#r2-highload-w1-F-001 | minor | challenged | A retired read keeps its slot because it still holds a Rust permit and a CLI child until it answers. Keep it that way, or free the slot early and accept more children in flight? Options: dismiss — keep the slot until the read settles; it counts real children and permits / uphold — free retired reads' slots early, as the finding suggests |
| 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1301#r2-style-w2-F-001 | minor | challenged | `limit(() => …)` follows p-limit's well-known idiom. Keep the names, or rename to enqueueRead / readQueue? Options: dismiss — keep `limit` (p-limit idiom) and the ref alias / uphold — rename to one state name and a verb, as suggested |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

# Review Scope

target: report
ref: https://github.com/MrCipherSmith/keryx/pull/1301
mode: ingest
flow: 518 (explicit-flow-id)
created_at: 2026-11-24T06:54:16.372Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 27
files_retained: 27
files_dropped: 0
blocks_seen: 67
blocks_retained: 67
blocks_dropped: 0
changed_lines_retained: 2993
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: annotate
claims_received: 3
claims_applied: 3
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 0
unverifiable: 3
unverified: 49

### Retained

findings_in: 52
findings_removed_by_verifier: 0
findings_retained: 52

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 52
findings_retained: 52
findings_truncated: 0
blockers_exempt: 23
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
screened: 4
downgraded: 0

_every `major` or `blocker` from `review-degradation` carried an evidence kind._

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 52
dropped_prefilter: 0
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 52

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Premise check

premise_judge: review-premise
premise_claims_received: 23
premise_claims_applied: 23
premise_claims_rejected: 0
premise_upheld: 22
premise_downgraded: 0
premise_challenged: 1
premise_owner_decision: 0
premise_held: 1

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1301#performance-w1-F-001 | minor | challenged | Reveal pages sequentially by design and latency is out of scope here. Dismiss and track it in the read-latency stage, or keep it as a finding for this PR? Options: dismiss - track in the read-latency stage / uphold - change reveal in this PR |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

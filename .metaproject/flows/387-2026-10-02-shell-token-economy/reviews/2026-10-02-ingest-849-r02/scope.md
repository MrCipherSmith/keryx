# Review Scope

target: report
ref: 849
mode: ingest
flow: 387 (explicit-flow-id)
created_at: 2026-10-02T10:25:30.157Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 84
files_retained: 84
files_dropped: 0
blocks_seen: 329
blocks_retained: 328
blocks_dropped: 1
changed_lines_retained: 16249
changed_lines_dropped: 1

| path | where | reason | why |
|---|---|---|---|
| src/harness/provider/anthropic/anthropic-provider.test.ts | lines 709-709 (1) | comment-only | comment-only: every changed line is a comment in .ts and none is a tool directive |

### Refuted by the verifier

verification_mode: annotate
claims_received: 16
claims_applied: 16
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 2
refuted: 14
unverifiable: 0
unverified: 12

### Retained

findings_in: 28
findings_removed_by_verifier: 0
findings_retained: 28

`annotate` records verdicts and removes nothing: 14 finding(s) are marked refuted and still reported.

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 40
findings_seen: 28
findings_retained: 28
findings_truncated: 0
blockers_exempt: 1
reviewers_truncated: 0

_the findings cap ran and truncated nothing_

### Spend ceiling

ceiling: 3 USD
spent: 0 USD
status: under

### Concurrency cap

cap: 3
outstanding_declared: 1
effective_wave_size: 2
waves: 1
reviewers_queued: 0
holds_across_nesting: yes (against the declared count)

## Scope B rejections

severity_floor: major
accepted: 2
rejected: 0
exempted: 0

_every scope-B finding was a regression claim inside the computed set._
scope_b_findings: 2
scope_b_exempted: 0
blast_radius_record: supplied by the caller (--blast-radius)

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 28
dropped_prefilter: 1
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
retained: 28

### by_reason

prefilter:comment-only: 1

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

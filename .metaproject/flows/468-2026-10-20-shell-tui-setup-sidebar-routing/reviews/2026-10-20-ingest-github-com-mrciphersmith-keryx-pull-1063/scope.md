# Review Scope

target: report
ref: https://github.com/MrCipherSmith/keryx/pull/1063
mode: ingest
flow: 468 (explicit-flow-id)
created_at: 2026-10-20T11:46:31.727Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 22
files_retained: 22
files_dropped: 0
blocks_seen: 63
blocks_retained: 63
blocks_dropped: 0
changed_lines_retained: 2108
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: annotate
claims_received: 1
claims_applied: 0
claims_rejected: 1
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 0
unverifiable: 0
unverified: 23

### Retained

findings_in: 23
findings_removed_by_verifier: 0
findings_retained: 23

### Verification claims discarded

| finding | reason | why |
|---|---|---|
| review-testing-practices-w2:F-004 | mutation | the claim carried canonical, reason, severity_after. A verifier can only delete: it cannot raise a severity, add a finding, or change a finding's text. |

Every discarded claim leaves its finding in place: a claim can cost a verdict, never a finding.


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 23
findings_retained: 23
findings_truncated: 0
blockers_exempt: 16
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

total: 23
dropped_prefilter: 0
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 23

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Premise check

premise_judge: review-premise
premise_claims_received: 16
premise_claims_applied: 16
premise_claims_rejected: 0
premise_upheld: 13
premise_downgraded: 0
premise_challenged: 2
premise_owner_decision: 1
premise_held: 3

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-10-20-ingest-github-com-mrciphersmith-keryx-pull-1063#C-05 | minor | challenged | With nothing detectable, each routed turn re-runs provider detection: a localhost ollama probe, and no provider fetch, because any fetched provider makes the catalog non-empty and saved. You accepted the classifier's redetect fallback as not operator-visible, and AC2 forbids serving an empty catalog as fresh. Keep this, or add a short negative marker? Options: dismiss — keep: AC2 and the T6 decision stand / uphold — add a short in-memory negative marker (or a cache-only classifier path) so repeated turns skip detection |
| 2026-10-20-ingest-github-com-mrciphersmith-keryx-pull-1063#C-07 | minor | owner-decision | In /routing, a successful load with zero providers shows 'no providers connected' on the Model tab but 'provider list unavailable' on a category, and an assignment to an auth-failed provider reads 'provider not connected'. AC4 lists only three category reasons. Keep AC4's three, or add 'no providers connected' and 'provider auth failed' for categories? Options: dismiss — keep AC4's three category reasons, as the AC4 test pins them / uphold — pass the loader state in so categories say 'no providers connected' and 'provider auth failed', matching the Model tab (changes the AC4-pinned empty-list mapping) |
| 2026-10-20-ingest-github-com-mrciphersmith-keryx-pull-1063#C-11 | minor | challenged | The hang test's 500 ms wait is the deadline AC4 names ('within the timeout'). Replacing it with `await handle.ready` alone would let a 12 s bound pass under --timeout 30000, the flow's own run command. Keep the deadline wait, or rewrite the test? Options: dismiss — keep the 500 ms deadline wait as written / uphold — await handle.ready, assert it settled within a bound well under 12 s, and add one positive assertion |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

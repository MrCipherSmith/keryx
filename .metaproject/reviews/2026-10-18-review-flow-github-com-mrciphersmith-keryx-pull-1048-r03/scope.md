# Review Scope

target: report
ref: https://github.com/MrCipherSmith/keryx/pull/1048
mode: ingest
flow: none
created_at: 2026-10-18T15:39:32.019Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 33
files_retained: 33
files_dropped: 0
blocks_seen: 75
blocks_retained: 75
blocks_dropped: 0
changed_lines_retained: 477
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: annotate
claims_received: 6
claims_applied: 6
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 6
refuted: 0
unverifiable: 0
unverified: 61

### Retained

findings_in: 67
findings_removed_by_verifier: 0
findings_retained: 67

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 60
findings_retained: 60
findings_truncated: 0
blockers_exempt: 39
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

total: 67
dropped_prefilter: 0
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 7
retained: 60

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Premise check

premise_judge: review-premise
premise_claims_received: 22
premise_claims_applied: 22
premise_claims_rejected: 0
premise_upheld: 21
premise_downgraded: 0
premise_challenged: 1
premise_owner_decision: 0
premise_held: 1

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-testing-practices-w2:F-002 | minor | challenged | The ok-guard inside expect() is the repository's common test idiom (29 files). Keep it here, or split the precondition out in this test anyway? Options: dismiss - keep the repository idiom / uphold - assert ok first in this test |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

## Duplicates merged

- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-architecture-w3:F-001 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-style-w1:F-002; reported by review-architecture, review-style; reported severities minor/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-logic-w8:F-001 kept (major, verifier-confirmed severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-clean-code-w1:F-003; reported by review-logic, review-clean-code; reported severities major/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-clean-code-w2:F-001 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-highload-w1:F-002, 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-logic-w3:F-001; reported by review-clean-code, review-highload, review-logic; reported severities minor/minor/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-clean-code-w2:F-002 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-style-w2:F-008; reported by review-clean-code, review-style; reported severities minor/info
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-clean-code-w3:F-001 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-performance-w2:F-001; reported by review-clean-code, review-performance; reported severities minor/info
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-security-code-w5:F-001 kept (major, verifier-confirmed severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r03#review-highload-w1:F-001; reported by review-security-code, review-highload; reported severities major/minor

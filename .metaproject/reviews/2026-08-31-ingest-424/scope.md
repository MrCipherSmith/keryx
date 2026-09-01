# Review Scope

target: pr
ref: 424
mode: ingest
flow: none
created_at: 2026-08-31T20:45:54.142Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 18
files_retained: 18
files_dropped: 0
blocks_seen: 92
blocks_retained: 87
blocks_dropped: 5
changed_lines_retained: 2465
changed_lines_dropped: 5

| path | where | reason | why |
|---|---|---|---|
| src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md | lines 99-99 (1) | whitespace-only | whitespace-only: trailing whitespace only (leading whitespace is significant for this file type and was compared) |
| src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md | lines 113-113 (1) | whitespace-only | whitespace-only: trailing whitespace only (leading whitespace is significant for this file type and was compared) |
| src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md | lines 796-796 (1) | whitespace-only | whitespace-only: trailing whitespace only (leading whitespace is significant for this file type and was compared) |
| src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md | lines 845-845 (1) | whitespace-only | whitespace-only: trailing whitespace only (leading whitespace is significant for this file type and was compared) |
| src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md | lines 874-874 (1) | whitespace-only | whitespace-only: trailing whitespace only (leading whitespace is significant for this file type and was compared) |

### Refuted by the verifier

verification_mode: annotate
claims_received: 0
claims_applied: 0
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 0
unverifiable: 0
unverified: 13

### Retained

findings_in: 13
findings_removed_by_verifier: 0
findings_retained: 13

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 13
findings_retained: 13
findings_truncated: 0
blockers_exempt: 11
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

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 13
dropped_prefilter: 5
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: null — no blast-radius record reached this ingest, so the scope-B screen did not run. `rejected: 0` after a screen that ran is a different fact, and the record keeps them apart.
dropped_findings_cap: 0
dismissed_by_round: 1
retained: 13

### by_reason

prefilter:whitespace-only: 5
round_dismissed:raised-and-dismissed-by-the-round: 1

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

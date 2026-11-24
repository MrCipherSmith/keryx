# Review Scope

target: pr
ref: https://github.com/MrCipherSmith/keryx/pull/1304
mode: ingest
flow: none
created_at: 2026-11-24T11:00:42.368Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 48
files_retained: 48
files_dropped: 0
blocks_seen: 193
blocks_retained: 189
blocks_dropped: 4
changed_lines_retained: 4231
changed_lines_dropped: 8

| path | where | reason | why |
|---|---|---|---|
| apps/desktop/src/review/ReviewBoard.dom.test.tsx | lines 882-882 (1) | comment-only | comment-only: every changed line is a comment in .tsx and none is a tool directive |
| apps/desktop/src/review/ReviewDetail.tsx | lines 191-191 (2) | comment-only | comment-only: every changed line is a comment in .tsx and none is a tool directive |
| apps/desktop/src/review/model.ts | lines 35-36 (3) | comment-only | comment-only: every changed line is a comment in .ts and none is a tool directive |
| apps/desktop/src/reviews/ReviewPanel.dom.test.tsx | lines 12-13 (2) | comment-only | comment-only: every changed line is a comment in .tsx and none is a tool directive |

### Refuted by the verifier

verification_mode: annotate
claims_received: 0
claims_applied: 0
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 0
unverifiable: 0
unverified: 60

### Retained

findings_in: 60
findings_removed_by_verifier: 0
findings_retained: 60

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
blockers_exempt: 48
reviewers_truncated: 0

_the findings cap ran and truncated nothing_

### Spend ceiling

not recorded — no spend ceiling was evaluated for this package.

### Concurrency cap

not recorded — no dispatch plan was supplied for this package.

## Scope B rejections

severity_floor: major
accepted: 1
rejected: 0
exempted: 0

_every scope-B finding was a regression claim inside the computed set._
scope_b_findings: 1
scope_b_exempted: 0
blast_radius_record: supplied by the caller (--blast-radius)

## Degradation evidence screen

rule: degradation-no-evidence
screened: 6
downgraded: 0

_every `major` or `blocker` from `review-degradation` carried an evidence kind._

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 60
dropped_prefilter: 4
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 60

### by_reason

prefilter:comment-only: 4

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Quotes not located at the reviewed head

2 finding(s) quote code that could not be placed in their file. They are kept with no line (never relocated by similarity), flagged `quote_unlocated` in findings.json, and readiness item `quotes-located` lists them until each has a disposition or the operator waives it.

- 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1304#F-034 (review-pr-contract): docs/requirements/keryx-desktop-review-v2/implementation-plan.md: the quote is absent from the file
- 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1304#F-035 (review-pr-contract): apps/desktop/src/review/model.test.ts: the quote is absent from the file

## Premise check

premise_judge: review-premise
premise_claims_received: 48
premise_claims_applied: 48
premise_claims_rejected: 0
premise_upheld: 45
premise_downgraded: 0
premise_challenged: 2
premise_owner_decision: 1
premise_held: 3

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1304#F-016 | minor | challenged | F-016: importing writeJson from the sibling command review-board follows a pattern the review-* commands already use (review-layers helpers in review-chunks, review-next, review-slice, review-operator). Keep it as a defect, or dismiss it as accepted project practice? The move to board-github (FA-6) is already done either way. Options: dismiss — sibling-command helper imports are accepted practice here; keep the FA-6 move as a tidy-up / uphold — record it as an architecture defect |
| 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1304#F-027 | minor | owner-decision | F-027: a CLI package imported after newer Desktop attempts gets the next round number (plan T5 keeps this as a known limitation so shown numbers never change), so the rounds timeline can show an older review as the newest round. D-R1 aimed at rounds in time order. Keep the documented limitation, or place late imports by createdAt? Options: dismiss — keep the documented limitation (round numbers never change once shown); FA-17's pinning test stays / uphold — place late imports by createdAt (join the round of the newest older attempt on that range) and align AC1, the docstring and the spec |
| 2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1304#F-036 | minor | challenged | F-036: T10 is still marked todo while the review ran, but CI on 20e4281 (including the Lint and typecheck job) is green and the T10 run is journalled. Treat this as a defect, or dismiss it as bookkeeping closed by marking T10 done? Options: dismiss — bookkeeping only; mark T10 done with the journalled run and CI as evidence / uphold — re-run T10 (suites, typecheck, lint) and record it before closing T12 |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

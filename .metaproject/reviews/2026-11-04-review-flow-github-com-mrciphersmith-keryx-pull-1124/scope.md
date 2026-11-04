# Review Scope

target: report
ref: 85fe58fad18461213e860768056d5cbc4c744019
mode: ingest
flow: none
created_at: 2026-11-04T07:27:49.723Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 35
files_retained: 34
files_dropped: 1
blocks_seen: 148
blocks_retained: 148
blocks_dropped: 0
changed_lines_retained: 1391
changed_lines_dropped: 6

| path | where | reason | why |
|---|---|---|---|
| src/hub/web-assets.generated.ts | whole file | generated | generated: filename ends with ".generated.ts" |

### Refuted by the verifier

verification_mode: annotate
claims_received: 1
claims_applied: 1
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 1
refuted: 0
unverifiable: 0
unverified: 70

### Retained

findings_in: 71
findings_removed_by_verifier: 0
findings_retained: 71

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 71
findings_retained: 71
findings_truncated: 0
blockers_exempt: 46
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
screened: 7
downgraded: 0

_every `major` or `blocker` from `review-degradation` carried an evidence kind._

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 71
dropped_prefilter: 1
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 71

### by_reason

prefilter:generated: 1

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Paths missing at the reviewed head

2 finding(s) cite a file that does not exist at the reviewed head. They are kept, flagged `path_missing` in findings.json; check the path before acting on them.

- 2026-11-04-review-flow-github-com-mrciphersmith-keryx-pull-1124#F-073 (review-pr-contract): .metaproject/reviews/2026-11-04-review-flow-github-com-mrciphersmith-keryx-pull-1124/pr-context.md
- 2026-11-04-review-flow-github-com-mrciphersmith-keryx-pull-1124#F-076 (review-pr-contract): .metaproject/reviews/2026-11-04-review-flow-github-com-mrciphersmith-keryx-pull-1124/pr-context.md

## Premise check

premise_judge: review-premise
premise_claims_received: 46
premise_claims_applied: 46
premise_claims_rejected: 0
premise_upheld: 43
premise_downgraded: 0
premise_challenged: 2
premise_owner_decision: 1
premise_held: 3

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-11-04-review-flow-github-com-mrciphersmith-keryx-pull-1124#F-009 | minor | challenged | Re-opening @layer components lower in styles.css is idiomatic CSS and the new block already names its purpose, so is appending a change's rules in their own block the pattern you want here, or must new component rules be folded into the first @layer components block next to the rules they extend? Options: dismiss — appending a second named @layer components block is fine; the comment at styles.css:632-633 is the locality the finding asks for / uphold — fold the rail and Select rules into the first @layer components block beside .sidebar, .nav-item and .hub-input |
| 2026-11-04-review-flow-github-com-mrciphersmith-keryx-pull-1124#F-042 | minor | owner-decision | After a rejected session opening, should 'Create a new session' re-fill the launch form from the rejected session, or keep the deliberately clean form and only say in the notice that the first message is still in that session's composer? Options: dismiss the re-fill — keep the clean form the comment at sessions.tsx:188 chose, and fix only the notice wording / uphold — seed machine, checkout, profile, title, Flow and the first message from the rejected session on this recovery path |
| 2026-11-04-review-flow-github-com-mrciphersmith-keryx-pull-1124#F-046 | minor | challenged | The operator panel shows machine-reported tokens raw and disables controls without a reason line throughout, so should that stay its pattern, or should the whole panel — not just the command catalogue this change touched — localise those tokens and state why a control is disabled? Options: dismiss — raw machine tokens and reasonless disabled controls are this panel's pattern; changing one option list alone would make it less consistent / uphold — treat it as a panel-wide gap and start with the command catalogue's availability token and the Invoke button's reason |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

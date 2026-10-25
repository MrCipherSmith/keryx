# Review Scope

target: report
ref: 062aa9c36484e7b7f6b8a1dd6140671330646e66
mode: ingest
flow: 464 (explicit-flow-id)
created_at: 2026-10-19T01:54:45.304Z
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
claims_received: 8
claims_applied: 8
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 8
refuted: 0
unverifiable: 0
unverified: 37

### Retained

findings_in: 45
findings_removed_by_verifier: 0
findings_retained: 45

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 45
findings_retained: 45
findings_truncated: 0
blockers_exempt: 35
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
blast_radius_record: read from blast-radius.json in this package

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 45
dropped_prefilter: null — no `--scope` was supplied to this ingest. Nothing ran, so nothing is known — this is NOT `dropped 0`.
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 45

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Premise check

premise_judge: review-premise
premise_claims_received: 34
premise_claims_applied: 34
premise_claims_rejected: 0
premise_upheld: 31
premise_downgraded: 0
premise_challenged: 1
premise_owner_decision: 2
premise_held: 3

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-10-19-review-flow-github-com-mrciphersmith-keryx-pull-1052#C-05 | major | owner-decision | The card is meant to give the operator a final yes on closing a review, but the review-orchestrator SKILL.detail.md still tells the agent it may instead run the pre-existing `keryx review complete`, which closes the round without that yes. Keep the 'or run' path as before, or make the card the only agent path? Options: dismiss — keep 'or run keryx review complete' as the pre-existing agent path (the card is an additional option) / uphold — drop the 'or run' clause, make the card the only agent path to complete, and align cli-reference, TM-04 and autonomous-review |
| 2026-10-19-review-flow-github-com-mrciphersmith-keryx-pull-1052#C-10 | minor | owner-decision | The review_complete card shows readiness and coverage waivers but not the mutation waivers recorded in operator-decisions.json. Should the card list them too? Options: uphold — add mutation waivers (and reviewer overrides) to the card / dismiss — the card shows only the waivers the completion gates act on (readiness and coverage); the evidence level line already covers the mutation pass |
| 2026-10-19-review-flow-github-com-mrciphersmith-keryx-pull-1052#C-25 | minor | challenged | operator-confirmations.ts has its own small age and clock helpers, like four other modules in the repo. Keep the module-local formatter, or share one formatter and accept the import cycle and the changed countdown display? Options: dismiss - keep the module-local formatter, as siblings do / uphold - extract one shared formatter and reuse it in both surfaces |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

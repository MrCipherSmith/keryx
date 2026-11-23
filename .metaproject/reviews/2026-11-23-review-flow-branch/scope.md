# Review Scope

target: branch
ref: branch
mode: ingest
flow: 515 (explicit-flow-id)
created_at: 2026-11-23T09:32:47.724Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 64
files_retained: 62
files_dropped: 2
blocks_seen: 175
blocks_retained: 175
blocks_dropped: 0
changed_lines_retained: 8968
changed_lines_dropped: 0

| path | where | reason | why |
|---|---|---|---|
| docs/docs/images/desktop-metaproject/graph.jpg | whole file | binary | binary: the diff carries no reviewable text for this file |
| docs/docs/images/desktop-metaproject/wiki.jpg | whole file | binary | binary: the diff carries no reviewable text for this file |

### Refuted by the verifier

verification_mode: annotate
claims_received: 29
claims_applied: 29
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 20
refuted: 2
unverifiable: 7
unverified: 0

### Retained

findings_in: 29
findings_removed_by_verifier: 0
findings_retained: 29

`annotate` records verdicts and removes nothing: 2 finding(s) are marked refuted and still reported.

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 29
findings_retained: 29
findings_truncated: 0
blockers_exempt: 22
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
screened: 2
downgraded: 0

_every `major` or `blocker` from `review-degradation` carried an evidence kind._

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 29
dropped_prefilter: 2
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 29

### by_reason

prefilter:binary: 2

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Premise check

premise_judge: review-premise
premise_claims_received: 22
premise_claims_applied: 22
premise_claims_rejected: 0
premise_upheld: 18
premise_downgraded: 0
premise_challenged: 2
premise_owner_decision: 2
premise_held: 4

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-11-23-review-flow-branch#F-002 | major | challenged | The containing-block shift does not happen in current Chromium or current WKWebView, and the CSS spec gives inline-size containers no layout containment. Dismiss it, or keep it open until older macOS WebKit is checked? Options: dismiss — the container does not trap the fixed popover; no change / uphold — keep it open and check on the oldest supported macOS WebKit (or portal the popover as a precaution) |
| 2026-11-23-review-flow-branch#F-004 | minor | owner-decision | The retained explorer shows the catalog it last read when you come back. Keep that (and say so in the guide), or re-read the catalog when the view becomes visible again? Options: dismiss — keep the retained snapshot; the snapshot-mismatch banner and Refresh catch up; note it in the guide / uphold — re-read the catalog silently when the explorer becomes visible, keeping the selection |
| 2026-11-23-review-flow-branch#F-007 | minor | owner-decision | The Relationships tab counts every row it lists (second-step included); the fact row counts only incoming and outgoing. Keep the tab count as is, or align the two? Options: dismiss — the tab counts its rows, like the Wiki and OpenSpec tabs / uphold — count only incoming + outgoing on the tab / uphold — add the second-step count to the fact row |
| 2026-11-23-review-flow-branch#F-008 | minor | challenged | You declined fixing OpenSpec Back-to-top at the first-green gate. Keep it out of this flow, or fix it now? Options: dismiss — stays out of scope as decided at the first-green gate / uphold — fix choose() in this flow |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

# Review Scope

target: report
ref: https://github.com/MrCipherSmith/keryx/pull/1166
mode: ingest
flow: none
created_at: 2026-11-13T09:33:35.146Z
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
claims_received: 9
claims_applied: 9
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 9
refuted: 0
unverifiable: 0
unverified: 25

### Retained

findings_in: 34
findings_removed_by_verifier: 0
findings_retained: 34

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 34
findings_retained: 34
findings_truncated: 0
blockers_exempt: 20
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
screened: 11
downgraded: 0

_every `major` or `blocker` from `review-degradation` carried an evidence kind._

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 34
dropped_prefilter: null — no `--scope` was supplied to this ingest. Nothing ran, so nothing is known — this is NOT `dropped 0`.
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 34

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Premise check

premise_judge: review-premise
premise_claims_received: 13
premise_claims_applied: 13
premise_claims_rejected: 0
premise_upheld: 11
premise_downgraded: 0
premise_challenged: 0
premise_owner_decision: 2
premise_held: 2

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-degradation-w1:F-001 | major | owner-decision | review-degradation-w1:F-001: pre-seal packages with real verifier results or TTY/card waivers also read NOT READY, wider than the escape-closed break you accepted. Accept the wider break and document it, or grandfather them behind an unforgeable legacy marker? Options: dismiss — keep strict per AC9 (no seal, not honoured); widen CHANGELOG.md:8 and correct seals.ts:14-16 to name every pre-seal package with a waiver or verification and its repair / uphold — honour pre-seal waivers and verifications only behind a legacy marker an agent cannot clear by editing manifest.json (for example one in the hashed round record), and test a pre-seal package with a real verification |
| 2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-security-code-w8:SEC-2 | major | owner-decision | review-security-code-w8:SEC-2: editing a finding's severity in findings.json from major to minor still passes item verifier. Seal severities in this PR (flow 488), or move it to flow 490's snapshot work? Options: uphold — seal the blocker/major set at ingest (or reconcile with the raw results) and test the severity edit in this PR / dismiss for this PR — record it under flow 490 (completion snapshot over the files the gates read) and name it as a known gap in the flow 488 journal |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

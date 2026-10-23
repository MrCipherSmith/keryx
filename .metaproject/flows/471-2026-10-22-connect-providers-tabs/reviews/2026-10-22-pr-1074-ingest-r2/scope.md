# Review Scope

target: report
ref: 6a8941b75fd90a79caff47484440faffe1e226f2
mode: ingest
flow: 471 (explicit-flow-id)
created_at: 2026-10-22T17:41:49.031Z
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
claims_received: 0
claims_applied: 0
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 0
unverifiable: 0
unverified: 27

### Retained

findings_in: 27
findings_removed_by_verifier: 0
findings_retained: 27

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 27
findings_retained: 27
findings_truncated: 0
blockers_exempt: 25
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

total: 27
dropped_prefilter: null — no `--scope` was supplied to this ingest. Nothing ran, so nothing is known — this is NOT `dropped 0`.
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: null — no blast-radius record reached this ingest, so the scope-B screen did not run. `rejected: 0` after a screen that ran is a different fact, and the record keeps them apart.
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 0
retained: 27

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Premise check

premise_judge: review-premise
premise_claims_received: 4
premise_claims_applied: 4
premise_claims_rejected: 0
premise_upheld: 0
premise_downgraded: 0
premise_challenged: 4
premise_owner_decision: 0
premise_held: 4

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-10-22-pr-1074-ingest-r2#CP-01 | minor | challenged | The guard in pickAddableProvider matches how pickModel and pickSession already self-guard their optional host capability. Keep it as is, or pass the already-checked function in and drop the guard? Options: dismiss - keep the self-guard, as the sibling pickers do / uphold - pass listAddableProviders in and remove the guard |
| 2026-10-22-pr-1074-ingest-r2#CP-02 | minor | challenged | The Add provider tests repeat the same press sequence inline, as the file's earlier tests do. Keep it, or add a pressAddProvider helper? Options: dismiss - keep the inline sequence, as the file's earlier tests and DAMP practice do / uphold - add a helper to drive /connect to the Test / Connect step |
| 2026-10-22-pr-1074-ingest-r2#CP-03 | minor | challenged | pickAddableProvider repeats the refused / not-answered handling that pickModel, pickProvider and pickSession already use. Keep the shared shape, or extract a helper for all pickers? Options: dismiss - keep the shape every picker uses / uphold - extract a helper for the refused / not-answered pair |
| 2026-10-22-pr-1074-ingest-r2#CP-04 | minor | challenged | pickProvidersTabbedStep is one ~400-line closure, as the modal steps it replaced were. Keep the established step shape, or split this one now? Options: dismiss - keep the step shape used by the other modal steps; refactor all of them separately / uphold - split this step into row builders and a key handler now |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

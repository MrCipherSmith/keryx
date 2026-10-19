# Review Scope

target: report
ref: https://github.com/MrCipherSmith/keryx/pull/1048
mode: ingest
flow: none
created_at: 2026-10-18T14:21:23.844Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 62
files_retained: 62
files_dropped: 0
blocks_seen: 167
blocks_retained: 167
blocks_dropped: 0
changed_lines_retained: 4823
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: annotate
claims_received: 9
claims_applied: 9
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 9
refuted: 0
unverifiable: 0
unverified: 138

### Retained

findings_in: 147
findings_removed_by_verifier: 0
findings_retained: 147

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 133
findings_retained: 129
findings_truncated: 4
blockers_exempt: 93
reviewers_truncated: 1

| reviewer | seen | retained | truncated | exempt | truncated ids |
|---|---|---|---|---|---|
| review-style | 32 | 28 | 4 | 18 | review-style-w4:F-005, review-style-w4:F-006, review-style-w4:F-007, review-style-w5:F-004 |

Truncated findings are removed from `findings.json`. The ids above are the whole of what was dropped — a truncating cap that named no ids would read as "there was nothing more".

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

total: 147
dropped_prefilter: 0
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 0
dropped_findings_cap: 4
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
merged_duplicates: 14
retained: 129

### by_reason

findings_cap:review-style: 4

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Premise check

premise_judge: review-premise
premise_claims_received: 66
premise_claims_applied: 66
premise_claims_rejected: 0
premise_upheld: 64
premise_downgraded: 0
premise_challenged: 2
premise_owner_decision: 0
premise_held: 2

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-clean-code-w2:F-004 | minor | challenged | The size-limit test hard-codes 262145 like the existing sibling test at context-resolver.test.ts:302-303. Keep the literal, or import CONTRACT_MAX_BYTES here (and then in the sibling)? Options: dismiss - keep the literals, as the sibling test does / uphold - use CONTRACT_MAX_BYTES + 1 |
| 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-highload-w4:F-001 | minor | challenged | The project-context feed polls every 5 s without an in-flight guard, exactly like the approvals, external-diff and intake sidebars. Keep the house pattern, or add a guard and sequence check to this feed (and then to the siblings)? Options: dismiss - keep the house polling pattern, as the sibling sidebars do / uphold - add an in-flight guard and drop stale results in this feed |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

_none_

## Duplicates merged

- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-architecture-w1:F-002 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-core-boundaries-w1:F-003, 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-logic-w1:F-003; reported by review-architecture, review-core-boundaries, review-logic; reported severities minor/minor/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-logic-w3:F-001 kept (major, verifier-confirmed severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-architecture-w3:F-001; reported by review-logic, review-architecture; reported severities major/major
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-architecture-w3:F-005 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-clean-code-w3:F-006; reported by review-architecture, review-clean-code; reported severities minor/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-architecture-w3:F-009 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-logic-w3:F-004; reported by review-architecture, review-logic; reported severities minor/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-architecture-w5:F-001 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-logic-w5:F-002; reported by review-architecture, review-logic; reported severities minor/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-clean-code-w1:F-001 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-core-boundaries-w1:F-001, 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-highload-w1:F-001; reported by review-clean-code, review-core-boundaries, review-highload; reported severities minor/minor/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-security-code-w4:F-002 kept (major, verifier-confirmed severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-clean-code-w2:F-003; reported by review-security-code, review-clean-code; reported severities major/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-style-w2:F-002 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-clean-code-w2:F-005; reported by review-style, review-clean-code; reported severities minor/info
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-style-w4:F-001 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-clean-code-w4:F-003; reported by review-style, review-clean-code; reported severities minor/info
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-core-boundaries-w1:F-002 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-logic-w1:F-002; reported by review-core-boundaries, review-logic; reported severities minor/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-highload-w1:F-002 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-style-w1:F-003; reported by review-highload, review-style; reported severities minor/minor
- 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-highload-w5:F-002 kept (minor, highest reported severity); absorbed 2026-10-18-review-flow-github-com-mrciphersmith-keryx-pull-1048-r02#review-logic-w5:F-001; reported by review-highload, review-logic; reported severities minor/minor

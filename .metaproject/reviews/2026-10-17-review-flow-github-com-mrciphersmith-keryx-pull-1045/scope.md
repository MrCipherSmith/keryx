# Review Scope

target: pr
ref: https://github.com/MrCipherSmith/keryx/pull/1045
mode: ingest
flow: none
created_at: 2026-10-17T04:40:30.412Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

files_seen: 50
files_retained: 50
files_dropped: 0
blocks_seen: 185
blocks_retained: 185
blocks_dropped: 0
changed_lines_retained: 2485
changed_lines_dropped: 0

_the pre-filter ran and dropped nothing_

### Refuted by the verifier

verification_mode: annotate
claims_received: 0
claims_applied: 0
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 0
unverifiable: 0
unverified: 149

### Retained

findings_in: 149
findings_removed_by_verifier: 0
findings_retained: 149

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 131
findings_retained: 131
findings_truncated: 0
blockers_exempt: 83
reviewers_truncated: 0

_the findings cap ran and truncated nothing_

### Spend ceiling

not recorded — no spend ceiling was evaluated for this package.

### Concurrency cap

not recorded — no dispatch plan was supplied for this package.

## Scope B rejections

severity_floor: major
accepted: 3
rejected: 10
exempted: 0

| finding | reviewer | rule | why |
|---|---|---|---|
| review-regression-w1:F-001 | review-regression | non-regression-severity | severity `minor` is below the scope-B floor `major`. Under the canonical rubric `minor` states that the code behaves correctly and `info` names neither a trigger nor an outcome; neither can be a claim that the change broke an existing behaviour. |
| review-regression-w1:F-002 | review-regression | non-regression-severity | severity `minor` is below the scope-B floor `major`. Under the canonical rubric `minor` states that the code behaves correctly and `info` names neither a trigger nor an outcome; neither can be a claim that the change broke an existing behaviour. |
| review-regression-w1:F-003 | review-regression | non-regression-severity | severity `info` is below the scope-B floor `major`. Under the canonical rubric `minor` states that the code behaves correctly and `info` names neither a trigger nor an outcome; neither can be a claim that the change broke an existing behaviour. |
| review-regression-w1:F-004 | review-regression | outside-set | .metaproject/data/gdgraph/.provenance.json is neither in the blast-radius set nor in the changed set. Scope B is bounded to the computed set; a finding outside it was not in scope for this round. |
| review-regression-w2:F-001 | review-regression | non-regression-severity | severity `minor` is below the scope-B floor `major`. Under the canonical rubric `minor` states that the code behaves correctly and `info` names neither a trigger nor an outcome; neither can be a claim that the change broke an existing behaviour. |
| review-regression-w2:F-002 | review-regression | non-regression-severity | severity `minor` is below the scope-B floor `major`. Under the canonical rubric `minor` states that the code behaves correctly and `info` names neither a trigger nor an outcome; neither can be a claim that the change broke an existing behaviour. |
| review-regression-w2:F-003 | review-regression | non-regression-severity | severity `minor` is below the scope-B floor `major`. Under the canonical rubric `minor` states that the code behaves correctly and `info` names neither a trigger nor an outcome; neither can be a claim that the change broke an existing behaviour. |
| review-regression-w2:F-004 | review-regression | non-regression-severity | severity `info` is below the scope-B floor `major`. Under the canonical rubric `minor` states that the code behaves correctly and `info` names neither a trigger nor an outcome; neither can be a claim that the change broke an existing behaviour. |
| review-regression-w3:REG-W3-004 | review-regression | non-regression-severity | severity `info` is below the scope-B floor `major`. Under the canonical rubric `minor` states that the code behaves correctly and `info` names neither a trigger nor an outcome; neither can be a claim that the change broke an existing behaviour. |
| review-regression-w3:REG-W3-005 | review-regression | non-regression-severity | severity `info` is below the scope-B floor `major`. Under the canonical rubric `minor` states that the code behaves correctly and `info` names neither a trigger nor an outcome; neither can be a claim that the change broke an existing behaviour. |

Rejected findings are recorded, not deleted: raise them under scope A or as a separate review.
scope_b_findings: 13
scope_b_exempted: 0
blast_radius_record: supplied by the caller (--blast-radius)

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 149
dropped_prefilter: 0
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: 10
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
retained: 131

### by_reason

scope_b:non-regression-severity: 9
scope_b:outside-set: 1

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Quotes not located at the reviewed head

21 finding(s) quote code that could not be placed in their file. They are kept with no line (never relocated by similarity), flagged `quote_unlocated` in findings.json, and readiness item `quotes-located` lists them until each has a disposition or the operator waives it.

- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-architecture-w1:F-001 (review-architecture): .metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-architecture-w1:F-002 (review-architecture): docs/docs/cli-reference.md: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-architecture-w1:F-003 (review-architecture): src/commands/review-ledger.ts: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-architecture-w1:F-004 (review-architecture): .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-architecture-w2:F-003 (review-architecture): src/harness/tool/builtin/spawn-subagent-tool.ts: the quote is ambiguous (candidate lines 1640, 2295, and the scan stopped there)
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-architecture-w2:F-004 (review-architecture): .metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-001 (review-clean-code): .metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-002 (review-clean-code): docs/docs/cli-reference.md: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-003 (review-clean-code): src/commands/review-ledger.ts: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-004 (review-clean-code): src/commands/review-ledger.ts: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w2:F-001 (review-clean-code): src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w2:F-005 (review-clean-code): src/commands/review-plan.test.ts: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w2:F-007 (review-clean-code): src/harness/tool/builtin/spawn-subagent-tool.ts: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-logic-w2:F-002 (review-logic): src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-logic-w3:F-001 (review-logic): src/review/ledger.ts: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-style-w1:F-001 (review-style): .metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-style-w1:F-003 (review-style): src/commands/review-ledger.ts: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-style-w1:F-004 (review-style): src/commands/review-ledger.ts: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-style-w1:F-005 (review-style): src/commands/review-ledger.ts: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-style-w1:F-006 (review-style): .metaproject/data/gdgraph/.provenance.json: the quote is absent from the file
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-style-w2:S-5 (review-style): src/harness/tool/builtin/spawn-subagent-tool.ts: the quote is absent from the file

## Premise check

premise_judge: review-premise
premise_claims_received: 94
premise_claims_applied: 79
premise_claims_rejected: 15
premise_upheld: 76
premise_downgraded: 0
premise_challenged: 1
premise_owner_decision: 2
premise_held: 3

### Held for the operator (premise)

| finding | severity | verdict | question |
|---|---|---|---|
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-architecture-w2:F-004 | minor | challenged | The reviewer schema's quote text is still true (`unlocatable`), and `quote_unlocated` is an ingest-only field kept out of the reviewer contract like `path_missing`. Leave the reviewer schema as is, or mention quote_unlocated/quotes-located there anyway? Options: dismiss: leave the reviewer schema; quote_unlocated is ingest-only, as path_missing is / uphold: add quote_unlocated and the quotes-located item to the reviewer schema's quote description |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-logic-w4:F-002 | minor | owner-decision | A new shell session that continues a review opened in an earlier session is not recognised: the gate ignores the older pointer and says no package exists, then nudges toward `keryx review start`. Should the gate name an older review when this session works on it? Options: uphold — name an older pointer/package when this session's history names its package path or review id / dismiss — a new session's gate ignores reviews opened before it, as flow 460 C chose |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-regression-w3:REG-W3-002 | major | owner-decision | When a new shell session continues a review opened earlier, the gate ignores its pointer and package because they predate the session, and nudges toward opening a second package. Should the gate recognise that older review? Options: uphold — recognise an older review when this session's history names its package path or review id (not by trusting any older pointer) / dismiss — reviews opened before the session are out of the gate's scope, as flow 460 C chose |

A held finding is not an open blocker or major and is not handed to a fixer. It waits for the operator:
`keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"`.

### Premise claims discarded

| finding | reason | why |
|---|---|---|
| review-regression-w2:F-001 | unknown-finding | this round reported no such finding. A premise judge cannot introduce one. |
| review-regression-w2:F-002 | unknown-finding | this round reported no such finding. A premise judge cannot introduce one. |
| review-regression-w2:F-003 | unknown-finding | this round reported no such finding. A premise judge cannot introduce one. |
| review-regression-w1:F-001 | unknown-finding | this round reported no such finding. A premise judge cannot introduce one. |
| review-regression-w1:F-002 | unknown-finding | this round reported no such finding. A premise judge cannot introduce one. |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w2:F-001 | duplicate-claim | 3 claims name this finding. None is applied: claim order must not decide whether it is held. |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w2:F-001 | duplicate-claim | 3 claims name this finding. None is applied: claim order must not decide whether it is held. |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w2:F-001 | duplicate-claim | 3 claims name this finding. None is applied: claim order must not decide whether it is held. |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w3:CC-2 | duplicate-claim | 2 claims name this finding. None is applied: claim order must not decide whether it is held. |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w3:CC-2 | duplicate-claim | 2 claims name this finding. None is applied: claim order must not decide whether it is held. |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-001 | duplicate-claim | 2 claims name this finding. None is applied: claim order must not decide whether it is held. |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-001 | duplicate-claim | 2 claims name this finding. None is applied: claim order must not decide whether it is held. |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-002 | duplicate-claim | 3 claims name this finding. None is applied: claim order must not decide whether it is held. |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-002 | duplicate-claim | 3 claims name this finding. None is applied: claim order must not decide whether it is held. |
| 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-002 | duplicate-claim | 3 claims name this finding. None is applied: claim order must not decide whether it is held. |

Every discarded claim leaves its finding as it was: a claim can cost a verdict, never a finding.

## Duplicates merged

- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-architecture-w2:F-006 kept (info, highest reported severity); absorbed 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-highload-w2:F-004; reported by review-architecture, review-highload; reported severities info/info
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-001 kept (minor, highest reported severity); absorbed 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-core-boundaries-w1:F-001; reported by review-clean-code, review-core-boundaries; reported severities minor/minor
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w1:F-002 kept (minor, highest reported severity); absorbed 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-core-boundaries-w1:F-002, 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-style-w1:F-002; reported by review-clean-code, review-core-boundaries, review-style; reported severities minor/minor/minor
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w2:F-001 kept (minor, highest reported severity); absorbed 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-logic-w2:F-001, 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-style-w2:S-1; reported by review-clean-code, review-logic, review-style; reported severities minor/minor/minor
- 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-clean-code-w3:CC-2 kept (minor, highest reported severity); absorbed 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-logic-w4:F-009, 2026-10-17-review-flow-github-com-mrciphersmith-keryx-pull-1045#review-style-w3:F-001; reported by review-clean-code, review-logic, review-style; reported severities minor/info/minor

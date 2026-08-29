# Review precision baseline — T5/T6/T7, AC1 and AC2

Recompute with:

```
bun run baseline:review-precision           # human
bun run baseline:review-precision -- --json # machine
```

Inputs: every `manifest.json` under `.metaproject/reviews/*/` and
`.metaproject/flows/*/reviews/*/` — the two roots `src/review/managed.ts`
writes — plus the curated disposition ledger at
`.metaproject/reviews/dispositions.json`. Two runs produce byte-identical
`--json` output.

## T5 — inventory

| | |
|---|---|
| review packages | **17** |
| packages carrying at least one finding | **10** |
| findings | **83** |
| date range | 2026-07-09T19:06:32Z .. 2026-08-17T12:11:51Z |
| structured findings (contract shape) | **0** |
| pre-contract / legacy-shape findings | **83** |

Per package:

| package | mode | manifest status | created | findings | flow |
|---|---|---|---|---|---|
| 2026-07-09-branch-managed-review-feedback-loop | attach-review | closed | 2026-07-09 | 0 | 001 |
| 2026-08-01-ingest-feat-r4c-turn-submission | ingest | draft | 2026-08-01 | 15 | — |
| 2026-08-01-ingest-fix-review-pipeline-metaproject-context | ingest | draft | 2026-08-01 | 5 | — |
| 2026-08-01-review-flow-feat-r4c-turn-submission | review-flow | draft | 2026-08-01 | 0 | — |
| 2026-08-01-review-flow-fix-review-pipeline-metaproject-context | review-flow | draft | 2026-08-01 | 0 | — |
| 2026-08-02-ingest-fix-round-review-md | ingest | draft | 2026-08-02 | 10 | — |
| 2026-08-02-ingest-round2-review-md | ingest | draft | 2026-08-02 | 12 | — |
| 2026-08-03-ingest-round3-review-md | ingest | draft | 2026-08-03 | 9 | — |
| 2026-08-03-ingest-round4-review-md | ingest | draft | 2026-08-03 | 11 | — |
| 2026-08-03-ingest-round5-review-md | ingest | draft | 2026-08-03 | 7 | — |
| 2026-08-03-ingest-round6-review-md | ingest | draft | 2026-08-03 | 4 | — |
| 2026-08-11-pr-265 | attach-review | draft | 2026-08-11 | 1 | 143 |
| 2026-08-11-pr-268 | attach-review | draft | 2026-08-11 | 0 | 146 |
| 2026-08-12-ingest-273 | ingest | draft | 2026-08-12 | 9 | 151 |
| 2026-08-12-pr-265-fix-round | ingest | draft | 2026-08-11 | 0 | 143 |
| 2026-08-12-pr-273 | attach-review | closed | 2026-08-12 | 0 | 151 |
| 2026-08-17-review-flow-src-tui-tui-shell-ts | review-flow | draft | 2026-08-17 | 0 | — |

Severity across the 83: blocker 19, major 60, minor 3, info 1.

### What the inventory itself says about the corpus

- **Every one of the 83 findings is in the pre-contract shape.** All 83 carry
  exactly `{id, severity, reviewer, summary, classification, flow_relevance,
  class_scope_present}` — one distinct shape across the whole corpus. None has
  `problem`, `impact`, `evidence`, `confidence`, `file`, `line` or `class_scope`.
  The record predates `review-finding.schema.json`.
- **No finding has `class_scope`.** The plan's second-strongest evidence route —
  a commit touching the finding's `class_scope` sites — is unavailable for
  100% of the sample.
- **`reviewer` is `review-orchestrator` for all 83.** The originating reviewer
  was hardcoded to the consolidator, so nothing in the corpus supports a
  per-reviewer precision figure. That defect is fixed in current `managed.ts`
  (`defaultReviewer`), but not retroactively.
- **`classification` is `valid_followup` for 82 of 83** — assigned by
  `triage()` from the ingest MODE, not from any judgement. The field looks like
  a validity verdict and is not one.
- **`decisions.md` is a template.** Every finding gets the identical sentence
  `create follow-up task or learning proposal`. No package contains a
  per-finding decision.
- **15 of 43 distinct ids appear in more than one package** (55 of 83 findings
  carry a colliding id). `F-001` denotes six different findings. Attributing a
  commit that says "F-007" to a package is unsafe for two thirds of the corpus.
- **The same report was ingested twice with different results.**
  `2026-08-01-ingest-feat-r4c-turn-submission/report.md` and
  `2026-08-01-review-flow-feat-r4c-turn-submission/report.md` are byte-identical
  (md5 `78b98ad4…`, also `src/review/fixtures/consolidated-review-2026-08-01.md`).
  One package holds 15 findings, the other 0.
- **One report is not text.** `2026-08-01-ingest-feat-r4c-turn-submission/report.md`
  contains a NUL byte at ~offset 20666 — quoted from the defect it reports, a
  NUL in `src/lib/serve-turn-store.test.ts` that made that suite unreviewable in
  the PR diff. The report reproduces the corruption it is about.
- **15 of 17 manifests say `draft`** including the six rounds that
  `flows/133/STATE.md` describes as "all closed".

### Test and typecheck baseline (2026-08-29, branch `docs/flow-gate-scope-sync`)

```
bun test        5459 pass · 18 skip · 0 fail · 45838 expect() · 472 files · 84.85s · exit 0
tsc --noEmit    exit 0
```

## T6 — classification

| category | count |
|---|---|
| acted-on | **53** |
| dismissed-incorrect | **0** |
| dismissed-wont-fix | 0 |
| dismissed-out-of-scope | 0 |
| dismissed-deprioritised | 0 |
| unknown | **30** |

By evidence source: `report-closed-by` 28, `ledger` 25, none 30.

### Method

`review-finding.schema.json` has no disposition property, so no review package
records what became of a finding. Two sources are used and each classified
finding carries which one answered:

1. **`report-closed-by` (automatic, 28).** The report block for a finding, or a
   `# Disposition` table row in the same report, carries `closed by <sha>`, and
   the sha resolves to a commit this repository actually has. Rounds 3, 4 and 6
   of PR #220 disposition every one of their findings this way; round 5
   dispositions 4 of 7.
2. **`ledger` (curated, 25).** `.metaproject/reviews/dispositions.json`. Each
   row names the file its evidence is in and quotes it. Covers the 15 findings
   of the PR #220 consolidated review (flow 133's description enumerates
   F-001–F-011 as the set to fix and states the disposition of F-012–F-015;
   flow 133's and flow 132's journals record a `task-done` naming each id), the
   one finding of PR #265 (the fix-round review record states "F-001 is fully
   resolved" — the only explicit per-finding disposition written by the review
   pipeline in the entire corpus), and the 9 findings of ingest-273 (a BLANKET
   flow-journal claim, "Every finding was remediated", naming no id).
3. Everything else is **`unknown` by omission**: 22 findings across PR #220
   rounds 1 and 2, 5 in the review-pipeline package, and F-037–F-039 of round 5.

Sensitivity: the 9 ingest-273 findings rest only on a blanket claim. Excluding
them gives acted-on 44, unknown 39. The precision ratio is unchanged, for the
reason below.

## T7 — the figure, and the refusal

```
precision = acted-on / (acted-on + dismissed-incorrect) = 53 / 53 = 100.0%
```

**This is not a baseline and must not be used as one.**

`dismissed-incorrect` is 0, so the denominator equals the numerator and the
ratio is 100% whatever the reviewers actually got right. It is not a
measurement of accuracy; it is a restatement of the fact that this corpus
cannot express a wrong finding. Four independent reasons, each sufficient:

1. **No field exists to record it.** The finding contract has no disposition
   property; `decisions.md` is a fixed template; `classification` is derived
   from the ingest mode.
2. **The wrong ones were filtered out before they were written down.** Round 3
   and round 5 of PR #220 each carry a section — "Where a reviewer was wrong" —
   describing findings that were refuted during the round. Neither refuted
   finding was recorded as a finding. The corpus holds the survivors of an
   unlogged triage, so measuring it measures the triage, not the reviewers.
3. **It is self-review.** The same agent produced the findings, judged them and
   fixed them, and then wrote the record of all three.
4. **Only ingested reports produced findings.** 7 of 17 packages hold zero
   findings, one of them from a report byte-identical to a package holding 15.
   The recording path is lossy in a way nobody has bounded.

The three non-accuracy dismissal categories are 0 for the same reason, and the
evidence that this is a recording artefact rather than a fact is direct. The
PR #220 consolidated review carries a section headed **"Minor and info
(abridged; full set in the reviewer results)"** — thirteen further observations
in prose, including an IDOR-when-R4d-lands and an unbounded turn retention.
None became a finding record; the "full set" it defers to is not on disk. Flow
133's description then declares the whole class out of scope: *"The minor/info
set of the review, except where a fix here closes one anyway"* and *"R4d work of
any kind: session existence and ownership checks are named in the review as an
IDOR that arrives when sessions gain state, which is not now."* Those are
textbook `dismissed-out-of-scope` dispositions, correctly reasoned — and the
corpus records none of them, because a finding had to survive both the report
author's abridgement and the markdown parser's heading rule to become a record
at all. `dismissed-out-of-scope = 0` therefore means "not written down", not
"did not happen".

### What this number cannot tell us

- Nothing about **precision**, for the four reasons above.
- Nothing about **any individual reviewer**: `reviewer` is
  `review-orchestrator` on all 83 records.
- Nothing about **the 19-reviewer fan-out or the ~440 checklist items** this
  flow exists to cut. The corpus is 10 real reviews, effectively one project
  (PR #220 and its six rounds are 68 of the 83 findings) over 39 days.
- Nothing about **severity calibration**: 79 of 83 are blocker or major, which
  is a property of what the legacy markdown parser could parse — minors are
  written as prose runs, not as headings — not of what the reviewers found.
- Nothing about **recall**. No corpus of missed defects exists.
- It cannot serve as the "before" for the pre-filter (AC3–AC5) or the verifier
  (AC6–AC11). Those change what is reported; this number cannot move in
  response, because it is pinned at 100% by construction.

### What has to be collected instead

The measurement is not achievable from history. It has to be instrumented:

1. **A disposition on the finding record.** `acted-on`,
   `dismissed-incorrect`, `dismissed-wont-fix`, `dismissed-out-of-scope`,
   `dismissed-deprioritised`, `unknown` — defaulting to `unknown` and written by
   whoever closes the fix round, with the evidence reference. Findings 2 and 3
   of the schema work (`review-finding.schema.json` +
   `managed-review-package.schema.json`) both need the property.
2. **Globally unique finding ids.** `<reviewId>#F-nnn` or a ulid. Two thirds of
   the current corpus cannot be joined to a commit because of id collision.
3. **A record of what was refuted during the round**, not only what survived it.
   Without it, precision measures the unlogged triage.
4. **Independent disposition.** A finding judged by the agent that raised it
   yields a number that means nothing. This is the same argument AC9 makes for
   the verifier, applied to the measurement.
5. **A period, and a volume.** At roughly the current rate of managed reviews,
   ~10 packages and ~83 findings in 39 days, a sample large enough to separate
   a real change from noise at the scale the plan claims (51%→93%, 94–98%
   filtering) needs **two to three months of instrumented reviews, of the order
   of 150–300 dispositioned findings**, and it must span more than one project.
   Anything sooner is a figure with a confidence interval wider than the effect.

Until then, the flow's later claims should be stated as **stage counts**
(AC11: dropped by pre-filter, refuted by the verifier, retained) — which are
observable today — and **not** as a precision improvement.

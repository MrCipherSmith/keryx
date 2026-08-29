# Flow Journal

- 2026-08-29T15:08:10.698Z - flow created
- 2026-08-29T15:08:55.558Z - task-added: T5: Baseline: inventory every review package on disk and record test/typecheck baseline
- 2026-08-29T15:08:55.651Z - task-added: T6: Classify existing findings into acted-on / dismissed / unknown; record the method
- 2026-08-29T15:08:55.745Z - task-added: T7: Reproducible baseline command; record the precision figure and sample size
- 2026-08-29T15:08:55.839Z - task-added: T8: Deterministic pre-filter in the scope-building code, not in SKILL.md
- 2026-08-29T15:08:55.931Z - task-added: T9: Test: lockfile + whitespace-only + real change; only the real change survives
- 2026-08-29T15:08:56.025Z - task-added: T10: Record every pre-filter drop with a reason in the review record
- 2026-08-29T15:08:56.117Z - task-added: T11: review-verifier skill: verdict/method/evidence, reasoning-only capped at unverifiable
- 2026-08-29T15:08:56.210Z - task-added: T12: Verifier merge is delete-only: escalations and additions discarded in code
- 2026-08-29T15:08:56.299Z - task-added: T13: Test: an attempted escalation from the verifier is discarded
- 2026-08-29T15:08:56.391Z - task-added: T14: Verifier never verifies a finding from the reviewer that raised it
- 2026-08-29T15:08:56.488Z - task-added: T15: Remove review-strict from Wave C with the degradation evidence stated in the skill
- 2026-08-29T15:08:56.578Z - task-added: T16: verification_mode off|annotate|filter, defaulting to annotate; test the default
- 2026-08-29T15:08:56.673Z - task-added: T17: Stage counts in the review record: dropped, refuted, retained
- 2026-08-29T15:08:56.763Z - task-added: T18: Verify both mirrors agree; bundled-rule guard still passes
- 2026-08-29T15:08:56.853Z - task-added: T19: Quality gate: typecheck, full suite against baseline, guards, doc-links
- 2026-08-29T15:09:01.638Z - frozen: 13 criteria; checksum recorded
- 2026-08-29T15:09:01.731Z - started

## Baseline measurement — T5, T6, T7 (AC1, AC2)

Full working: `baseline.md` in this package. Recompute with
`bun run baseline:review-precision` (`-- --json` for the machine form). Two runs
produce byte-identical output; the command exits 1 if the curated ledger and the
packages on disk disagree.

**Test/typecheck baseline**, branch `docs/flow-gate-scope-sync`, 2026-08-29:
`bun test` 5459 pass · 18 skip · **0 fail** · 45838 expect() across 472 files
(84.85s, exit 0); `tsc --noEmit` exit 0. AC13's "no new failures" is measured
against this.

**Sample.** 17 review packages, 10 of which carry findings, **83 findings**,
**2026-07-09 .. 2026-08-17** (39 days). Not independent: PR #220 and its six
fix rounds account for 68 of the 83. Every one of the 83 is in the pre-contract
record shape — no `problem`, `impact`, `evidence`, `confidence`, `file`, `line`
or `class_scope` on any of them, and `reviewer` is `review-orchestrator` on all
83. `.metaproject/data/reviews/` does not exist.

**Classification method.** No review package records what became of a finding —
`review-finding.schema.json` has no disposition property. Two sources, each
recorded per finding: (1) automatic — `closed by <sha>` in the finding's own
report block or a `# Disposition` table row, with the sha resolved against git
(28 findings); (2) curated — `.metaproject/reviews/dispositions.json`, each row
naming and quoting the file its evidence is in (25 findings, from flow 133/132
journals and descriptions, the PR #265 fix-round review record, and a blanket
flow-151 journal claim). Absent evidence is `unknown`, never valid and never a
false positive (30 findings).

**Result.** acted-on **53** · dismissed-incorrect **0** · dismissed-wont-fix 0 ·
dismissed-out-of-scope 0 · dismissed-deprioritised 0 · unknown **30**.

    precision = acted-on / (acted-on + dismissed-incorrect) = 53 / 53 = 100.0%

**This figure is refused as a baseline.** The denominator equals the numerator
because nothing in this corpus can record a finding as wrong, so the ratio is
100% regardless of what the reviewers got right. Four independent reasons: no
field exists to hold a dismissal (`decisions.md` is a fixed template and
`classification` is derived from the ingest mode, not from judgement); the
refuted findings were discarded before they were written down — rounds 3 and 5
each carry a "Where a reviewer was wrong" section describing refutations that
were never recorded as findings, so the corpus holds the survivors of an
unlogged triage; the reviews are self-review, one agent finding, judging and
fixing; and the recording path is lossy — a report byte-identical to one that
produced 15 findings produced 0 in its sibling package.

The three non-accuracy dismissal categories are 0 for the same reason, and this
is demonstrable rather than inferred: the PR #220 consolidated review carries a
section headed "Minor and info (**abridged**; full set in the reviewer
results)" — thirteen observations in prose, none recorded as findings, the
deferred "full set" not on disk — and flow 133 then declares that whole class
out of scope, naming an IDOR that "arrives when sessions gain state, which is
not now". Those are correct `dismissed-out-of-scope` judgements that the corpus
does not contain. `dismissed-out-of-scope = 0` means "not written down", not
"did not happen".

**What it cannot tell us.** Nothing about precision. Nothing about any
individual reviewer (one name on all 83 records). Nothing about the 19-reviewer
fan-out or the ~440 checklist items this flow exists to cut — the sample is
effectively one project. Nothing about severity calibration (79 of 83 are
blocker/major, an artefact of what the markdown parser could parse). Nothing
about recall. And it cannot be the "before" for AC3–AC11: it is pinned at 100%
by construction and cannot move when the pipeline changes.

**What must be collected instead.** A disposition property on the finding
record, defaulting to `unknown`, written when a fix round closes, with an
evidence reference; globally unique finding ids (two thirds of the current
corpus cannot be joined to a commit because `F-001` denotes six different
findings); a record of what was refuted *during* a round, not only what survived
it; and disposition by someone other than the agent that raised the finding.
At the observed rate — ~10 packages and ~83 findings in 39 days — a sample able
to separate a real change from noise at the scale the plan claims needs **two to
three months of instrumented reviews, of the order of 150–300 dispositioned
findings, spanning more than one project.**

Until that exists, this flow's later claims should be stated as the stage counts
AC11 already requires — dropped by pre-filter, refuted by verifier, retained —
and not as a precision improvement.
- 2026-08-29T15:23:00.869Z - ac-updated: Measurement performed first, per the ordering constraint, and it returned a reasoned refusal rather than a usable number: precision is 53/53 = 100% because nothing in the corpus can record a finding as wrong. Demonstrated, not inferred - rounds 3 and 5 carry 'Where a reviewer was wrong' sections whose refutations never became finding records, and PR 220's review abridged 13 minor observations that are absent from disk. AC1 now records that outcome and forbids citing the figure as a baseline. AC14 adds the instrumentation that would make measurement possible; AC15 constrains this flow's own claims to stage counts.
- 2026-08-29T15:23:07.199Z - task-added: T20: Instrumentation: disposition field, globally unique finding ids, record what a round refuted
- 2026-08-29T15:23:07.289Z - task-done: T1: Collect remaining context
- 2026-08-29T15:23:07.381Z - task-done: T5: Baseline: inventory every review package on disk and record test/typecheck baseline
- 2026-08-29T15:23:07.472Z - task-done: T6: Classify existing findings into acted-on / dismissed / unknown; record the method
- 2026-08-29T15:23:07.565Z - task-done: T7: Reproducible baseline command; record the precision figure and sample size

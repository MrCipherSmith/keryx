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

## T20 — instrumentation (AC14)

Working tree only; nothing committed. Files touched: `src/review/types.ts`,
`src/review/managed.ts`, `src/review/managed.test.ts`,
`src/review/round-trip.test.ts`, `src/gdskills/contracts/review-finding.schema.json`,
`src/gdskills/bundled/skills/review/review-orchestrator/reviewer-finding.schema.json`.

**1. `disposition` on the finding record.** `{state, evidence}`, `state` one of
`unknown | acted-on | dismissed-incorrect | dismissed-wont-fix |
dismissed-out-of-scope | dismissed-deprioritised` — the same six categories
`scripts/review-precision-baseline.ts` counts, pinned to it by a test, so no
bucket can exist in the measurement that nothing can be written into. An ABSENT
disposition reads as `unknown` (`findingDispositionState`), which is what keeps
the 83 pre-contract records legible; nothing is written onto a finding whose
outcome nobody recorded, because `{state: "unknown"}` on every record would imply
a decision the way `classification: valid_followup` already does on 82 of 83.

**Evidence-less disposition: REJECTED, not downgraded.** Enforced twice — in the
schema (`if state == unknown` / `else required evidence`, plus `minLength: 1`)
and in the writers. Recording it as `unknown` instead would convert a verdict
somebody actually reached into "nobody decided": a silent loss of the one signal
this field exists to capture, and the same shape as the `keryx:findings` block
silently falling through to the prose parser.

**Writer: `completeManagedReview(cwd, ref, {dispositions})`.** No new writer
invented — this is the one place the pipeline already records that a round is
finished with something. The third parameter is optional, so `keryx review
complete <ref>` is unchanged and `findings.json` stays byte-identical when no
disposition is passed. Findings are re-read and only the named ones are touched;
the package is NOT re-validated whole, because re-running the ingest gate at
close time would make the entire pre-contract corpus impossible to disposition.
Refusals: unknown or ambiguous finding, unevidenced non-`unknown` state, and
overwriting an already-recorded verdict with a different one.

**2. Globally unique ids: `global_id`, alongside `id`.** `id` stays the display
form — it is read out of markdown headings by the legacy parser, printed into
`decisions.md`/`learning.md`, quoted in journals and commit messages, and carried
by all 83 records. `global_id` is `<reviewId>#<id>`, the exact key
`review-precision-baseline.ts` already joins on. Uniqueness comes from `reviewId`
being a package directory name — no registry, recomputable from disk. Stability
comes from minting ONLY when absent: a finding handed back through
`prior_findings[].finding` keeps round N's key in round N+1. Two findings sharing
a display id in one package are now refused, because they would share a key.

**3. What a round REFUTED.** New `refuted` input on `createManagedReviewPackage`,
normalized and contract-gated exactly like reported findings and written into the
SAME `findings.json` — a separate file would be a second thing every consumer
must remember to read, and the one that forgets keeps counting zero wrong
findings. Each is stamped `dismissed-incorrect` unless it names another
`dismissed-*` state; `acted-on`/`unknown` on that channel are refused; missing
evidence is refused. `dismissed-out-of-scope` is reachable on purpose, since the
corpus's 0 there means "not written down". `decisions.md` now prints the
disposition instead of the same sentence for every finding.

**Deliberate schema asymmetry, stated loudly.** `global_id` is declared in BOTH
finding schemas, identically. `disposition` is declared ONLY in
`src/gdskills/contracts/review-finding.schema.json` and NOT in the bundled
`reviewer-finding.schema.json`: a reviewer states what is wrong and never states
what became of a finding — the exact line `classification` blurred. Both halves
are pinned by tests in `managed.test.ts`, so the asymmetry reads as a decision
rather than as drift. The top-level `if`/`then` (class_scope for blocker/major)
is untouched in both, so `review-finding-class-scope.test.ts` still holds.
Refuted findings are NOT exempted from class_scope: the finding was raised by a
reviewer that already had to enumerate the class, so the record preserves the
claim as made — and weakening the conditional here would have pushed a
disposition-shaped rule into a contract that has no dispositions.

**Gates**, branch `docs/flow-gate-scope-sync`, tree shared with the AC3–AC5 work:
`bun test` **5506 pass · 18 skip · 0 fail** across 473 files (88.84s) against the
5459/18/0 baseline — no new failures; `bun run typecheck` exit 0;
`bun run test:guards` 161 pass · 0 fail; `bun run check:doc-links` 0 broken of
1129; `bun run baseline:review-precision` still returns 17 packages / 10 with
findings / 83 findings and 53/53.

**Not done, and named rather than left implicit.** (a) The `.metaproject/`
mirrors of both schemas are now stale — `.metaproject/core/gdskills/contracts/`
and `.metaproject/skills/gdskills/review/review-orchestrator/` — and belong to
T18/AC12; regenerating them here would have collided with the concurrent scope
work. (b) `review-precision-baseline.ts` does not yet read
`finding.disposition`; until it does, an instrumented review still classifies as
`unknown`. Its curated ledger does NOT become redundant either way — the 83
legacy findings will never gain a disposition, and the ledger is the only record
of theirs. (c) `confidence` is untouched, still the string enum.

## Deterministic pre-filter — T8, T9, T10 (AC3, AC4, AC5)

New module `src/review/scope.ts`, a pure function of `(diff, config)`: no model
call, no filesystem, no network. New CLI verb `keryx review scope`. Step 3 of
`review-orchestrator/SKILL.md` no longer tells a model to collect a diff; it
tells it to call the command. Both skill mirrors updated and verified
byte-identical by `diff`; skill version 1.6.0 -> 1.7.0.

**What it drops.** Paths: lockfiles (17 exact basenames — `go.sum` in, `go.mod`
deliberately out), vendored (`node_modules/ vendor/ third_party/
bower_components/ Pods/`), generated (`dist out coverage generated
__generated__ __pycache__ .venv .next .turbo .docusaurus storybook-static
target` as whole path segments at any depth, plus suffixes `.js.map .pb.go
_pb2.py .generated.ts .g.dart .freezed.dart` and friends), snapshot
(`__snapshots__/`, `*.snap`), minified (`*.min.js|mjs|cjs|css`), and binary
files. Change blocks: whitespace-only and comment-only.

**Deliberately NOT dropped**, because a false drop hides real code while a false
retain only costs tokens: `build/` — as often hand-written build tooling as it is
output, and the one entry taken OUT of gdgraph's `IGNORE_DIRS`, which is this
repo's existing answer to the same question; `*.d.ts`; and
`package.json`/`go.mod`/`Cargo.toml`, which are the dependency *decisions* a
reviewer most wants to see next to the lockfile churn this drops.

**Deliberately NOT detected**, stated so the filter does not look complete:
`@generated` content markers (a diff does not carry file headers); comment-only
for any extension outside a fixed whitelist (36 extensions, three comment
families) — an unknown extension is always reviewed; comment-only inside a hunk
containing a template literal, a Python triple-quote or a shell heredoc, because
the marker could be inside a string; a comment carrying a tool directive
(`@ts-expect-error`, `eslint-disable`, `go:build`, `noqa`, ~40 markers) is never
comment-only, because it changes behaviour; a line join or split is never
whitespace-only (ASI, Python grammar); and for 17 whitespace-significant file
types only trailing whitespace is normalised, so re-indenting Python is a real
change while re-indenting TypeScript is not.

**Context window.** Default 20 lines each side, configurable via `--context`.
Measured here (`git diff --diff-filter=M -U$N HEAD~10 -- src/**`, 17 modified
files, scoped bytes against whole-file bytes): U=3 -> 29.4%, U=10 -> 37.1%,
U=20 -> 44.4%, U=40 -> 53.8%. 20 buys the enclosing block — the median source
file here is 157 lines, p75 297 — for 15 points over git's display default, and
the next 20 lines cost 9.4 more for much less.

**AC5.** Every drop is a row: path, granularity (whole file / line span), reason,
a human "why", and `changedLines`, so the record says how much was removed and
not merely that something was. `--append <file>` writes the retained scope AND
the drop list into the review package's `scope.md`. The counts are exhaustive:
`filesSeen = filesRetained + filesDropped` and `blocksSeen = blocksRetained +
blocksDropped`.

**Proof.** `src/review/scope.test.ts` — 26 tests, 103 assertions, all passing.
The AC4 test runs a diff containing `bun.lock`, a whitespace-only hunk in
`src/format.ts` and a real change in `src/rate.ts`, and asserts that `files ==
["src/rate.ts"]`, that neither dropped payload appears in anything dispatched,
and that both drops carry their own reason and detail.

Run over a real 400-commit diff (2,388 files, 4,575 change blocks): 24 files and
15 blocks dropped — lockfile 2, binary 4, whitespace-only 14, comment-only 1.

**Gate**, branch `docs/flow-gate-scope-sync`: `bun test` 5506 pass / 18 skip /
**0 fail** (baseline 5459/18/0; the +47 are this task's 26 and the concurrent
T20 work); `tsc --noEmit` exit 0; `bun run test:guards` 161 pass / 0 fail;
`bun run check:doc-links` 1129 links, **0 broken**.

Follow-up left undone under this task's file ownership:
`docs/docs/cli-reference.md` and `docs/docs/guides/review-with-a-record.md` do
not yet mention `keryx review scope`.
- 2026-08-29T18:48:44.576Z - task-done: T20: Instrumentation: disposition field, globally unique finding ids, record what a round refuted
- 2026-08-29T18:48:44.667Z - task-done: T8: Deterministic pre-filter in the scope-building code, not in SKILL.md
- 2026-08-29T18:48:44.757Z - task-done: T9: Test: lockfile + whitespace-only + real change; only the real change survives
- 2026-08-29T18:48:44.850Z - task-done: T10: Record every pre-filter drop with a reason in the review record

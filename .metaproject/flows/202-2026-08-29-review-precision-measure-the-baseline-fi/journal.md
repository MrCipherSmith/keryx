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

## The verifier — T11–T17 (AC6, AC7, AC8, AC9, AC10, AC11)

Working tree only; nothing committed. New: `src/review/verification.ts`,
`src/review/verification.test.ts`,
`src/gdskills/bundled/skills/review/review-verifier/SKILL.md`,
`src/gdskills/bundled/skills/review/review-orchestrator/verification-claim.schema.json`.
Changed: `src/review/types.ts`, `src/review/managed.ts`, `src/commands/review.ts`,
`src/gdskills/contracts/review-finding.schema.json`, `src/gdskills/catalog.ts`,
`src/gdskills/review-skills-class-scope.test.ts`, the orchestrator SKILL.md,
`docs/docs/cli-reference.md`, `docs/docs/guides/review-with-a-record.md`.
Deleted: `src/gdskills/bundled/skills/review/review-strict/`. Mirrored into
`.metaproject/` and verified with `diff -r`.

**AC6 — removed, not improved.** `review-strict` is gone from the bundle, from
`catalog.ts`, from `.metaproject/skills/catalog.md` and from
`.metaproject/modules/gdskills.md`; a bundled directory with no catalog entry is
never installed and a catalog entry with no directory installs a generated stub,
so both halves had to move together and a test pins both. The justification is
written into the orchestrator's Wave C section with the figures — GPT-4 on GSM8K
95.5 -> 91.5 -> 89.0 across self-correction rounds, GPT-3.5 on CommonSenseQA
75.8 -> 38.1 (Huang et al., ICLR 2024, arXiv:2310.01798), Self-Refine's +49.2 on
dialogue against +0.2 on maths (arXiv:2303.17651) — and into the verifier skill,
the finding schema, and `catalog.ts`. A test asserts the numbers are present, so
the reason cannot be deleted while the deletion stands.

**AC7 — the verdict, and what `reasoning` may conclude.**
`verification: {verdict, method, evidence}` plus a fourth optional `verifier`.
The fourth is beyond the criterion and is there because AC9 is otherwise
untraceable: the merge refuses a self-verification at write time, but a record
that does not say who verified cannot be audited for the rule afterwards — the
same defect as `reviewer` hardcoded to `review-orchestrator` on all 83 records.

**The cap is applied to `refuted` as well as `confirmed`, and that is a
deliberate extension.** AC7 requires only that reasoning never reach `confirmed`.
But `refuted` is the ONE verdict with a destructive consequence, so granting it
to the method that produces no new evidence reinstates `review-strict` with the
sign flipped — re-reading a finding and changing what happens to it. Nothing
checkable is lost: "the line this finding cites does not exist" is `site-check`,
not reasoning. `reasoning` is the residual — nothing run, nothing looked up — and
the honest thing for the residual to say is "I could not verify this." Enforced
twice: in the merge, and in the schema (`if method == reasoning` /
`then verdict const unverifiable`), because `prior_findings[].finding` `$ref`s
that schema and a rule living in one code path is matched against nothing the
moment a second path appears.

**AC8 — delete-only, structurally.** The merged record is built from the ORIGINAL
finding; the only thing taken out of a claim is the verification object. An
escalation is therefore not "rejected by a rule" — there is no code path that
could apply one, and a test asserts the merged object's key set is the original's
plus exactly `verification`. What the rejection list adds is VISIBILITY: a claim
carrying a `severity` is discarded WHOLE (verdict included) and recorded by name,
because a filter that drops input silently is how the `keryx:findings` block used
to fall through to the prose parser. The wire format helps too:
`verification-claim.schema.json` is `additionalProperties: false` over exactly
`{finding, verdict, method, evidence, verifier}` — there is no field in which a
severity could travel.

The corollary, and the reason per-claim rejection is safe here while
`recordDispositions` had to be atomic: **every rejection path retains the
finding.** A malformed, anonymous, ambiguous, self-serving or mutation-carrying
claim can cost a verdict, never a finding. One test drives all seven rejection
reasons across all three modes and asserts the finding count never drops.

Two decisions inside that: an **anonymous** claim is refused, because AC9 cannot
be checked against it; and **two claims for one finding cancel each other**
rather than first-wins, because first-wins lets claim order decide whether a
finding survives, and the safe resolution of a conflict is the one that cannot
delete.

**AC9 — never self-verify.** `claim.verifier === finding.reviewer` is refused and
the finding is retained unverified. Checkable now only because `reviewer` became
real on new findings in 0.2.70; the orchestrator skill says so explicitly, so a
pipeline that regresses that field does not silently lose the rule. The
orchestrator is also told what to do when only one reviewer ran: leave the
findings unverified, because verifying them yourself is worse than not verifying.

**AC10 — `verification_mode`, default `annotate`.** Asserted twice on purpose:
once on the constant, once on the behaviour of an unspecified mode — a default
that is declared and not wired is the decorative-guard shape. `off` REFUSES
supplied claims rather than ignoring them, because a caller that passed verdicts
and got silence would read the empty result as "nothing was refuted".

**AC11 — stage counts.** Rendered into `scope.md` on every package, whether or
not a verifier ran: a record that only counts when something happened cannot be
compared with one where nothing did. It goes in `scope.md` rather than a new
artifact because that is already where the pre-filter appends its drop list, and
a seventh required artifact would strand every package on disk against
`missingArtifacts`. `keryx review ingest --scope <scope.json>` carries the
pre-filter half through; without it that stage prints **`not recorded`**, never
`0` — "dropped nothing" and "never ran" are different facts, and collapsing them
is the same defect as `dismissed-out-of-scope: 0` meaning "not written down". The
rendered block states in its own text that these are counts and not a precision
figure (AC15), and a test pins that sentence.

### How `verification` and `disposition` compose

They answer different questions, asked by different actors, at different times.
`verification` is an OBSERVATION about whether the finding is real, made during
the round by someone other than its author, evidenced by a command. `disposition`
is a DECISION about what the project did, recorded when the round closes,
evidenced by a commit or a judgement. So `refuted` and `dismissed-incorrect` are
related but not the same: a refutation can itself be wrong (the command did not
exercise the path), and `dismissed-incorrect` is reachable with no verification at
all — which is exactly what the `refuted:` input channel from T20 already does.

One-way, and only in one place:

- `annotate` writes **no** disposition. That is the entire content of the mode.
- `filter` writes `dismissed-incorrect` for an applied `refuted` verdict only,
  through `fromVerifierRefutations`, carrying the verification evidence forward as
  the disposition's evidence so the decision is traceable to the command.
- A `confirmed` verdict is **never** `acted-on`. Verification says the finding is
  real; it says nothing about whether anyone fixed it.
- Nothing reads in the other direction: a disposition never implies a
  verification.

A `filter`-refuted finding is still written to `findings.json`. Removing it from
the reported set is not erasing it — the corpus measured 100% precisely because
refutations were discarded before they were written down.

### Where `verification` lives in the schemas, and why

**Strict contract only** (`src/gdskills/contracts/review-finding.schema.json`),
NOT the bundled `reviewer-finding.schema.json` — the same asymmetry as
`disposition`, on a sharper version of the same basis. The general rule the two
now share: `review-finding.schema.json` is the RECORD of a finding and carries
facts about it regardless of who established them; `reviewer-finding.schema.json`
is the OUTPUT SHAPE of a reviewer and carries only what a reviewer knows about
its own finding. A reviewer knows what is wrong. It does not know whether anyone
else reproduced it, and AC9 says the reviewer that raised a finding is the ONE
actor forbidden to answer that — so declaring the property in the shape reviewers
emit would put the forbidden field next to `severity` in every reviewer's output.
The verifier gets its own contract instead. Both halves pinned by tests.

`prior_findings[].finding` `$ref`s the strict schema, so a fix round sees that
round N refuted a finding — which is the point — and gets the reasoning cap
enforced on the way in.

**A finding with no `verification` is not droppable.** Absent means nobody
checked, which is true of all 83 pre-contract records and of every finding a
verifier ran out of budget before reaching. Only an applied `refuted` verdict
removes anything, only in `filter`, and a test asserts retention across all three
modes for an unverified finding.

### Non-vacuity — each mechanism neutered, failures counted

| Mechanism neutered | Result |
|---|---|
| AC8: merge takes the claim's fields; mutation check removed | **3 fail** (41 -> 38 pass) |
| AC9: self-verification guard removed | **3 fail** |
| AC7: reasoning cap removed from the merge | **3 fail** |
| AC7: `if`/`then` removed from `review-finding.schema.json` | **1 fail** |
| AC10: default flipped `annotate` -> `filter` | **4 fail** |
| AC11: stage counts dropped from `scope.md` | **5 fail** |
| AC11: `not recorded` collapsed into zeroes | **2 fail** |
| AC6: `review-strict` directory restored | **2 fail** |
| AC6: `95.5 -> 91.5 -> 89.0` removed from the orchestrator skill | **1 fail** |

Restored afterwards; 54 pass / 0 fail across the two files.

### Gates, branch `docs/flow-gate-scope-sync`

`bun test` **5552 pass · 18 skip · 0 fail** across 474 files (149.51s). The
briefed baseline was 5505/18/**1**, the one failure being
`src/sac/fwk-service.test.ts` "same-size historical receipt corruption" — that
test PASSES here, so the machine-local state it depends on has changed; either
way there are no new failures and no other test fails. The 5505+1 executed
becomes 5552 with this task's 46 new tests (41 in `verification.test.ts`, 5 in
`review-skills-class-scope.test.ts`).
`bun run typecheck` exit 0; `bun run test:guards` 161 pass · 0 fail;
`bun run check:doc-links` 1130 links, 0 broken;
`bun run baseline:review-precision` still 17 / 10 / 83 and 53/53.

### What I concluded the plan had wrong, and what is left

- **The plan's cap was under-specified.** "Capped at `unverifiable`, and it can
  never be `confirmed`" leaves reasoning able to `refute`, which is the deleting
  direction and therefore the dangerous one. Extended, with the reason recorded
  in three places.
- **`verification` needed a fourth property.** AC7 names three; without
  `verifier` on the record, AC9 is enforced and untraceable.
- **AC11 needed a "not recorded" state.** The criterion asks for counts; counts
  alone cannot distinguish a stage that dropped nothing from a stage that did not
  run, and that distinction is precisely what made the baseline unmeasurable.
- **Not done, named rather than left implicit.** (a)
  `.metaproject/keryx-dashboard.html` embeds a generated copy of the skills
  catalog and still names `review-strict`; it is a generated artifact and
  regenerating it here would produce a large diff outside this task's ownership.
  (b) `scripts/review-precision-baseline.ts` still does not read
  `finding.disposition` (carried over from T20), so a `filter`-mode refutation
  does not yet reach the measurement. (c) Nothing dispatches `review-verifier`
  automatically — the orchestrator skill instructs it, and the CLI merges it, but
  Wave C remains a model-driven step.

## Pre-filter false drops, `src/review/scope.ts` (branch `docs/flow-gate-scope-sync`)

Two proven false-drop classes plus one path-classification class, each
reproduced as a failing test before the fix. The module's own invariant is that
a false retain beats a false drop; all three were false drops.

### Reproduced first, measured

Six diffs, run through `buildReviewScope` before and after. Before: every one
produced `files_retained: 0` and a **0-byte** scoped diff — the reviewers were
handed nothing. After: all six retained, scoped diffs 71–138 bytes.

| case | before | after |
|---|---|---|
| `+  /*` above an authorization check | dropped `comment-only` | retained |
| `-   */` below live code | dropped `comment-only` | retained |
| `const marker = "*/";` in context | dropped `comment-only` | retained |
| `join(" ")` → `join("")` | dropped `whitespace-only` | retained |
| spacing edit inside a SQL literal | dropped `whitespace-only` | retained |
| re-indent inside a template literal | dropped `whitespace-only` | retained |
| `src/target/resolve.ts` and 4 more | dropped `generated` | kept |

`bun test src/review/scope.test.ts`: 29 pass / **7 fail** before → **36 pass /
0 fail** after. `bun run typecheck` exit 0.

### The three fixes

1. **Block-comment state is only trusted when both files agree on it.** A hunk
   is two files interleaved; `commentFlags` walks one sequence. That walk is
   valid only when no *changed* line carries `/*` or `*/` — which is exactly the
   edit that comments live code out. Comment-only is now refused for the whole
   hunk when a changed line carries a delimiter, and also when a delimiter sits
   next to a quote (`"*/"` in context made the pre-scan believe the hunk opened
   inside a block comment and flag the real code above it — a third false drop,
   found while checking whether the suggested fix was sufficient).
2. **Whitespace inside a string literal is content.** `\s+ → ""` is replaced by
   "collapse to one space outside complete string literals, copy literals
   through verbatim", plus a per-hunk refusal when any line leaves a quote open
   (multi-line strings, where leading whitespace is data). Collapsing alone —
   the suggested fix — would still have missed `"SELECT a FROM t"` →
   `"SELECT a  FROM t"`; preserving literals catches it.
3. **Ambiguous build-output names are anchored below a source root.** `dist`,
   `out`, `target`, `generated`, `coverage` only count as build output when no
   `src`/`lib`/`app`/`test`-shaped segment precedes them. `__pycache__`,
   `.next`, `storybook-static` and friends stay unconditional, and
   `additionalGeneratedDirectories` stays unconditional because a configured
   name is an explicit statement about the repository.

### Cost, measured rather than asserted

150 commits, 3,046 change blocks, old module vs new: **one** decision flipped —
a blank-line insertion in `src/commands/agent.test.ts` now retained, because its
160-line hunk contains comments reading `SLATE-16's` and `/new's` and the
unterminated-quote guard reads an apostrophe as an open string. That is the
documented over-match, costing one retained line in 3,046 blocks.

### Still not detected, named in the module header

Multi-line strings with no quote on their content lines (a shell heredoc body, a
Python docstring) — a spacing edit inside one is still invisible, and for
whitespace-sensitive types trailing whitespace inside such a string is still
dropped. And the source-root list is a word list: `web/out/Button.tsx` is still
dropped as build output, with no per-repository opt-out in that direction.

---

## Review remediation — the record, the actor check, and the CLI surface

A review of this flow's own work found seven defects, each proven by execution.
All seven are fixed here, each with a test that fails without the fix. Nothing is
committed; working tree only.

### BLOCKER — the pipeline's prescribed order destroyed AC5's drop record

`review-orchestrator/SKILL.md` told the orchestrator to run `keryx review scope
--ref <base> --append <package>/scope.md` at Step 3; `review ingest` runs after
Step 12 and rewrote `scope.md` unconditionally. What replaced the drop table was
not a blank — it was *"not recorded — no pre-filter scope was supplied to this
package. This is NOT `dropped 0`: nothing ran, so nothing is known."* A **false**
statement written over a true record, which is the same class of failure as the
`dismissed-out-of-scope: 0` this flow exists to end. Two aggravating facts, both
executed: `--append` was non-idempotent (three runs, three blocks), and the
supported alternative `--scope <scope.json>` carried only the eight *counts*, so
the per-drop **reason rows AC5 requires had no supported path to the record at
all**.

The design chosen, in order of precedence:

1. **`--scope` now carries the WHOLE scope document** — counts *and* `drops` —
   and `createManagedReviewPackage` renders the drop table into `scope.md`
   itself. One input, one writer, one file. A document with `counts` and no
   `drops` array is refused rather than defaulted to `[]`, because an empty drop
   list is the positive claim "the pre-filter dropped nothing" and a document
   that simply lacks the property is not making it.
2. **A `## Pre-filter scope` block already in the package is carried forward
   verbatim** when no `--scope` was passed. This is the belt-and-braces: it makes
   the ORDER the orchestrator runs things in incapable of destroying the record.
   The stage-counts section then says so explicitly instead of claiming nothing
   ran.
3. **`--append` replaces** a pre-existing block rather than appending a second
   (`upsertPreFilterScopeBlock`, in `review/managed.ts` alongside the reader).

The skill now says `--scope` is the supported route and `scope.json` is the
artifact to keep; `--append` remains supported and documented as the fallback.

Failing → passing: `ingest does not replace a recorded drop table with a claim
that nothing ran` (scope.md read back contained neither `bun.lock` nor the
lockfile reason, and did contain "no pre-filter scope was supplied"); `the
per-drop REASONS reach the record`; `--append` run three times left 3 blocks and
now leaves 1.

### MAJOR — AC9 was a formatting coincidence

`verification.ts` compared `claim.verifier === target.reviewer` — exact equality
on a free-text field a model fills in, ten lines below a check that already
`.trim()`s the same field. Measured: `"review-logic "`, `" review-logic"`,
`"Review-Logic"`, `"review-logic(sonnet)"` and `"review_logic"` all walked past
the guard, and in `filter` mode a **blocker was deleted by its own author with no
rejection row**.

Both names are now reduced by `actorKey`: lowercase, trim, strip a trailing
`(model)` annotation, fold `_`/whitespace to `-`. It deliberately
**over-matches**, and the asymmetry is the argument: every rejection path in that
module retains the finding, so a false self-verification costs a verdict while a
missed one costs the finding. `review-logician` is still a different actor —
nothing here does prefix matching. The same key now decides "anonymous", so a
verifier that is only punctuation is refused rather than treated as a distinct
actor.

### MAJOR — the instrumentation had no CLI surface

`completeManagedReview({dispositions})` and
`createManagedReviewPackage({refuted})` were reachable only from TypeScript, and
**unknown flags were accepted silently with exit 0** — so `keryx review complete
<pkg> --disposition acted-on --evidence "commit abc" --finding F-001` printed
`status: closed` and wrote nothing, with no signal to the operator at all.
Combined with `filter` being off by default, the shipped pipeline could write
**zero** dispositions.

Added: `--finding/--disposition/--evidence` on `review complete`, repeatable
(each `--finding` opens a record; a `--disposition` before any `--finding` is
refused rather than applied to everything); `--refuted <file|->` on `review
ingest`; and a per-subcommand allowlist that **refuses** an unrecognised flag
with exit 1. A close with no disposition flags now prints that every finding
still reads `unknown` — the silence was the failure mode.

### MINOR — `global_id` and the measurement joined on different keys

`scripts/review-precision-baseline.ts` recomputed `<reviewId>#<id>` and never
read `finding.global_id`. `assignGlobalIds` mints only when absent, so a finding
carried into round 2 keeps `rev-round1#F-001` while the script looked for
`rev-round2#F-001` — classifying a dispositioned finding as `unknown` AND
reporting its ledger row as stale, both for one reason. Fixed at both ends: the
script keys on the record's own `global_id`, and `review-finding.schema.json`
(plus the bundled reviewer schema, plus both `.metaproject/` mirrors) now pins
`"pattern": "^[^#]+#[^#]+$"` so a producer outside this repository cannot supply
a string that joins to nothing while looking like a key.

### MINOR — the baseline script's own report was stale

`record` had been added to the source type and to the classifier and not to the
report loop, so a run with one recorded disposition printed a classification
totalling 3 against a source table totalling 1. The loop now derives from a
single `EVIDENCE_SOURCES` constant. The `NOT A BASELINE` note also still argued
from two facts commit `8635d789` had made false on this branch ("no disposition
property", "decisions.md is a template"); it now argues from what is true — the
instrumentation exists, nothing has been written through it, and an unwritten
outcome reads as `unknown`.

Verified against the real corpus: **still 53/53 over 83 findings** (AC2's
reproducibility is intact), and the source totals now sum to 83.

### MINOR — `recordDispositions` guarded the state but not the evidence

Re-recording the same state silently replaced the citation. The refusal to
reverse a verdict is defensible; guarding half the record is not, since the
evidence is the whole reason a disposition is more than an assertion. A CHANGED
citation is now refused; an IDENTICAL one stays a no-op, so a retried `review
complete` is still safe.

### MINOR — two AGREEING verifiers cancelled each other

Any group of more than one claim per finding was discarded as
`conflicting-claims`, so two reviewers independently reaching `confirmed` — the
strongest evidence state available — produced no verdict and were labelled a
conflict. The safe-direction argument is about claim ORDER deciding an outcome,
which cannot happen when every claim says the same thing. Disagreement still
cancels; a unanimous group now records its verdict, the **strongest** method in
the group, and both verifiers and both pieces of evidence.

This is not a retreat from "never votes": each claim was already admitted on its
own — named non-author, real method, real evidence, `reasoning` capped before
grouping — so agreement adds no authority any member lacked. Both the skill and
the CLI reference now say that explicitly, next to the padding-oracle
counter-example. `claims_applied` now counts CLAIMS rather than findings, so
`claims_received = claims_applied + claims_rejected` keeps holding.

### Nothing in the review was concluded to be wrong

All seven reproduced. Three places the fix went further than the review asked:
AC9 normalisation also folds `_` and case (the review listed four spellings; the
same defect admits more); the `--scope` counts-only form is refused rather than
tolerated; and the carried-block fallback was added on top of the review's
suggested design, because that design alone still loses the record when an
operator forgets `--scope`.

### Gates

- `bun run typecheck` — clean.
- `bun test src/review/ src/commands/review.test.ts` — 165 pass, 0 fail (was 121
  before this work).
- `bun run test:guards` — 161 pass, 0 fail. `bun run check:doc-links` — 0 broken.
- `bun test` — 5595 pass, 0 fail on one run; a second run had the single known
  machine-local `src/sac/fwk-service.test.ts` failure, which reproduces on
  unmodified `origin/main` and is unrelated.
- AC12: both skill copies and both schema mirrors verified byte-identical with
  `diff`.
- 2026-08-29T20:56:05.233Z - task-done: T2: Implement per plan
- 2026-08-29T20:56:05.328Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-29T20:56:05.420Z - task-done: T11: review-verifier skill: verdict/method/evidence, reasoning-only capped at unverifiable
- 2026-08-29T20:56:05.519Z - task-done: T12: Verifier merge is delete-only: escalations and additions discarded in code
- 2026-08-29T20:56:05.613Z - task-done: T13: Test: an attempted escalation from the verifier is discarded
- 2026-08-29T20:56:05.704Z - task-done: T14: Verifier never verifies a finding from the reviewer that raised it
- 2026-08-29T20:56:05.797Z - task-done: T15: Remove review-strict from Wave C with the degradation evidence stated in the skill
- 2026-08-29T20:56:05.887Z - task-done: T16: verification_mode off|annotate|filter, defaulting to annotate; test the default
- 2026-08-29T20:56:05.981Z - task-done: T17: Stage counts in the review record: dropped, refuted, retained
- 2026-08-29T20:56:06.074Z - task-done: T18: Verify both mirrors agree; bundled-rule guard still passes
- 2026-08-29T20:56:06.168Z - task-done: T19: Quality gate: typecheck, full suite against baseline, guards, doc-links
- 2026-08-29T20:56:26.720Z - ac-confirmed: AC1: Measured before any pipeline change: 53/(53+0)=100% over 83 findings in 17 packages, 30 unknown. Recorded in baseline.md with sample, method and four demonstrated reasons why it is refused as a baseline.
- 2026-08-29T20:56:26.813Z - ac-confirmed: AC2: scripts/review-precision-baseline.ts; two runs give byte-identical --json; exits 1 when the ledger and packages disagree, verified with a planted stale row.
- 2026-08-29T20:56:26.907Z - ac-confirmed: AC3: src/review/scope.ts drops generated/lockfile/snapshot/minified/vendored/binary paths and whitespace- and comment-only hunks, scoping to changed hunks plus a 20-line window. Pure function of (diff, config); no model call.
- 2026-08-29T20:56:27.001Z - ac-confirmed: AC4: Implemented in src/review/scope.ts and reached via keryx review scope, not as a SKILL.md instruction. scope.test.ts runs a diff with a lockfile, a whitespace-only hunk and a real change and asserts only the real change survives.
- 2026-08-29T20:56:27.094Z - ac-confirmed: AC5: Every drop carries path, granularity, reason, human detail and changedLines. --scope renders the drop table into scope.md through one writer; an existing block is carried forward when no scope is passed; --append replaces rather than appends.
- 2026-08-29T20:56:27.188Z - ac-confirmed: AC6: review-strict deleted from Wave C and from both mirrors, catalog and module manifest. The degradation numbers (GSM8K 95.5 to 89.0; CommonSenseQA 75.8 to 38.1; Self-Refine +49.2 dialogue vs +0.2 maths) are written into four places and a test asserts they remain.
- 2026-08-29T20:56:27.278Z - ac-confirmed: AC7: verification {verdict, method, evidence, verifier}. Reasoning-only is capped at unverifiable and can reach neither confirmed nor refuted - refuted was added to the cap because it is the verdict with a destructive consequence. Enforced in the merge and in the schema.
- 2026-08-29T20:56:27.369Z - ac-confirmed: AC8: Merged record is {...original, verification} and nothing else is read from a claim, so no code path can apply an escalation. Claim schema is additionalProperties false over five fields. A claim carrying severity is discarded whole and named; the finding is retained on every rejection path.
- 2026-08-29T20:56:27.462Z - ac-confirmed: AC9: Self-verification refused by name, with both sides normalised (lowercase, trim, trailing model annotation stripped, underscores folded) after the review proved a trailing space bypassed exact equality and deleted a blocker in filter mode.
- 2026-08-29T20:56:27.554Z - ac-confirmed: AC10: verification_mode off|annotate|filter defaults to annotate, asserted twice - the constant and the behaviour of an unspecified mode. off refuses claims rather than ignoring them.
- 2026-08-29T20:56:27.648Z - ac-confirmed: AC11: Stage counts render into scope.md: dropped by pre-filter, refuted by verifier, retained. Prints 'not recorded' rather than zero when no scope was supplied, because 'dropped nothing' and 'never ran' are different facts.
- 2026-08-29T20:56:27.741Z - ac-confirmed: AC12: diff -r over both skill trees and both schema mirrors: identical for everything this flow touched. The bundled-rule guard test still passes.
- 2026-08-29T20:56:27.834Z - ac-confirmed: AC13: typecheck clean; test:guards 161/0; check:doc-links 1130 links 0 broken; bun test 5595 pass / 18 skip / 1 fail, the one being src/sac/fwk-service.test.ts which reproduces on unmodified origin/main in a fresh worktree.
- 2026-08-29T20:56:27.925Z - ac-confirmed: AC14: disposition {state, evidence} with six states pinned by test to the measurement's buckets; evidence-less disposition refused rather than downgraded; global_id minted only when absent, constrained by schema pattern; a round records what it refuted into the same findings.json. CLI surface added so the mechanism is reachable.
- 2026-08-29T20:56:28.017Z - ac-confirmed: AC15: The flow's claims are stated as stage counts. AC1 records the precision figure as refused and forbids citing it as a baseline.

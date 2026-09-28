# Acceptance Layer — PRD

Version: 0.3.0

## Problem

A flow freezes its acceptance criteria, an agent or a human confirms each one,
and completion gates on every criterion being confirmed. The confirmation is a
timestamp and a free-text note. Nothing else.

Two measurements over this repository's own corpus say what that produces
(method and caveats in [metrics-and-validation.md](metrics-and-validation.md)):

- **2,705 criteria, 2,606 confirmations, zero executable bindings.** The
  confirmation rate is 96 %. The schema has no field a check could live in.
- **3.9 % disagreement.** Among criteria whose named artefacts the deterministic
  half of `flow check-ac` can judge, 36 of 919 were confirmed while every named
  artefact was absent from the flow's own diff. Small — and part of it is the
  heuristic's own false positives on invariants and process criteria.
- **26.8 % opaque.** Of 1,255 measured criteria, 336 are ones the deterministic
  half can say *nothing* about: 318 name no artefact at all, 18 describe a
  condition no diff records.
- **At most 26.6 % name anything runnable** across the full corpus, and that is
  an upper bound, because a backticked command is often the criterion's subject
  rather than its check.

The problem is therefore not dishonest confirmation. It is that roughly a
quarter of criteria are written in a form that makes verification impossible in
principle, and nothing in the system distinguishes those from the criteria that
were genuinely checked. A confirmed-but-unverifiable criterion and a
confirmed-and-tested one are rendered identically, gate identically, and sign
identically.

A fifth measurement explains why a heavier solution would fail. Sliced by flow
number, the habit of *claiming* verification in prose grew from 4.9 % (flows
1–100) to 13.7 % (flows 301–357) — almost threefold, with no tooling asking for
it. The habit of *naming* what verifies the criterion did not move: 4.4 % then,
5.0 % now. The discipline emerged on its own and stopped where it had nowhere to
land. There is no field, no format, and nothing asks.


### The same gap, one level up

The corpus was also read at the level above a criterion. Every requirements
package states success criteria, and sampling four of them —
`keryx-p0-improvements`, `keryx-agent-bus`, `shared-agent-context-receipts-provenance`
and `keryx-jev-router` — every criterion is a **release** criterion: three
committed transcripts, the weekly job green twice, AC1–AC22 green, no regression
in the suites, a restore under two seconds.

Not one states what should change for the person the work is for. At the
criterion level 26.8 % cannot be verified at all; at the package level the
success criteria can all be verified and verify the wrong thing — that the
artefact was built, not that it helped. The engineering acceptance here is
stronger than common practice. The product acceptance is absent.

## Goal

Give the discipline that already emerged a slot to land in, at the two moments a
criterion is written, and make what the system cannot verify visible rather than
silent.

Not: make every criterion executable. The corpus says the honest ceiling is
about a quarter, and a package that promised more would be promising against its
own evidence.

## Users

- **The flow owner**, who writes criteria at `flow init` and freezes them. Gains
  one trailing marker per criterion and a distribution printed at freeze.
- **The implementing agent**, which reads criteria as its definition of done.
  Gains an unambiguous statement of what closing a criterion requires.
- **The reviewer**, human or agent, who today cannot tell a checked criterion
  from an uncheckable one. Gains that distinction.
- **The requirements author** using `docpack-orchestrator`, whose PRD
  requirements gain the field that makes criteria born classified.

## Requirements

### R1 — A kind per criterion, inside the seal

Every acceptance criterion declares one of four kinds. The declaration lives in
the criterion's own line in `acceptance-criteria.md`, so it is covered by the
same checksum as the text, and changing it re-seals and voids prior signatures
exactly as a text change does.

| Kind | Meaning | May gate |
|---|---|---|
| `exec` | A runnable check whose exit code decides the criterion. | Yes (W1) |
| `invariant` | A runnable check asserting that something does **not** happen. | Yes (W1) |
| `judged` | A model verdict. Advisory, reported, never decisive. | No |
| `none` | Accepted as unverifiable, with a stated reason. | No |

`invariant` is a separate kind because the corpus proved it must be. A criterion
such as "no subagent ever gains access to X" is satisfied by a diff that does
*not* contain the named thing; a token-presence check reports it as a failure by
construction. Several of the 36 disagreements are exactly this.

### R2 — Freeze reports, never refuses

`flow freeze` parses the kinds, stores the distribution, and prints it. A flow
whose criteria are entirely `none` freezes normally. The distribution is the
acceptance-coverage figure and is available to `governance report`.

### R3 — Old flows are `unclassified`, not `none`

A criterion with no marker is reported as `unclassified` and is never silently
read as `none`. The 2,705 criteria already frozen are not migrated, and the
report must not imply a decision nobody took.

### R4 — The requirements package carries the field

The PRD contract in `requirements-package-standard.mdc` gains a per-requirement
verification field, and the docpack Verify phase gains one rule: every
requirement states how it will be known to be true. The Verify phase already
runs and already checks structure, versions and links; this is a rule inside it,
not a new gate.

### R5 — This package is written in its own format

The acceptance criteria in [specification.md](specification.md) carry their
kinds. If the format is unpleasant to write, that is discovered here, before any
code exists.


### R6 — The PRD states outcome criteria as well as release criteria

The PRD contract splits success into two lists.

- **Release criteria** — what exists and passes. This is what the contract asks
  for today and it stays unchanged.
- **Outcome criteria** — what should change, for whom, and how it will be seen.
  Each one names its observation, or declares `not measured — <reason>`.

`not measured` is deliberate and mirrors the `none` kind: a package that cannot
observe its outcome says so, rather than dressing a release criterion as one. A
package whose outcome list is entirely `not measured` is valid and visible; a
package with no outcome list at all is not.

The docpack Verify phase gains the corresponding rule, beside R4's.

## Success criteria

### Release criteria

- Every criterion of the flow implementing W0 carries a kind, and at least one
  of each of the four kinds appears — including at least one honest `none`.
- `flow freeze` prints a distribution that a reader can act on without opening
  the criteria file.
- The parser accepts every one of the 2,705 existing criteria as
  `unclassified` without error, and reports zero parse failures.
- The docpack Verify phase fails a package whose requirement states no
  verification field, and that failure names the requirement.
- Measurement 2 becomes possible: the share of criteria that received each kind,
  reported per flow.

### Outcome criteria

- The share of new criteria carrying a kind rises from 0 % to a majority within
  ten flows. Observed by `flow ac kinds` across those flows.
- At least one criterion in those ten is honestly `none`. Observed the same way.
  Zero `none` means the escape hatch is being avoided for appearances, which is
  a worse outcome than a low `exec` share.
- A reader who did not write the flow can tell, without opening the criteria
  file, which criteria were checked and which were accepted unverified.
  `not measured — no instrument for this; it is a judgement a reader makes, and
  the evidence is whether anyone asks for the criteria file after reading the
  distribution.`

## Risks

| Risk | Mitigation |
|---|---|
| The marker becomes a box-ticking ritual — everything declared `exec`, nothing run. | W0 does not gate, so there is no incentive to lie. W1 gates only on a check that actually runs, which makes a false `exec` fail loudly rather than pass quietly. |
| The format is awkward and gets skipped. | R5: the package writes its own criteria in the format first. Awkwardness surfaces before code. |
| `none` becomes the default escape. | `none` requires a stated reason on the same line, and the freeze distribution makes a flow full of `none` visible to anyone reading the report. |
| Re-sealing friction: adding a kind to a frozen flow voids signatures. | Correct and intended. The kind is part of the criterion, and changing what verification a criterion demands is a change to the criterion. |
| Over-reach into `check-ac`'s advisory decision. | Explicit non-goal. The model verdict stays advisory; only `exec` and `invariant` may gate, and only in W1. |

## Recommendation

Implement W0 alone, then measure. The evidence supports classification and does
not support execution as a majority outcome; W1 follows only if the freeze
distribution shows enough `exec` and `invariant` criteria to make a runner worth
building. That decision gate is in
[implementation-plan.md](implementation-plan.md) and should not be skipped
because the runner is the more interesting thing to build.

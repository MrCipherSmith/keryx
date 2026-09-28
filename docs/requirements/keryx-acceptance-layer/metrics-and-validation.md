# Acceptance Layer — Metrics and Validation

Version: 0.1.0

## Why this document exists

The package claims a defect in how acceptance works. A package that claims that
and measures nothing would be an instance of the defect it describes. Everything
below was measured on this repository's own corpus on 2026-09-28, before any
code was written, with the falsification criteria recorded first.

## Method

The deterministic half of `src/flow/check-ac.ts` was reproduced outside the
codebase: the same `extractCriterionTokens` rules (backticked tokens, bare file
paths, `keryx <sub>` command names), the same `allTokensAbsent` definition, and
the same `NOT_CHECKABLE_MARKERS` list with its clause-splitting rule. No model
was called and nothing was written back.

A flow entered the diff-dependent measurement when its status was `done` and its
pull request resolved to a squash commit on `origin/main`. Changed files and
diff text came from that commit.

## Baseline — the whole corpus

| Figure | Value |
|---|---|
| Flow packages | 337 (336 with parsed criteria, 301 `done`) |
| Acceptance criteria | 2,705 |
| Criteria bound to an executable check | 0 — the schema has no such field |
| Confirmations recorded | 2,606 (96 % of criteria) |
| Confirmations naming no test, file or artefact | 788 (30 %) |

A confirmation has the shape `{"at": "…", "note": "…"}`. In the best case the
note names a test — `src/review/managed.test.ts covers …` — but the link exists
only in prose. Nothing runs that test to close that criterion, and nothing
notices if the test is deleted.

## Measurement 1 — retrospective disagreement

126 flows, 1,255 criteria, all of them confirmed.

| Classification | Criteria | Confirmed |
|---|---|---|
| Not-checkable by marker | 18 | 18 |
| Names no artefact at all | 318 | 318 |
| Named artefacts present in the diff | 883 | 883 |
| **All named artefacts absent from the diff** | **36** | **36** |

- Disagreement among criteria the facts can judge: **36 / 919 = 3.9 %**
- Criteria the deterministic half cannot judge at all: **336 / 1,255 = 26.8 %**

**Coverage limit.** 126 of 337 flows were measured. 35 were not `done`; 175 had a
pull request that did not resolve to a commit on `main` — a different merge
style, a different field shape, or a PR outside `main`'s history. The
measurement is silent about 52 % of the corpus and the rate must not be extended
over it.

**Heuristic limit.** Inspection of the 36 showed the heuristic misfiring on two
criterion shapes it cannot serve: invariants, where the correct diff is the one
that does *not* contain the named thing, and process criteria such as
"`tsc --noEmit` is clean", which never reach a diff. Part of the 3.9 % is the
heuristic's own false positives, not human error. This is the evidence behind
the `invariant` kind in the specification.

## Measurement 1b — what the criteria already say

All 2,705 criteria, no diff involved.

| Figure | Value |
|---|---|
| Claim verification in prose ("covered by …") | 255 (9.4 %) |
| Name a concrete `.test` / `.spec` file | 104 (3.8 %) |
| Name a runnable command in backticks | 653 (24.1 %) |
| **Name anything runnable at all** | **720 (26.6 %)** |
| Claim coverage while naming nothing runnable | 174 (6.4 %) |

**The 26.6 % is an upper bound, not an estimate.** A backticked command is often
the criterion's subject rather than its check — "`keryx flow status` shows X"
names a command that does not verify anything. No regex separates the two.

## Measurement 1c — the trend

Sliced by flow number, which is chronological.

| Flows | Criteria | Claim coverage | Name a test file |
|---|---|---|---|
| 1–100 | 450 | 4.9 % | 4.4 % |
| 101–200 | 749 | 4.8 % | 2.5 % |
| 201–300 | 965 | 12.6 % | 3.9 % |
| 301–357 | 541 | **13.7 %** | 5.0 % |

The habit of *claiming* verification grew almost threefold with no tooling
asking for it. The habit of *naming* what verifies the criterion did not move.
The discipline emerged and stopped where it had nowhere to land. This is the
load-bearing argument for W0's shape: the package supplies a slot, not a
discipline.

## Falsification criteria, and what fired

Both were written before the measurements.

**F1 — "Measurement 1 returns near-zero disagreements."** Then confirmations were
accurate without execution, the binding buys process hygiene rather than
correctness, and the claim weakens to an organisational one.

> **Fired.** 3.9 % is not zero but it is small. "Confirmations are unreliable"
> did not survive. When a criterion is written so that it can be checked at all,
> it is confirmed honestly in about 96 cases out of 100. The programme was
> restated around unfalsifiable criteria instead of false confirmations.

**F2 — "Noticeably fewer than half the criteria can be bound."** Then "acceptance
must be executable" is overstated, and the honest conclusion is that acceptance
must be explicitly *classified*.

> **Fired, before any intervention.** At most 26.6 % of criteria name anything
> runnable. W0 is classification, and that is the finding rather than a
> compromise.

## What measurement 2 must show

W0 is worth keeping only if, after it ships:

- the share of new criteria carrying a kind approaches 100 %, because the slot
  is cheap enough to fill;
- at least some criteria are honestly marked `none`, because a corpus with zero
  `none` means the escape hatch is being avoided for appearances;
- the `exec` plus `invariant` share is large enough to make W1's runner worth
  building. If it lands far below the 26.6 % upper bound, W1 does not follow.

## Threats to validity

One repository, one author, self-measurement, and both the code and the criteria
were written largely with model assistance. This is the same construction this
programme criticises elsewhere, and the only honest handling is to state it
first and draw no industry-wide conclusion from n = 1. What a single corpus
supports is existence: the gap between claimed and measured is real here and has
a size here.

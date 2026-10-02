# Implementation Plan

Status: ready

## Approach

Follow docs/requirements/keryx-product-module/implementation-plan.md P1: parser
and `Intent` extraction with the corpus test first, then `index`, then `open`,
then the staleness guard. Stop after the number is read (gate G1).

The specification does not say where an observation is recorded. This flow
decides the smallest thing: a line beginning `outcome-observed:` in the flow's
existing `journal.md`. No new document, and consistent with the acceptance-layer
convention of recording evidence in the journal. Stated as a decision in the
journal so the operator can overrule it.

## Steps

1. `src/product/intent.ts`: `Intent` extraction from a flow dir (title,
   description Problem/Expected Outcome sentence, criteria via acceptance-layer
   `AcKindRecord`, status, closedAt, outcome list from the PRD when a package is
   the source) with the corpus test first (AC1).
2. `src/product/index.ts` and `keryx product index [--json]`; deterministic
   ordering, byte-identical rebuild (AC1, AC4).
3. `keryx product open [--json]` and the staleness guard (AC2, AC3).
4. Observation source (AC7).
5. Never-gates, no-model and bulk-budget invariants (AC5, AC6, AC8).
6. TUI surface (AC9).
7. Read the number on the real corpus with the breakdown, write it to the journal
   (AC10), report to the operator, stop.
8. Docs, CHANGELOG, version bump (AC11).

## Risks

- Old flows carry no outcome list, so `open` on the old corpus is close to
  tautological; the breakdown at G1 is what keeps the number honest.
- Flow directories are untracked on main, so CI sees no corpus: tests fall back
  to a checked-in fixture set.
- Any coupling from index or open into freeze/complete is a scope violation.

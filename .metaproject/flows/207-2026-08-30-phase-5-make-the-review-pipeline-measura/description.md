# Description

## Problem

Phase 5 of `docs/requirements/keryx-orchestrator-hardening/`. Phases 0–4 and 7
are delivered; this is the one that makes their claims checkable after the fact.

The roadmap states the stake plainly: without `filter_stats`, no claim made in
Phase 2 can be verified later, **and this roadmap becomes the next document
asserting an unenforced property**. That is the failure this whole programme
exists to end, and it would be the programme committing it.

Four items, each measured against the tree as it stands today:

**5.1 `filter_stats` does not exist.** `keryx ctx rg -l "filter_stats" src/`
returns nothing. Stage counts are printed by `review ingest` and written into
`scope.md`, but there is no structured record in the output contract — so the
numbers can be read by a person and by nothing else.

**5.2 The dismissal taxonomy is half-wired.** `FINDING_DISPOSITION_STATES`
already carries the four-way split (`dismissed-incorrect`,
`dismissed-wont-fix`, `dismissed-out-of-scope`, `dismissed-deprioritised`), and
`managed.ts:1129` maps `dismissed-incorrect → false_positive`. What is missing is
the signal at the other end: `.metaproject/memory/review-notes/` does not exist —
the `review-note` type has never been written, so **the learning loop has
produced nothing to date**. Only `dismissed-incorrect` is model error; the other
three are correct findings the team chose not to act on. Conflating them poisons
any learning signal, which is exactly what a self-learning reviewer now depends
on.

**5.3 65 bundled skills have no quality evaluation.** `keryx skills verify`
covers project skills. Nothing evaluates the bundled tree. The roadmap cites a
three-layer bar — static structural validation, a judge across named dimensions,
and reliability over repeated runs — and notes we have the first layer only for
somebody else's skills.

**5.4 Cross-family review is unused capability.** `llm-providers.json` and
`src/lib/provider-config.ts` already exist. The cited 1,000-PR study reports
~8–10 recall points for reviewing with a different model family than authored
the code (Claude→Claude 53.7% vs GPT→Claude 62.0%). Nothing in the review
pipeline reads the configured providers to make that choice.

## Expected outcome

The pipeline reports what it filtered, in a form a machine can check. A
dismissal says which of four things it means, and the one that indicates model
error reaches the learning loop. The bundled skills are evaluated rather than
assumed. When a second provider is configured, review can run against a
different family than authored the change.

## Scope of THIS flow

Roadmap §5.1–§5.4.

## Out of scope

- **Phase 6** — outcome recording at scale. Not a code change; it needs months of
  instrumented reviews, and the instrumentation now runs by default.
- **The SAC ledger checkpoint hole** — a security-mechanism change awaiting an
  operator decision.
- Re-running the orchestrator benchmark. Worth doing once this lands, because
  measurement is what makes a comparison meaningful, but it is not this flow.

## The rule this flow is built on

> A mechanism whose failure is silent is the one that fails.

Every item here is instrumentation, which makes the failure mode specific:
**instrumentation that reports zero because nothing measured is worse than no
instrumentation**, since it reads as a clean result. Every count this flow adds
must distinguish "measured and found none" from "did not measure".

## What this flow must not do

**It must not add a number nobody reads.** `filter_stats` exists to make Phase 2's
claims checkable; if nothing consumes it, it is another declared-and-unwritten
field like `attempts.count` and `metrics.steps[].retries` before it.

**It must not evaluate skills with a bar that always passes.** A judge that
approves everything measures nothing. Whatever 5.3 ships must be demonstrated to
fail a skill that deserves to fail.

**It must not make cross-family review a silent default.** Dispatching to another
provider spends someone else's tokens and sends their code to a second vendor.
It is opt-in, and the record says which family reviewed.

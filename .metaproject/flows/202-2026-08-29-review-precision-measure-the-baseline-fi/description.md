# Description

## Problem

Our review design bets on breadth: 19 selectable reviewers, ~440 checklist
items. The field evidence contradicts that bet without exception.

- Only **30–42%** of AI review comments contain a valid issue (22,326 comments,
  178 mature repositories). Addressing rate for *valid* comments: humans 60%,
  best bot 19.2%.
- The one independent field study is negative: ~50% noise, ~25% bikeshedding,
  the remainder half useful and half wrong — **≈12.5% useful**, after which the
  maintainers switched the tool off.
- Neither market leader converged on our architecture. Cursor abandoned fixed
  parallel fan-out for a single adaptive agent and called it their largest gain.
  The closest open competitor ships 5 dimensions defaulting to 3. **Nobody runs
  19.**

What works is subtraction: a QA-checker stage took precision **51% → 93%** by
rejecting; a static-analysis alarm filter removes **94–98%** of false positives.

**"False positive" appears zero times in our entire review domain.** We built
the generator and none of the filter.

## Expected outcome

A review pipeline that removes before it reports, and a number that says whether
that helped.

Three changes, in this order, and the order is the point:

1. **Measure first.** Establish the current precision of our own reviews before
   touching the pipeline. A figure taken after the filter lands proves nothing
   without a before, and every justification above is someone else's
   measurement, not ours.
2. **A deterministic pre-filter before dispatch** — drop generated, vendored and
   whitespace-only changes, scope reviewers to changed hunks. No model call.
3. **A verifier that can only delete**, and that verifies by *executing*
   something rather than by re-reading.

## Scope of THIS flow

Roadmap §6.3 (baseline measurement), §2.1 (pre-filter), §2.2 (verifier).

## Out of scope — separate flows

- §2.3 Iron Laws generalised to all reviewers, §2.4 aggregated confidence,
  §2.5 caps (findings, spend, rounds 6→3), §2.6 loop detection.
- Phase 3 unification: one canonical severity rubric, skill-format cleanup.
- Phase 4: deep review rounds, clean-round completion gate, PR comment handling,
  adaptive model selection.
- Phase 5 and the rest of Phase 6: `filter_stats`, dismissal taxonomy, skill
  evaluation, cross-family review.
- Phase 7: the `job-orchestrator` audit.

## The rule this flow is built on

From the roadmap, and it decides what belongs here:

> Anything mechanical moves out of the skill and into the code that consumes the
> skill's output. Not "word the instruction more firmly" — take the operation
> away from the model entirely.

The pre-filter qualifies: dropping a lockfile needs no judgement. The verifier
qualifies in its mechanism (run a command, compare the result) while its verdict
remains the model's. `review-strict` — which re-reads findings and adjusts
severity with no new evidence — is measured to *degrade* accuracy and is
replaced rather than improved.

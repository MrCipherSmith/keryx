# Description

## Problem

A benchmark on 2026-08-29 measured our own 196 flow packages against the field.
Two results define this flow:

1. **The acceptance-criteria gate, written in TypeScript, held 184 times out of
   184.** The task gate, asserted in Markdown, has never existed:
   `taskGateStatus()` in `src/flow/machine.ts:40` is written, tested, and
   carries a comment saying it is deliberately not wired into
   `service.complete()`. Measured consequence: **24 of 184 done flows carry an
   unfinished task — 34 tasks in total, 24 of them the review step itself.** One
   completion in eight skipped its own review, while `flow-orchestrator/SKILL.md`
   told the reader that could not happen.

2. **The managed review record cannot survive a round.**
   `src/review/managed.ts:283` re-parses findings from Markdown and discards
   `confidence`, `evidence`, `impact` and `suggested_fix`, hardcoding `reviewer`.
   A fix round requires `prior_findings[].finding` to conform to
   `review-finding.schema.json`, which requires all four and is
   `additionalProperties: false`. **Round 2 cannot be built from round 1's own
   artifact.**

Requirements: `docs/requirements/keryx-orchestrator-hardening/`.

## Expected outcome

The foundation the rest of the programme needs:

- the task gate enforced in code, with the false claim removed in the same
  commit;
- dead surface deleted (`--greptile`, the frontend-conventions misroute, the
  unreachable `FAILED` status);
- the review record round-trip-safe, so a second round can be constructed from
  the first;
- attempt counts persisted, so a loop bound survives a session restart.

After this flow, phases 2–5 of the roadmap become buildable. Before it, they
have nothing to stand on.

## Scope of THIS flow

**Roadmap phases 0 and 1 only.**

The flow title names the whole programme because it was created for it; the
frozen acceptance criteria below cover phases 0 and 1. This is deliberate: a
flow whose criteria span six phases cannot be frozen meaningfully, and 27% of
our flows already exceed eight hours of wall-clock, which is where attempt
counters get lost.

## Out of scope — separate flows

- **Phase 2** — review precision: deterministic pre-filter, `review-verifier`
  replacing `review-strict`, Iron Laws generalisation, caps 6→3, loop detection.
- **Phase 3** — unification: one canonical severity rubric, skill-format
  cleanup against the published Agent Skills spec, mirror-divergence check.
- **Phase 4** — the new capabilities: deep review rounds, completion gated on a
  clean final round, external PR comment handling, adaptive model selection,
  the GitHub brevity rule.
- **Phase 5** — measurement: `filter_stats`, dismissal taxonomy, skill
  evaluation, cross-family review.

Also out of scope: any checkpoint/durable-execution engine, parallel writing
agents, additional reviewers or agent roles — each rejected against measurements
in `roadmap.md` §Rejected.

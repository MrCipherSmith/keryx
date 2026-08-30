# Description

## Problem

Phase 7 of `docs/requirements/keryx-orchestrator-hardening/` — the last audit,
and the one deferred from every previous flow.

`job-orchestrator` is 67,466 bytes and 1,759 lines across 34 sections. It is the
oldest of the four orchestrators and **it has never been read**. It ships in five
per-harness builds (`SKILL.md`, `SKILL.codex.md`, `SKILL.cursor.md`,
`SKILL.opencode.md`, `SKILL.zed.md`) plus two contracts.

The reason this is worth a flow rather than a skim is that the prior has a
perfect record. Both orchestrators audited so far documented mechanisms that do
not exist in code:

- `flow-orchestrator/SKILL.md` said an unrun verification step keeps a flow open.
  `taskGateStatus()` was written, tested, and carried a comment saying it was
  deliberately unwired. **34 unfinished tasks across 24 flows shipped behind that
  sentence.**
- `review-orchestrator` documented ~10 mechanisms of which two were enforced in
  code.
- Flow 204, closing today, found **five more**: `buildTierMap`, `assignTier`,
  `decideDispatchModel`, `screenBlastRadiusFindings` and the `--max-chars`
  ceiling were each described in a skill, a schema or a rule as running, while
  being reachable only from their own tests.

This file describes roughly twenty steps — ANALYZE, CONTEXT, PREPARE,
TESTS-CREATOR, IMPLEMENT, two separate SANITY CHECKs, REVIEW, FIX, VERIFY,
VERIFY-POST-FIX, PERF-CHECK, SKILL LEARNING, REPORT. The question is not whether
some of them are prose describing nothing; it is how many.

There is already visible drift in the table of contents: **two consecutive
sections are both numbered `2.8.1`** (`VERIFY-POST-FIX` and `PERF-CHECK`). A file
nobody reads has begun disagreeing with itself.

And the five builds are not the same size — `SKILL.md` is 66.7K while the other
four are 65.0K. That difference is unexplained and may be legitimate
harness-specific content or may be drift; nothing checks.

## Expected outcome

Every mechanism this skill documents is either **reachable from a production code
path** or **its claim is deleted**. No third option: a documented enforcement
that nothing calls is worse than no documentation, because it is read as a
guarantee.

The five builds either agree where they are meant to agree, or a guard explains
and enforces where they differ.

## Scope of THIS flow

Roadmap Phase 7. The audit, and the fixes it produces.

## Out of scope — separate flows

- **Phase 5** — `filter_stats` at scale, dismissal taxonomy on volume, skill
  evaluation, cross-family review. Deliberately after this: the audit may change
  what is worth measuring.
- **Phase 6** — outcome recording at scale. Not startable as a task; it needs
  months of instrumented reviews. The instrumentation now runs by default, so it
  is already accumulating.
- **The SAC ledger checkpoint hole** — `fastCheckpointState` trusts `stat`
  metadata and verifies only the tail record, so a same-size rewrite of a
  historical receipt landing in the same filesystem timestamp tick is undetected
  (measured 189/200). It is a security-mechanism change awaiting an operator
  decision, in a subsystem this flow does not touch.

## The rule this flow is built on

Unchanged from the roadmap, and it decides every finding here:

> Anything mechanical moves out of the skill and into the code that consumes the
> skill's output.

An audit finding is not "this sentence is unclear". It is "this sentence claims
something happens, and here is the search proving nothing makes it happen".

## What this flow must not do

**It must not fix a claim by softening it.** Rewriting "this is enforced" into
"this should be done" turns a false statement into a true one while leaving the
mechanism exactly as absent. Where the mechanism is worth having, wire it; where
it is not, delete the step. Downgrading the verb is how prose gates were born.

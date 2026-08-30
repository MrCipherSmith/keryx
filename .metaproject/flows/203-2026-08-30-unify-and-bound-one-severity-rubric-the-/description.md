# Description

## Problem

Flow 202 delivered roadmap §2.1 (the deterministic pre-filter), §2.2 (the
delete-only verifier) and §6.3 (measure before changing). **Phase 2 is not
closed** — four items remain, and Phase 3 has not started.

What is still wrong, each measured or read from the tree:

**Ten severity rubrics feed one sort.** `review-clean-code:395` makes a 41-line
function `major`; `review-security-code:303` makes "a plausible attack scenario"
`major`. Both force `REQUEST_CHANGES`. Direct contradiction in the same
codebase: `@ts-ignore` is `minor` in `review-backend:176` and `major` in what
was `review-strict:124`. A severity that means ten different things cannot be
ranked, and ranking is what an operator uses to decide what to read first.

**One reviewer has the discipline; thirteen do not.**
`review-security-code/SKILL.md:212-217` already requires an attack vector, sends
anything with no reproducible path to INFO, forbids the theoretical, and groups
repeats into one finding. That is the cheapest precision work available and it
exists in exactly one file.

**Nothing is capped.** `budget.max_findings` is schema-required with no default
stated anywhere. There is no token or currency ceiling. There is no concurrency
cap, while `review-orchestrator` dispatches in parallel and is itself nested
under `flow-orchestrator` and `job-orchestrator`. And the loop bound is four
different numbers that disagree: `task-implementer` 3, `job-orchestrator` 3,
`flow-orchestrator` 6, `/goal --auto` 8.

**A loop is only counted, never detected.** The bound fires on attempt count
alone, so an agent producing the identical failing output three times spends the
whole budget before anything notices.

**The skill format has drifted from the published spec** in two ways that are
accident rather than design: `version` is duplicated at the top level and inside
`metadata`, where the spec sanctions only the latter; and `compatibility` is
used as a machine-readable CSV of harness names while the spec defines it as
environment requirements in prose. Two other divergences — `triages` and
per-skill JSON-schema contracts — are deliberate and stay.

**~440 checklist items target NestJS, React, MobX and Prisma** in a
zero-dependency Bun CLI.

## Expected outcome

Claims that can be checked, and bounds that actually bind.

One severity rubric, applied everywhere, with `blocker` meaning merge-blocking
only. The Iron Laws in every reviewer. Caps with stated defaults on findings,
spend, concurrency and rounds — the round bound reduced to 3 and made the same
number in all four places. Loop detection by repeated finding, not only by
count. The skill format's accidental divergences removed and the deliberate ones
documented as deliberate.

## Scope of THIS flow

Roadmap §2.3, §2.4, §2.5, §2.6, and Phase 3 (§3.1–§3.4).

## Out of scope — separate flows

- **Phase 4** — deep review rounds, the clean-round completion gate, external PR
  comment handling, adaptive model selection, the GitHub brevity rule.
- **Phase 5** — `filter_stats`, the dismissal taxonomy beyond what 202 landed,
  skill evaluation, cross-family review.
- **Phase 6** beyond §6.3 — outcome recording at scale, which needs months of
  instrumented reviews, not a code change.
- **Phase 7** — the `job-orchestrator` audit. It is 65KB, the oldest of the
  four, and has never been read; both orchestrators that were audited documented
  mechanisms that do not exist. It deserves its own flow rather than a corner of
  this one.

## The rule this flow is built on

Unchanged from the roadmap, and it decides what belongs here:

> Anything mechanical moves out of the skill and into the code that consumes the
> skill's output.

Severity ranking, deduplication, finding caps and loop detection are all
mechanical. They are currently instructions. The Iron Laws are the exception —
they are judgement, and stay prose, but they stay prose in *fourteen* files
instead of one.

## What this flow must not do

Flow 202's self-review found that the component whose failure is silent by
construction is the one that failed. **Every cap added here can silently hide
work**, so each must record what it dropped, exactly as the pre-filter now does.
A cap that truncates without saying so reads as "there was nothing more", which
is the failure this whole programme exists to end.

# Description

## Problem

Phase 4 of `docs/requirements/keryx-orchestrator-hardening/` — the capabilities
the operator asked for, and the two cross-cutting rules that arrived with them.
Everything they depend on is now in place: flows 201–203 delivered the task
gate, a review record that survives a round, a computed scope, a delete-only
verifier, one severity rubric, and caps that say what they cut.

Five gaps remain, each named in `specification.md`:

**The PR review loop reviews the diff, not the blast radius.** A diff review
answers "is this change correct?" It does not answer "did this change break
something that was working." Those are different questions and only the first
is currently asked.

**A flow can complete without its last review round being clean.** `flow
complete` gates on acceptance criteria, PR-or-merge, tasks, health and security.
Nothing checks that the final review returned nothing unresolved — so a flow can
close with open findings, and the operator's instruction was the opposite.

**Comments left on the PR by anyone else are invisible.** A human or a bot
reviews our PR and nothing collects it, nothing fixes it, and nothing answers
it. Silence is the current behaviour for every comment.

**Every dispatch runs on the session's model.** `subagent-dispatch.schema.json`
carries a `model.tier` field applied in exactly one narrow case. A reviewer
scanning a 12-line diff and a regression reviewer reasoning across a 40-file
blast radius get the same model, so the cheap work pays flagship prices and the
hard work gets no more capability than the trivial.

**Nothing constrains what we write outward.** Verbose is right in a flow package
and wrong in a PR comment, and no rule says so.

## Expected outcome

A PR that is reviewed for what it can break, not only for what it changed; a
flow that cannot close over an unresolved finding; reviewers on the PR who get
an answer; dispatches sized to the work; and outward writing that is short.

## Scope of THIS flow

Roadmap §4.1–§4.5, specified in
`docs/requirements/keryx-orchestrator-hardening/specification.md` §1–§5 with
eighteen acceptance criteria already written there. This flow's own criteria
restate the ones that must hold in code and add the ones the specification
leaves to implementation.

## Out of scope — separate flows

- **Phase 5** — `filter_stats` beyond the stage counts already landed, skill
  evaluation, cross-family review.
- **Phase 6** beyond §6.3 — outcome recording at scale needs months of
  instrumented reviews, not a code change.
- **Phase 7** — the `job-orchestrator` audit. 65KB, the oldest of the four,
  never read; both orchestrators that were audited documented mechanisms that
  did not exist.

## The two rules this flow is built on

From the roadmap, unchanged:

> Anything mechanical moves out of the skill and into the code that consumes the
> skill's output.

The blast radius is computed, not browsed. Comment collection and reply posting
are mechanical. Tier assignment is mechanical. The judgement — is this a
regression, is this comment right — stays with the model.

And from three flows of evidence:

> A mechanism whose failure is silent is the one that fails.

Every addition here can hide work: a blast radius that silently truncates, a
gate that passes because nothing was recorded, a comment that is collected and
never answered, a tier that silently downgrades. Each must say what it did.

## What this flow must not do

**It must not let the completion gate pass on absence.** A finding disappearing
from round N+1 is not evidence it was fixed — it is equally consistent with the
reviewer not looking. Flow 202 measured exactly this failure shape: a corpus of
survivors from an unlogged triage, reporting 100% precision because nothing
could record a finding as wrong. "Clean" here is defined positively, per
finding, or it is not defined at all.

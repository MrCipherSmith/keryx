# Product Module — PRD

Version: 0.1.0

## Problem

Keryx can say what state the work is in, whether it is correct, what depends on
what and why it was built that way. It cannot say what the product is supposed
to be, or whether any of it helped.

Three consequences, each observable in this repository today.

**Intent exists only as prose in one place.** A flow carries a title, a
description and frozen criteria. Across 340 flows that is a complete record of
everything the product ever meant to do — and it has never once been asked as a
whole. There is no way to answer "what does this product currently claim about
itself".

**Nothing filters what enters.** While building was expensive, price was the
filter: you argued before committing, because committing cost weeks. Building is
now cheaper than the argument about it, and the filter is gone. Anything that
occurs to anyone enters the queue, because entering is faster than deciding not
to. Each feature is locally justified; the aggregate is justified by nobody,
because nobody holds the aggregate. It used to be held as a by-product of
slowness — at three weeks per feature the picture had time to form; at three
hours nothing accumulates.

**Nothing looks back.** A flow closes on merge and the record ends there. Given
that 50–75 % of ideas do not work, the closing merge is the moment the most
valuable signal in the process is discarded. No queue, no reminder, no trace of
the question.

The full derivation is in [theory.md](theory.md).

## Goal

Make the product's intent a queryable object, derived rather than maintained,
and attach to it the two moments where a human is actually needed: before work
enters, and after it closes.

Not: measure whether something helped. That requires instruments the module does
not have and should not pretend to. The goal is narrower and achievable — make
it impossible to forget that nobody measured.

## Users

- **The single operator** holding several functions at once, who has no separate
  product manager to remember this and produces too much to remember it alone.
- **The implementing agent**, which gains a way to check a task against what the
  product has already promised instead of treating each task as the first.
- **A small team** where one person covers product and another covers delivery
  but both work in the same repository.

## Requirements

### R1 — The intent set is derived, never maintained

`product index` builds the set from flows and requirements packages: title,
intent, audience where stated, criteria with their verification kinds, status,
and whether an outcome was ever observed. Nothing is authored by hand, and the
generated data is disposable — it can be rebuilt from the repository at any time.

Rationale: the corpus behind `keryx-acceptance-layer` measured that a claimed
discipline grew threefold on its own while a discipline requiring a new artefact
did not move at all. Asking a person to maintain a product document at three
hours per feature is asking for something that will not happen.

### R2 — Admission is deterministic first, judged second, and never blocks

`product admit` narrows candidates without a model — by graph proximity, by term
overlap, by the intent index — and returns what to look at, not a verdict. Only
when candidates exist does a skill compare them semantically and state whether
this contradicts, duplicates or supersedes something.

The verdict is advisory and lands as a section in the requirements package. It
never refuses a flow. A blocked path is worked around; a recorded decision stays.

### R3 — Closing in code does not close the intent

`flow complete` registers the intent, with its outcome criterion, in a standing
queue. `product open` lists what is closed in code and never checked for effect.
Nothing gates on this queue. Its only power is being visible and growing.

### R4 — The product report answers a different question from the activity report

What merged, what closed and who did how much is a solved commodity and is
consumed, not re-emitted. `product map` answers instead: what the product
currently claims, how much of that is proven, what was accepted as unverifiable,
what contradicts what, and how many promises have never been looked at.

Test of honesty: if the product report can be reduced to a restatement of
activity, the module has added nothing and that must be said rather than dressed.

### R5 — A skipped function is reported, not required

When a piece of work changes user-visible behaviour and carries no outcome
criterion, the freeze prints one line saying the product function was left
unclosed. Answering "not needed here" records a decision. The difference between
a gap and a choice is the whole point; the tool never asks which role is being
played.

### R6 — Named after a question, not a role

The module is `product` because of the question it answers. No module in this
repository is named after a job title, and adding one would re-import the
boundary the work is dissolving — and would immediately contend with a
hypothetical `business-analyst` module over requirements.

## Success criteria

### Release criteria

- `product index` builds a set over all flows and packages in this repository
  with zero parse failures, and the build is reproducible from a clean checkout.
- `product open` returns a number on the current corpus, and that number is
  explainable — every entry names the flow and the criterion it came from.
- `product admit` returns candidates in under two seconds on this repository
  without calling a model, and calls the skill only when candidates exist.
- `product map` output cannot be produced by the existing activity report: it
  names at least one fact — an unproven claim or a contradiction — that no
  activity report contains.
- The freeze line appears for a flow that changes user-visible behaviour without
  an outcome criterion, and no code path refuses anything on its basis.

### Outcome criteria

- After the module is in use for ten flows, the count from `product open` is
  looked at by a human at least once without being asked to. Observed by whether
  any outcome is recorded against a closed intent.
- At least one idea is changed or dropped because `admit` surfaced a conflict.
  Observed by a recorded decision in a requirements package.
- `not measured — whether attention actually concentrated on the unverifiable
  part is a judgement about the operator's own behaviour; the module has no
  instrument for it, and self-reported attention is worthless.`

## Risks

| Risk | Mitigation |
|---|---|
| The intent set is garbage because flow titles are garbage ("minor fixes"). | Stated openly as a limit rather than hidden: the module's output quality is bounded by what flows record. `index` reports how many entries carry no usable intent, which makes the limit visible instead of silently degrading the map. |
| `admit` becomes expensive or slow and gets skipped. | Deterministic narrowing first; the model is called only on a non-empty candidate set; the command is advisory, so skipping it costs nothing and nobody is tempted to disable it wholesale. |
| `product open` becomes a list nobody reads — a second backlog. | It is not a backlog: entries are never actioned, only observed or explicitly dismissed. If it is still ignored after ten flows, the outcome criterion above fails and the module's value claim fails with it. |
| The module drifts into a role-shaped bureaucracy. | The non-goals are load-bearing: no gate, no new subagents, no required step, no role-named module. Any addition that breaks one of them is a scope change, not a detail. |
| Duplication with the activity report. | R4 states the falsifier explicitly. |

## Recommendation

Ship W0 of `keryx-acceptance-layer` first, then `index` and `open` from this
package, and stop there long enough to read the first number. `open` on the
existing corpus is the cheapest honest measurement available: how many of 340
closed intents were ever checked for effect. If that number is not startling,
the premise of this module is weaker than the theory suggests and the rest should
not be built.

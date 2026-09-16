# Implementation Plan

Status: draft — scoped from a code-to-code reading, not yet brainstormed or frozen.

## Approach

Four items, one ordering principle: **A first, because it is the only one that
changes what a finding MEANS.** B, C and D are ergonomics and instrumentation and
can land in any order behind it.

The division of labour is fixed before any code is written, because getting it
wrong is how a rule ends up stated and unenforced: **the CLI enforces, the skill
instructs.** Nothing in this flow relies on a reviewer obeying prose. Every
criterion above is asserted against `keryx review`, not against an agent's
behaviour.

### A — the quote is the anchor

The shape is worth adopting because it removes a model judgement rather than
adding one: a model is bad at counting lines and
good at quoting the thing it just read.

1. Schema: add the quote to `review-finding.schema.json`. Required where `line`
   is meaningful; `line` becomes OUTPUT of ingest, not input.
2. `ingest`: locate the quote in `file` at the round's head. Exact match first;
   whitespace-normalised second. Derive `line`. No match → `unlocatable`.
3. Deliberately NOT implemented: a second LLM call to regenerate a better
   snippet when the match fails. It buys accuracy for a token cost on a path we
   can simply mark honestly. Revisit only if `unlocatable` turns out to be
   common — AC8 gives the number to decide on.

Open question for the round that implements this: what to do with a finding
about code that was DELETED by the change, which by definition cannot be quoted
at the head. Candidate: locate against the base instead and record which side
the anchor came from.

### B — repair the mechanical, refuse the judged

A repair is worth having mainly for its **acceptance test**: it is accepted only
if the result introduces no unknown property and preserves the object count.
Adopt that discipline exactly. String-escaping repair is out of scope — that is
a failure our JSON path does not have.

Scope the repair to two fields and stop: `id` (report order), `problem` (from
`title`). Anything requiring a claim stays refused — AC4 exists to make widening
it fail a test rather than pass a review.

### C — price the round

1. `scope`: estimate from the scoped diff's size. An estimate is allowed to be
   rough; it is not allowed to be silent.
2. `ingest`: record actual usage into `manifest.json`.
3. `complete`: cost per retained finding.

Keep the existing honesty convention: absent usage prints `not recorded`, never
`0`. `review budget` already models this distinction and says why.

### D — decide, then act on the decision

The analysis says grouping fits us least because we shard by domain, not by
file. That is an argument, not a measurement. The decision belongs in
`decisions.md` with whatever evidence the round can produce cheaply — e.g.
whether any recent round's findings actually needed two files side by side.

## Steps

1. Schema + `ingest` locator, with AC2's negative case written first.
2. Skills: swap the line-number instruction for the quote instruction (AC7).
3. Re-ingest the flow-260 report and produce AC8's discrepancy list. **This is
   also the evidence for whether A was worth doing.**
4. Repair pass with its acceptance test, plus AC4's guard.
5. Cost at the three points.
6. The grouping decision, recorded.
7. Full gate, PR, review round, close.

## Risks

- **The locator becomes a second guesser.** If the matcher is too clever —
  fuzzy, or searching the whole file for a near-match — it will confidently
  anchor a finding to the wrong site, which is worse than `unlocatable`.
  Exact, then whitespace-normalised, then give up.
- **Quotes make reports much larger.** Every finding now carries a snippet.
  Watch the `findings.json` size and the per-reviewer prompt budget; the point
  of C is that we will be able to see this happen.
- **AC8 may show the old anchors were mostly fine.** That is a real possible
  outcome and it should be reported as found, not buried — it would mean A's
  value is insurance rather than repair, and the flow should say so.
- **Scope creep into the gate.** The temptation will be to let the repair pass
  fix "just one more" field. AC4 is the guard; keep it failing.

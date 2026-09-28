# Product Module — Implementation Plan

Version: 0.1.0

## Bulk budget

Stated first, because "not bulky" is the binding constraint and a budget that is
not written down is not a constraint.

| | Budget | Spent by this plan |
|---|---|---|
| New modules | 1 | 1 (`product`) |
| New commands | 4 | 4 (`index`, `admit`, `open`, `map`) |
| New skills | 1 | 1 (`product-admit`) |
| New subagents | 0 | 0 |
| New mandatory steps | 0 | 0 |
| New gates / blocks | 0 | 0 |
| New documents a human must maintain | 0 | 0 |

Any change that exceeds a row is a scope change and goes back to the PRD, not
into the implementation.

## Dependency

W0 of `keryx-acceptance-layer` ships first. Without a declared verification kind
per criterion the index has nothing to record beyond titles, and `product map`
degrades into a list of flow names — which an activity report already gives.

## Order

### P1 — `index` and `open`

The cheapest honest measurement available, and the reason to do it first: it
answers, on the existing corpus, how many of the closed intents were ever checked
for effect. That number is either startling or it is not, and the rest of the
module depends on which.

Sequence: parser and `Intent` extraction with the corpus test first (AC1), then
`index`, then `open`, then the staleness guard (AC7).

Stop here and read the number before building anything else.

### P2 — `map`

Rendering plus the contradiction pass. AC6 is the real bar: the output has to
contain something no activity report can produce. If it cannot, P2 is a
restatement and should be dropped rather than shipped.

### P3 — `admit` and the `product-admit` skill

Last, for two reasons: it is the only path that calls a model, and it has nothing
to compare against until the index is populated by real use.

Deterministic narrowing lands first with its no-model invariant (AC3); the skill
follows and is invoked only on a non-empty candidate set (AC4, AC8).

### P4 — the three integration lines

Docpack Phase 0 call, freeze line, completion registration. Deliberately last:
each is small, and each is only worth wiring once the thing it calls exists and
has been read by a human at least once.

## Decision gates

### G1 — after P1, before P2

Read `product open` on the current corpus.

- **A large majority of closed intents were never checked** → the premise holds;
  continue.
- **Most were checked** → the premise is wrong for this corpus. Say so, publish
  the number anyway, and stop. A module that solves a problem this repository
  does not have should not be built into it.

### G2 — after P2, before P3

Apply AC6 honestly. If `product map` reduces to a restatement of activity, the
module has not earned `admit`.

### G3 — after ten flows with the module in use

Read the outcome criteria in the PRD. If `product open` was never looked at
without prompting, and no idea was ever changed because of `admit`, the module
is shelfware regardless of how well it works.

## What would stop this programme

- P1 ships and the number from `open` is unremarkable → the premise fails.
- `map` cannot produce a fact an activity report lacks → no differentiation.
- Ten flows pass and nobody reads the queue → the module makes the invisible
  visible to nobody, which is the same as not making it visible.
- Any row of the bulk budget is exceeded to make something work → the design was
  wrong, not under-resourced.

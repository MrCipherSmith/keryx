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

### G1 — split into G1a and G1b

The old G1 read `product open` on the historical corpus and called a large
never-checked share a confirmed premise. It was not: 310 of 310 closed intents
were never checked because the instrument did not exist, and that number says
nothing about whether checking would have found anything. See
[metrics-and-validation.md](metrics-and-validation.md). The premise is only
tested on flows created after the instrument ships, and in two steps, because
"people declare an outcome" and "people come back and record it" are different
behaviours that fail for different reasons.

Both gates count flows created after release 0.3.31, which ships the
`## Outcome criteria` slot and the `outcome-observed:` verdict line.
Historical flows are never edited and never counted.

#### G1a — after ten new flows

Over the next 10 new flows created after release 0.3.31, count the share that
declared an outcome criterion or an honest `not measured — <reason>`.

- **A meaningful share declared one** → the slot is used; continue to G1b.
- **Near zero** → **STOP.** The premise was not confirmed: the people writing
  flows do not state what they expect to change, and a queue of intents with no
  criterion has nothing to check them against.

The two shares are reported separately: flows that declared an outcome
criterion, and flows that wrote `not measured — <reason>`. They are never added
into one number, so G1a cannot be passed by writing `not measured` everywhere.

G1a is also read separately for flows created by a person and flows created by
an agent. A flow created by an agent has just read the instruction to fill the
slot, so its declaration shows that the agent complied, not that anyone wants
the outcome checked: that half is a **compliance check**, not acceptance, and
only the share of flows created by a person answers the premise. Who created a
flow is not recorded in flow.json; it is classified by hand when the ten flows
are read, and the classification is recorded next to the reading. The split of
a real criterion against `not measured — <reason>` above stays as a second axis
inside each half.

#### G1b — 2–4 weeks after those ten flows are released

G1b needs calendar time: an outcome cannot be observed before it has had time to
happen, so it cannot be brought forward by writing more flows. Two to four weeks
after the release of those 10 flows, count the share of those that declared a
criterion which then got an `outcome-observed:` line with a verdict.

- **A meaningful share was observed** → the queue is worked; continue.
- **Near zero** → **STOP.** The queue becomes a warehouse: it lists what was
  never checked and nobody checks it.

`map` (P2) is built only if both G1a and G1b pass.

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

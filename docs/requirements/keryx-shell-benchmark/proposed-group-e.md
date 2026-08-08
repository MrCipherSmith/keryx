# Proposed group E — what the current cases do not test

Status: **proposal**. Nothing here has run. Raised by the owner on 2026-08-07
after reading the A1/A3/A4 results, and the run data supports it.

## The problem with group A as written

Every group-A case is **one question, asked once, in a fresh session**. That is
the single shape in which a capable agent can brute-force its way to the answer,
and on this target it did:

| Case | The graph's answer | What an agent with no graph did |
|---|---|---|
| A1 | 24 direct dependents, 38.1 s | `naked-grok` named all 24 correctly by reading imports (220.8 s) |
| A3 | 8 cycles, 14.0 s | `naked-grok` **wrote a cycle detector** and ran it in 9.8 s |
| A4 | 14 orphans, 14.0 s | `opencode` checked the 14 and reduced them to 2 genuine ones |

The target is 267 source files and 656 edges. A model with a 220 s budget can
read a meaningful fraction of that. So group A is measuring *"can this question
be brute-forced once"* — and the honest answer is yes, for all of them.

That is a real finding about the catalog and it stays in the report. But it is
not a measurement of what a persistent graph is *for*.

## What the graph should actually buy

Three properties, none of which a single question exercises:

1. **Amortisation.** The graph is built once and queried many times. Brute force
   pays its full cost per question. One question hides this completely.
2. **Composition.** Chaining relations — blast radius, then the tests covering
   it, then which of those are unreachable — where each hop's answer is the next
   hop's input. Brute force must redo the whole traversal at every step, and its
   error compounds.
3. **Completeness at scale.** On 267 files, reading everything fits. The
   interesting question is what happens when it does not.

## The cases

| ID | Shape | Measures | What makes it fail for the unaided agent |
|---|---|---|---|
| E1 | **Eight structural questions in one session**, asked in sequence: dependents of A, cycles, orphans, tests for B, path A→B, dependents of C, what changed, repomap | Amortisation | Per-question cost is paid eight times. Watch total wall-clock and whether accuracy degrades as context fills |
| E2 | *"I am changing the signature of `<symbol>`. Which tests cover the files in its blast radius, and which of those files have no test at all?"* | Composition | Needs blast radius × test mapping × set difference. Each hop must be complete or the answer is wrong, and brute force cannot check completeness |
| E3 | **A1, A3, A4 re-run against `keryx` itself** — 649 files, 1873 edges, 2.4× the files and 2.9× the edges of `helyx` | Scale | The point where reading everything stops fitting in a budget. If the naked legs still win here, the graph's case is genuinely weak |
| E4 | *"What changed in `<file>`'s blast radius between `<commit A>` and `<commit B>`?"* | Incremental reuse | Two graphs and a diff. Brute force must reconstruct both sides from scratch |

## What each costs to build

Stated because "add four cases" is not free:

- **E1 needs a multi-turn driver.** `drive.py` submits exactly one prompt per
  session today. Sequential prompts with per-answer capture is the single
  biggest harness change on this list.
- **E2 needs a target with test intelligence populated.** `helyx` tracks
  `data/testing/context.json` at the pinned commit, so it is probably runnable —
  verify before committing to it.
- **E3 needs `keryx` prepared as a second target**: a pinned commit, a built
  graph, and the fact stated plainly in the report that **the subject is
  measuring itself**. That is not disqualifying, but it must be visible.
- **E4 needs two pinned commits** and a graph built at each.

## Order, if this is taken up

**E3 first.** It reuses cases that already exist and needs no new driver — only
a prepared target. It is also the case most likely to change the report's
conclusion, because it tests the one variable the current run holds fixed:
whether the project is small enough to read.

E1 second, since amortisation is the property most often claimed for a
persistent graph and the one least visible in what has been measured so far.

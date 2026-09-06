# Where keryx could actually win, from the run data and current practice

Written after the 2026-09-05 measurement. Everything here is grounded either in
the raw results in `data/` or in a cited source.

## The finding the means hid

The aggregate (+3.7 points, +16% tokens) reads as "no effect". The distribution
does not:

| | vantage (50) | keryx (13) |
|---|---|---|
| Same-or-better recall for **fewer** tokens | **16 (32%)** | 4 (31%) |
| Context arm burned **>1.5×** the tokens | **21 (42%)** | 5 (38%) |

**keryx is not slightly worse everywhere. It is decisively better on about a
third of tasks and expensively worse on about 40%, and the mean cancels.**

The extremes are stark. On `ba65dec8` the context arm scored 100% against 50%
using **0.13M tokens against 2.22M** — a 17× saving at double the recall. On
`97d52d1b` it scored 20% against 0% while burning **5.22M against 2.87M**.

Of the 7 vantage wins, only 3 were also cheaper. **The product is not "finds
more"; it is "sometimes finds much more for much less, and otherwise costs a
lot".**

## What the literature says, and why it predicts our result

Anthropic's own guidance describes the winning pattern as **just-in-time
retrieval**: keep lightweight identifiers, load data at runtime through tools,
with only a small core preloaded — in Claude Code, `CLAUDE.md` up front and
`glob`/`grep` on demand
([Anthropic, effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

keryx mostly follows this already — the graph and wiki are queried, not loaded.
Its deviation is narrower and, it turns out, more expensive than it looks: a
mandatory ~4,300-token entry block that is re-read every turn, plus routed tool
output that is larger per call than raw grep. The measurement shows the effect —
**identical tool calls (24.6 vs 24.6) at 16% more tokens.** Entry cost paid on
every turn, exploration not reduced. See change 3 for the arithmetic.

The second finding is that grep-style search wrapped in a good harness matches
or beats embedding retrieval on coding tasks — Claude Code moved off vector RAG
for precisely this reason
([Morph, agentic search](https://www.morphllm.com/agentic-search),
[DEV, how agents search code in 2026](https://dev.to/nimay_04/rag-is-not-always-the-answer-anymore-how-ai-agents-search-code-in-2026-43m3),
[Amazon Science at AAAI 2026 via summary](https://buzzgrewal.medium.com/ai-agents-dont-need-vector-search-anymore-inside-the-agentic-search-stack-replacing-rag-in-2026-58efcabe4f6f)).

**The control arm in our benchmark is that winning strategy.** We measured keryx
against the current state of the art, not against a weak baseline. Beating it by
ten points was always going to be hard; the honest target is different.

## Four changes, in order of expected effect

### 1. Make the failure mode cheap — the single biggest lever

42% of tasks cost >1.5× for no gain. Nothing currently tells the agent *the
graph does not know this*, so it consults context, fails, and greps anyway —
paying twice.

**Add an explicit low-confidence answer.** When a query does not resolve to a
confident file set, say so in one cheap call so the agent drops straight to
grep. Turning those 21 tasks into "grep immediately" would remove most of the
16% token penalty without touching a single win.

This is the change I would make first, and it is measurable with the harness as
it stands.

### 2. Close the description → files gap

`gdgraph affected` answers *structural* questions: what depends on this file.
The benchmark asks a *semantic* one: which files does this description touch.
**There is no path between them**, so the agent uses the graph as an expensive
second opinion after grep rather than instead of it.

Either build that path — description → candidate symbols → files, one call — or
stop claiming the graph helps with it. The pre-registration's negative result is
really a result about this missing edge.

### 3. Shrink the eager block — it is charged once per turn, not once per task

**Correction to an earlier draft of this document.** I wrote that keryx
"preloads" the graph and wiki. It does not, and the operator was right to push
back. The graph is 1.1 MB on disk under `.metaproject/data/gdgraph/` and is
reached only through CLI queries; the wiki is files, read on demand. Almost
everything in keryx is already just-in-time.

What *is* eager is small, and that is exactly why it was easy to get wrong:

| loaded before any work | tokens |
|---|---|
| `CLAUDE.md` (auto-loaded by the runtime) | ~1,069 |
| `.metaproject/index.md` (forced by the HARD GATE) | ~3,226 |
| **total** | **~4,295** |

4,295 tokens against a 210,775-token gap looks negligible. It is not, because
**an agent re-reads its entire prefix on every turn.** Measured on a live
transcript: four turns at 41,556 / 41,681 / 41,823 / 42,133 tokens, summing to
exactly the total the run reports. The prefix is charged again each turn.

So the eager block costs `4,295 × turns`:

| turns | cost of the eager block |
|---|---|
| 10 | 42,950 |
| 25 | 107,375 |
| 40 | 171,800 |

At the observed ~25 tool calls, **that alone accounts for roughly half the
measured 210,775-token gap.** The rest is larger tool outputs — routed search
and graph queries returning more per call than raw grep.

This changes the fix. It is not "stop preloading", it is **make the mandatory
entry block as small as possible**, because every token in it is multiplied by
the length of the task. The HARD GATE currently forces a 3,226-token routing
index before any work, on every task, including the many where nothing in the
workspace turns out to be relevant.

A gate that costs ~300 tokens and names where to look would carry the same
routing information at a tenth of the compounded price.

### 4. Make routed search cheaper than raw grep, not merely mandatory

The agent hook forbids raw `grep` and redirects to `keryx ctx rg`. Given the
evidence that grep-in-a-loop is the strong baseline, a wrapper must *earn* the
redirect by returning less noise per token. If it only adds a layer, it is a tax
on the strategy that wins.

## What to measure next, and it is not a rerun of this

The current benchmark asks for a **+10 point recall gain**. On this evidence
that is the wrong target — the control is state of the art and the effect is
bimodal.

**Propose instead: equal recall at materially fewer tokens.** keryx already does
this on a third of tasks. That is a claim it might win outright, and it is the
one the data supports investigating.

Three things must be fixed before any rerun, all recorded in
`results-vantage-frontend.md`:

- 17 of 50 tasks had **both** arms score zero — a third of the sample separates
  nothing.
- The wiki was never tested: the primary run had 2 boilerplate pages.
- `vantage-backend` (68 Java tasks) is ready, unrun, and would show whether any
  of this generalises across languages.

## What not to conclude

Nothing here says the graph or wiki is useless. It says that **on
description-to-file retrieval, against a grep-driven agent, preloaded context
did not pay for itself** — and that the interesting engineering problem is the
40% of tasks where it costs a great deal and returns nothing.

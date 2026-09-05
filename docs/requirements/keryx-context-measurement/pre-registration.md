# Pre-registration: does project-local context help an agent find the right files?

**Written before any run.** Everything below is fixed. Changing a threshold, a
sample size or a metric after seeing results turns a measurement into an
argument, and this file exists so that cannot happen quietly: it is committed
before the first task executes, and any later edit is a diff someone has to
justify.

**Date.** 2026-09-05. **Decided with.** the operator, over four explicit
questions.

## The claim under test

keryx asserts, in its README, its routing rules and its own research note, that
project-local context — the code graph, the wiki, the routing index — makes an
agent better at a task. Specifically that `gdgraph affected` beats grepping.

That claim has never been measured. This is the measurement.

## Design

**Task.** One merged pull request. The **query** is its subject plus the first
paragraph of its body. The **gold set** is the source files it changed.

**Arms.** Two runs of the same task, differing only in what the worktree
contains:

| Arm | Worktree |
|---|---|
| `context-on` | unmodified checkout: `.metaproject/`, `AGENTS.md`, `CLAUDE.md` present |
| `context-off` | the same checkout with those removed before the agent starts |

Both arms get the same model, the same prompt, the same budget, and the same
tools. The only difference is whether the project's own context exists.

**Isolation.** Each arm runs in its own git worktree checked out at the task's
**parent commit** — the state before the PR landed. Running at `HEAD` would let
the agent read the change it is being asked to locate, and both arms would score
100%.

**Leakage.** The gold set is never written into a worktree. `checkGoldLeakage`
(`src/metrics/leakage.ts`) runs before the agent starts and throws if any gold
artifact is still reachable. This is the existing ablation harness's mechanism,
reused rather than reinvented.

## Filters, and what they cost

Applied to candidate commits, measured on both repositories before this was
written:

| Filter | Reason |
|---|---|
| first-parent commits whose subject ends `(#N)` | a merged PR, not an intermediate commit |
| drop `chore:` / `docs:` subjects | no source-location task in them |
| gold set between 1 and 8 source files | one file makes every tool look equal; thirty makes every tool look bad |
| drop if the query text names any gold file's basename or a path segment | otherwise this measures reading, not retrieval |

**Measured yield.** vantage-frontend: 713 PR-shaped commits → 117 tasks (65
dropped chore/docs, 359 size, **172 answer-leak**). keryx before 2026-08-20: 96
→ **12**.

That answer-leak number is nearly a quarter of candidates and is the filter most
likely to be quietly dropped by someone who wants a bigger sample. It is not
optional.

## Repositories

**Primary: vantage-frontend**, 50 tasks. Private, so absent from pretraining,
and barely touched by the author of this measurement. Results cannot be
published.

**Smoke test: keryx**, 12 tasks. Enough to prove the harness runs end to end.
**Not a control** — at twelve tasks any result is equally consistent with a real
effect and with none, and it will not be reported as confirmation.

Recorded consequence: **this measurement will have no publishable independent
confirmation.** The repository whose results could be shared cannot supply
enough clean tasks without including work the author did this week.

## Metrics

- **File recall** — share of gold files the agent identified. The headline.
- **File precision** and **F1** — reported, not used for the decision.
- **Tool calls** — how much work it took.
- **Context tokens** — what it cost. Defined below, because the obvious
  definition is the wrong one.
- **Steps to first gold file** — how quickly it oriented.

### What "context tokens" means, and why the obvious answer is wrong

**Definition: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.**
Everything the model read, whether or not a cache made it cheap.

Established by measurement rather than assumption. A four-word prompt through
the headless CLI reports 2 input tokens and 4 output — beside **20,325
cache-creation and 22,616 cache-read**. The overwhelming majority of what a
model reads never appears in `input_tokens` at all.

So counting only `input_tokens` would make both arms report near-zero, the "no
greater context cost" condition would pass unconditionally, and a two-part
threshold would silently become a one-part threshold. That is not a rounding
choice; it deletes half the rule.

It also removes the specific way this measurement could flatter keryx: an arm
that pulls half the repository into context and thereby finds more files has not
demonstrated that a code graph helps. Under this definition that shows up as
cost, which is the point.

Dollar cost is recorded too, and deliberately **excluded from the rule**. Prices
change; tokens do not, and a threshold that moves with a price list is not a
threshold.

**Decided by me on 2026-09-05, not by the operator.** It was put to him twice
and he did not object; I am recording that it was my call so that nobody later
reads a shared decision where there was a unilateral one. It is reversible until
the first scored run, and after that only by re-running everything.

## The threshold, fixed in advance

**keryx wins** if `context-on` file recall exceeds `context-off` by **≥10
percentage points** at **no greater context-token cost**.

**Anything less counts as no difference.** Not "a promising trend", not
"directionally positive".

A recall gain bought with materially more context is **not** a win: spending more
tokens to find more files is available to anyone without a code graph.

## Model selection

Runs are split across Opus 5 and Sonnet 5, adaptively by task difficulty.

**The invariant:** both arms of a single task always use the same model.
Assignment is decided from the task alone, before either arm runs, and never
from anything observed during a run. A model chosen after seeing how an arm
performed would make the comparison meaningless.

## What a negative result means

If the difference is below threshold, the finding is that **project-local
context did not measurably improve file retrieval on this benchmark, for these
models, at this sample size.** It would not establish that the context is
useless — the benchmark measures retrieval, not comprehension, correctness of
the eventual patch, or the human value of a wiki someone reads.

It would mean the strongest claim in the README is unsupported, and it should be
weakened until something supports it.

Committing to that sentence now is the entire point of writing this file first.

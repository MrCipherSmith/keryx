# What actually gets loaded, and what it costs

Answers two questions from the operator, checked against the repository rather
than recalled.

## 1. The graph is not loaded. Almost nothing is.

| thing | where it lives | how the agent gets it |
|---|---|---|
| Code graph | `.metaproject/data/gdgraph/` — **1.1 MB on disk** | CLI query only (`gdgraph affected/query`) |
| Wiki | `.metaproject/wiki/**` | file reads on demand |
| Memory | `.metaproject/memory/**` | `memory search` |
| `CLAUDE.md` | repo root | **auto-loaded by the runtime, ~1,069 tokens** |
| `.metaproject/index.md` | — | **not auto-loaded, but the HARD GATE forces a read, ~3,226 tokens** |

So the eager block is **~4,295 tokens**. The rest is genuinely just-in-time,
which is the pattern the literature endorses.

## 2. Why a small block is not a small cost

**An agent re-reads its whole prefix on every turn.** Measured on a live
transcript: four turns billed at 41,556 / 41,681 / 41,823 / 42,133 context
tokens, summing to exactly the total the run reported.

Nothing is "shared" between turns in the sense of being paid once. Each turn
re-sends the conversation so far. So any token placed in context early is
charged again for every subsequent turn:

| eager block | at 10 turns | at 25 turns | at 40 turns |
|---|---|---|---|
| 4,295 tokens | 42,950 | 107,375 | 171,800 |

At the observed ~25 tool calls per task, **the mandatory entry block alone
accounts for roughly half the measured 210,775-token gap** between the arms.

This is the whole reason the operator's instinct is right: the index must be
small not because disk is precious, but because **its size is multiplied by the
length of every task.**

## 2a. "Isn't reading it once at the start enough?"

Yes — and the rule already says once. The gate reads *"Before the **first**
shell command, search, grep, file read…"*. Nothing instructs a re-read on every
model call.

**Reading once is not the same as costing once.** The read lands in the
transcript, and the transcript is re-sent on every subsequent turn. So a single
3,226-token read is billed once per turn for the rest of the task:

| main agent turns | cost of that one read |
|---|---|
| 10 | 32,260 |
| 25 | 80,650 |
| 40 | 129,040 |

There is no way to read it once and pay once. The only lever is **making it
smaller**.

### And two rules multiply the reads themselves

- *"If you create or switch to a git worktree, repeat the hard gate in that
  worktree root"* — once per worktree.
- *"Every subagent prompt must include the exact project/worktree root and
  require reading `<project-root>/.metaproject/index.md`"* — **once per
  subagent**, each then re-read across that subagent's own turns.

| shape | routing index alone |
|---|---|
| main, 25 turns | 80,650 |
| main + 3 subagents × 10 turns | **177,430** |
| main + 5 subagents × 10 turns | **241,950** |
| same, with a 300-token gate (main + 3 subagents) | **16,500** |

That last row is the point: **~11× cheaper for the same routing.**

It also cuts against the reason subagents exist. The intent is to give each one
a narrow slice of context; the rule as written makes every one of them load the
full 3,226-token index first.

## 3. `keryx orient` exists, is not installed, and currently makes this worse

`keryx orient` advertises exactly the right thing — *"inject a compact graph map
+ wiki index at turn start"*. It emits a bootstrap header, a bounded excerpt of
the index, a code-graph module map, and a wiki index. **~2,360 tokens.**

Three problems, all checkable:

1. **It is not installed here.** `keryx orient install-hook --dry-run` reports it
   *would* write `.claude/settings.json`. It was not active during the
   measurement.
2. **It installs into `UserPromptSubmit`** (`src/ctx/orient-runtimes.ts:11`) — so
   it injects on **every user prompt**, not once per session. In an interactive
   session of N messages that is N × 2,360 tokens, each copy then re-read by
   every later turn.
3. **It adds rather than replaces.** Its own text still instructs the agent to
   read `.metaproject/index.md`. So an oriented session pays 2,360 *and* 3,226.

As shipped, turning it on would increase the number this measurement found
against keryx, not reduce it.

## 4. SAC was switched off for the entire measurement

SAC is the mechanism built for precisely this problem — a bounded view of a
workspace so an agent takes only what it needs. It has the right primitive:

```
keryx workspace overview <workspace-id> [--max-items N] [--max-tokens N]
```

**An explicit token budget on a context view.** That is the shape the fix wants.

But per `.metaproject/wiki/architecture/wiki-graph-sac.md`, SAC owns *"the
bounded Facts/Work/Know-how view of this workspace, and which proposal is
waiting"* — it is a collaboration and review surface projecting Flow as Work. It
is not a retrieval index for "which files does this description touch".

And it was **off**:

- `keryx init` treats it as opt-in (`--sac`, default off).
- keryx's own workspace does not enable it.
- The benchmark provisioner never passed the flag.

So the measurement tested keryx without SAC and without `orient`. That does not
change the result — those were not part of the retrieval path being claimed —
but it does bound it: **what was measured is the graph, the wiki and the routing
index, with the two bounded-context mechanisms inactive.**

## 5. What a compact gate should look like

The current gate is a 3,226-token document containing an intent-router table,
module descriptions, a data inventory and a 27-step workflow. Most of it is
prose the agent re-reads on every turn of every task.

The version that would carry the same routing:

- **~300 tokens**, pointers only: capability → command. No prose, no worked
  examples, no numbered workflow.
- **Replaces** the mandatory index read rather than preceding it. One entry
  point, not two.
- Injected **once per session**, not per user prompt.
- Everything else reachable *from* it, on demand — which is how the graph and
  wiki already work, and they are the parts of keryx that are not the problem.

At 25 turns that is ~7,500 tokens instead of ~107,000.

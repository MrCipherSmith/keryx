# Shell system prompt trades verification for brevity

Found by the shell benchmark, run 2, case A3. Full write-up:
[findings.md](../../../docs/requirements/keryx-shell-benchmark/findings.md), P3.

## What was observed

`src/commands/shell.ts:141` sets the whole system instruction for the shell
assistant:

> "You are the keryx interactive shell assistant. Be economical with output
> tokens: lead with the conclusion, give the shortest correct answer, prefer
> bullet points over prose, and omit preamble and restated context."

It works as advertised on length — keryx answered A3 in **14.0 s** where
`opencode` on the **same model** (`deepseek-v4-flash`) took 100.6 s.

But the model applies it to more than prose. From the A1 transcript, deciding
whether to make a further tool call:

> "The instructions say be economical, but accuracy matters."

On A3 the trade-off went the wrong way. `graph_query` reported 8 import cycles;
keryx presented all 8 and stopped. `opencode` spent its extra 86 s reading the
source and found that **five of the eight run through a dynamic import**
(`bot/callbacks.ts:76`, `await import("./commands/menu.ts")`) and are therefore
not load-order cycles at all.

Same weights. Different scaffolding. The wrapped agent gave the worse answer —
because it trusted its own tool and was told to be brief.

## Why this is not a one-case curiosity

The instruction is global: it shapes every answer the shell gives. It biases
against precisely the step that would have caught the graph defect (P1), and
keryx trusts its own first-party tools more than any shell-out could. The two
compound — a confident tool plus an instruction not to spend tokens checking it.

## The shape of the fix

Not a wording tweak. Three properties the instruction has to end up with:

1. **Economy governs output length, not tool-call budget.** The current sentence
   conflates two independent axes, and the model resolves the conflation by
   spending fewer tool calls.
2. **A first-party tool result is not automatically ground truth.** Say when a
   cheap check against source is worth its tokens — specifically when the tool's
   answer *is* the deliverable rather than an input to it.
3. **Keep the brevity.** 14 s against 100 s is a real advantage and a real
   product decision. The fix is to stop brevity from paying for itself with
   correctness, not to abandon it.

Coordinate with **P1** (`gdgraph` counting `await import()` as an ordinary edge):
fixing the graph removes this particular wrong answer, but not the disposition
that let it through unchecked. Both are needed.

## Regression material, already available

A3 on `helyx` at `bfad745b` is a case where the first-party tool returns a
known-wrong answer (8 cycles, 5 of them dynamic). That makes it a usable
regression test for this flow, not just an anecdote.

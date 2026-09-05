# Results: keryx, 13 tasks, 2026-09-05

Run under the pre-registration in this directory, unchanged since before the
first task executed. Secondary sweep — see `pre-registration.md` for why it is
not a control.

## Headline

**Project-local context did not improve file retrieval on this benchmark, for
these models, at this sample size. It cost 32% more context to reach a slightly
lower recall.**

| | `context-on` | `context-off` |
|---|---|---|
| File recall (mean) | **80.3%** | **82.9%** |
| Context tokens (mean) | 1,272,685 | 960,592 |
| Dollar cost (mean) | $1.00 | $0.95 |
| Tool calls (mean) | 21.1 | 22.6 |
| Steps to first gold file (mean) | 5.1 | 3.8 |

**Verdict by the pre-registered rule: fails both conditions.** Recall gain is
**−2.6 points** against a threshold of +10, and the context cost is higher, not
equal or lower.

## The per-task breakdown, which is harsher than the means

**`context-on` won 0 of 13 tasks.** Twelve ties, one loss.

| task | model | gold | recall on/off | tools on/off | ctx tokens on/off | first-gold on/off |
|---|---|---|---|---|---|---|
| `a281610b` | sonnet-5 | 2 | 100% / 100% | 25/3 | 1,568,637 / 186,915 | 7/3 |
| `e3bfa56e` | sonnet-5 | 2 | 50% / 50% | 3/2 | 202,521 / 138,590 | 2/2 |
| `1ee858c9` | sonnet-5 | 3 | 100% / 100% | 19/18 | 1,352,634 / 1,158,627 | 4/2 |
| `27c7c1a8` | sonnet-5 | 2 | 50% / 50% | 18/11 | 1,121,808 / 603,639 | 4/3 |
| `1eb16935` | opus-5 | 5 | 100% / 100% | 21/29 | 763,231 / 1,235,517 | 4/4 |
| `e1c0057a` | sonnet-5 | 3 | 67% / 67% | 18/23 | 1,158,671 / 1,327,887 | 4/6 |
| `353c740a` | sonnet-5 | 3 | **67% / 100%** | 25/15 | 1,692,296 / 924,921 | 9/2 |
| `fbaf31bb` | sonnet-5 | 2 | 50% / 50% | 16/25 | 1,080,453 / 1,911,075 | 5/3 |
| `8e662dd7` | opus-5 | 7 | 86% / 86% | 31/29 | 2,108,364 / 1,815,823 | 5/5 |
| `1567c9f9` | sonnet-5 | 2 | 100% / 100% | 33/79 | 2,598,805 / 95,136 | 6/8 |
| `4cdc282f` | opus-5 | 5 | 100% / 100% | 28/31 | 1,106,094 / 1,684,304 | 1/2 |
| `a9211d9c` | sonnet-5 | 2 | 100% / 100% | 14/15 | 840,098 / 795,311 | 13/7 |
| `b6b4ed06` | opus-5 | 4 | 75% / 75% | 23/14 | 951,292 / 609,951 | 2/3 |

A mean gap of 2.6 points could be one unlucky task. **Zero wins in thirteen
cannot be.** If the context helped anywhere, some task should have shown it.

`context-on` uses slightly *fewer* tool calls and substantially more tokens: it
makes fewer, larger reads. That is the shape of paying a fixed entry cost —
routing index, skills catalog, wiki — and then arriving where the control arm
arrives by grepping.

## Integrity checks, which is why these numbers can be read at all

- **13 of 13 tasks completed. Zero failures.**
- **No control arm built itself a graph.** `inventoryAfter.hasGraphDb` is false
  for all 13. The `keryx` binary is on PATH for both arms by design, so this was
  a live possibility that would have diluted the effect invisibly.
- **All 13 context arms held a real wiki** — 51 pages, from the checkout, at the
  parent commit. This is not a run where the context failed to load. It loaded
  and did not help.
- Both arms ran with identical argv and no MCP servers.
- The commit under test was unreachable from every tree.

### Two numbers that looked wrong, and were checked

`1567c9f9`'s control arm reports 79 tool calls against 95,136 context tokens,
while its context arm reports 33 calls against 2,598,805. Checked rather than
explained away: **tool calls are not turns.** A single turn can carry a batch of
parallel `Bash` calls, so 79 calls across a few small turns is consistent.

The `result` event's `usage` is also not the sum of the per-message usages in
the stream — measured ratio 0.572. The stream emits most assistant messages
twice; deduplicating them sums to **exactly** the result event's total. So
`contextTokensOf` reports what the pre-registration defines, and `toolCalls` is
not double-counted — the duplicate events carry usage but no `tool_use` blocks.

## What this does and does not establish

**Does not:** thirteen tasks is underpowered, and this is one repository, one
task type, and two models. It says nothing about whether a wiki helps a person,
whether the graph helps on tasks other than file retrieval, or whether the
eventual patch is better.

**Does:** on the task keryx's README most directly claims — locating the right
files from a description — the context did not help here, and it was not close.
The claim that `gdgraph affected` beats grepping is not supported by this run.

The primary sweep on vantage-frontend decides whether that generalises.

## Cost, and a correction

**Actual spend: $25.36** ($13.02 `context-on`, $12.34 `context-off`).

I estimated ~$6 to the operator beforehand. That was **four times low**, and the
error is instructive: I extrapolated from the smoke run, which had been executed
against a broken harness — no graph in the context arm, 59 MCP tools present,
and a different tool roster. Those numbers should not have been used for
anything, including a cost estimate, and I used them anyway.

Revised estimate for the 50-task primary sweep at the observed per-task rate:
**~$100, not the $45 previously quoted.**

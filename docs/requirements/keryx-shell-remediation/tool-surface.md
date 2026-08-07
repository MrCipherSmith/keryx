# Phase 4 — the tool surface
Version: 1.0.0

## The finding that changes P1

`graph_affected` accepts **`{ file: string }` and nothing else**
(`src/harness/tool/metaproject-operations.ts:416-435`). The CLI it wraps accepts
`--depth N` and `--ranked`.

A1 asked for dependents **"directly and transitively"**. The native tool cannot
express that question. So when the model called
`shell_exec("keryx gdgraph affected config.ts --depth 2")`, it was not ignoring a
better path — **it was taking the only path that could answer.**

That reverses the reading in the run report and in the review. D1 has three
layers, and the first one exonerates the model:

| Layer | Statement | Fix |
|---|---|---|
| **1. Capability** | The native tool is strictly weaker than the CLI it wraps. The question asked was unanswerable through it | Give the tool the CLI's parameters |
| **2. Instruction** | `agent.ts:244` tells the model to prefer `shell_exec` for "a known keryx workflow" | Remove the contradiction |
| **3. Advertisement** | Two system prompts list different tool sets | Reconcile with the registry |

**Consequence for P1's acceptance:** AC-P1-1 requires a correct answer to A1 with
no human, and AC-P1-2 requires no `shell_exec` of `keryx gdgraph`. **Neither can
pass until `graph_affected` accepts a depth.** Layer 1 is therefore a dependency
of Phase 1, not a nice-to-have that follows it.

## The wider gap

Every capability below is reachable from the CLI and has **no tool at all**, so
an agent asked the corresponding question must round-trip through a default-deny
shell:

| Question the workspace exists to answer | CLI | Tool | Benchmark case |
|---|---|---|---|
| What breaks, transitively / ranked? | `gdgraph affected --depth --ranked` | partial — no depth | **A1** |
| Where does this concept live? | `gdgraph find` | none | A2 |
| How do these two files connect? | `gdgraph path` | none | — |
| Callers of this symbol, by impact? | `gdgraph symbol --impact --depth` | partial | A2 |
| Give me a repo map in N tokens | `gdgraph repomap --budget` | none | **A9** |
| Which tests cover my change? | `test analyze` / related | none | **A8** |
| What is in bad shape, and why? | `health run` / `health explain` | none | **A10** |

Seven of the eleven group-A cases — the group that exists to demonstrate the
product's central claim — **cannot be answered through the tool surface today.**
The benchmark was going to measure that repeatedly and attribute it to the model.

## P4.1 — parameter parity

Every metaproject tool accepts the parameters its CLI accepts. Starting with
`graph_affected` gaining `depth` and `ranked`, because A1 depends on it.

Rule worth writing into the contract: **a tool that wraps a CLI verb exposes that
verb's arguments.** A tool weaker than its own CLI teaches the model to bypass it,
and the model is right to.

## P4.2 — the missing tools

`graph_find`, `graph_path`, `repomap`, `tests_related`, `health_report`. Each
already has a service behind it; this is registry and schema work, not new
capability.

## P4.3 — one composite call for the common question

The evidence for this is in the transcripts. To answer A1, `baseline-grok` made
roughly six calls: `gdgraph find`, `affected`, `affected --depth 2`,
`affected --depth 10 --ranked`, plus `ctx rg` twice. Each round trip carries a
model turn — and the model's thinking between calls, not the tool, is where the
seconds go. keryx's own leg burned 62,000 tokens of context and never arrived.

A single `project_impact { target, depth?, include? }` returning symbol
definition, affected set at depth, ranked hot spots, related tests and the health
of the touched files collapses that sequence into one call. It is a composition
of services that already exist and already run in milliseconds.

**This is the honest speed argument.** Not "our graph is faster than ripgrep" —
A1 showed a strong model rebuilds the graph in seconds. It is that **the answer
is already computed and stored, so the model should need one turn instead of
six.** That claim is measurable, and the metric already exists in the rubric:
`tool_calls` and `steps`.

## P4 acceptance criteria

| # | Criterion |
|---|---|
| AC-P4-1 | `graph_affected` accepts `depth` and `ranked`, and A1 is answerable without any shell call. |
| AC-P4-2 | No metaproject tool accepts a strict subset of its CLI verb's arguments; a test enumerates the pairs. |
| AC-P4-3 | `graph_find`, `graph_path`, `repomap`, `tests_related` and `health_report` are registered, advertised in both system prompts, and covered by tests. |
| AC-P4-4 | `project_impact` answers A1 in **one** tool call; the re-run records `tool_calls` for it against the multi-call baseline. |
| AC-P4-5 | Every new tool is `risk: "read"` and needs no approval, so none of this reintroduces the stall P1 removed. |

## Ordering

P4.1 is a **dependency of P1** — pull it into that flow. P4.2 and P4.3 are their
own flow, after P1, before the P3 re-run so the re-run measures the fixed surface.

Revised flow count: still three, with P4.1 absorbed into flow 1 and P4.2/P4.3
replacing what was flow 2's slack.

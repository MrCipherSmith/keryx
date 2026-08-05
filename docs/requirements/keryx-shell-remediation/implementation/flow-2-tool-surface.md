# Flow 2 — the tool surface
Version: 1.0.0

Covers P4.2 and P4.3. Runs after flow 1, because AC1 there establishes the
parameter-parity rule this flow applies five more times.

This is the flow that answers "make keryx faster". Not by making the graph
faster — it already answers in milliseconds — but by removing the round trips
between the model and an answer that is already computed and sitting on disk.

## Flow setup

```bash
keryx flow init --title "The tool surface: every group-A question has a tool, and the common one takes a single call"
```

```bash
keryx flow task add <id> --title "T1 graph_find tool" --kind implement
keryx flow task add <id> --title "T2 graph_path tool" --kind implement
keryx flow task add <id> --title "T3 repomap tool with a token budget" --kind implement
keryx flow task add <id> --title "T4 tests_related tool" --kind implement
keryx flow task add <id> --title "T5 health_report tool" --kind implement
keryx flow task add <id> --title "T6 project_impact composite" --kind implement
keryx flow task add <id> --title "T7 tests and prompt/registry agreement" --kind test
keryx flow task add <id> --title "T8 docs and draft PR" --kind review
keryx flow freeze <id> && keryx flow start <id>
```

## Acceptance criteria — paste verbatim

```
- AC1: `graph_find` is registered, answers "where does this concept live" from the graph, and is covered by a test.
- AC2: `graph_path` is registered, returns the shortest path between two files or symbols, and is covered by a test.
- AC3: `repomap` is registered, accepts a token budget, respects it, and is covered by a test asserting the budget is not exceeded.
- AC4: `tests_related` is registered, returns the tests related to a changed file from the testing context, and is covered by a test.
- AC5: `health_report` is registered, returns the health signals for a scope, and is covered by a test.
- AC6: Every tool added here is `risk: "read"` and requires no approval, so none of them reintroduces the stall flow 1 removed. A test asserts the risk class of each.
- AC7: `project_impact` is registered and accepts `{ target, depth?, include? }`. For a target with transitive dependents it returns, in ONE call: the symbol or file identity, the affected set at the requested depth, ranked hot spots, related tests, and the health of the touched files.
- AC8: `project_impact` composes existing services and adds no new computation of its own. A test asserts each section matches what the individual tool returns for the same input.
- AC9: Benchmark case A1 is answerable with `tool_calls: 1` using `project_impact`, and the run record shows it. The multi-call figure from the 2026-08-05 run is cited alongside for comparison.
- AC10: Both system instructions and the registry advertise the new tools; the agreement test from flow 1 still passes.
- AC11: Every new tool exposes the arguments its wrapped CLI verb exposes — the parity rule from flow 1, applied here. A test enumerates the pairs.
- AC12: `bun run check` and `bun run check:doc-links` pass; no test skipped or weakened.
- AC13: `docs/docs/harness.md` documents the new tools, and states plainly that `project_impact` is a composition, not a new analysis.
```

## Why `project_impact` is the speed claim

From `evidence/transcripts/A1-baseline-grok.txt`, answering one blast-radius
question took roughly six calls: `gdgraph find`, `affected`, `affected --depth 2`,
`affected --depth 10 --ranked`, and `ctx rg` twice. Every round trip carries a
model turn, and the model's thinking between calls is where the seconds are — the
tools themselves return in milliseconds.

keryx's own leg spent 62,000 tokens of context on that question and never
arrived.

So the measurable claim is **turns, not throughput**: the answer is already
computed and stored, so the model should need one call instead of six. The rubric
already collects `tool_calls` and `steps`, so this is verifiable without any new
instrumentation.

What this claim is **not**: "our graph is faster than ripgrep". A1 showed
`naked-claude` reconstructing the reverse-dependency graph in 72 seconds. Do not
write that claim anywhere.

## Definition of done

AC1–AC13 confirmed with evidence, draft PR, review, merge, `flow complete`.

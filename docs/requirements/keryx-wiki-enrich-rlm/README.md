# Wiki-Enrich RLM Notes

Status: **PRD drafted (2026-08-18), pre-implementation.** See [prd.md](prd.md) for
the formal requirements (goals, non-goals, functional/non-functional requirements,
constraints, edge cases, Gherkin acceptance criteria, verification plan). This
README remains the running notes/discovery log behind that PRD — keep appending
reasoning here as scope evolves; the PRD should be revised to match, not forked.

## Origin

Discussion started 2026-08-14 to 2026-08-18 while evaluating local LLMs for the
`arena` project, sparked by a screenshot about Qwen3.8-27B and a detour into RLM
("Recursive Language Models", Zhang/Kraska/Khattab, MIT CSAIL, arXiv:2512.24601).

Core RLM idea: instead of stuffing a huge context into one LLM call (causing
"context rot"), keep large data accessible to *code* (a REPL/script) and have the
orchestrating model programmatically query/slice it, recursively delegating pieces
to smaller LLM calls — only compact synthesized results flow back into the
top-level model's context.

## Why Keryx, why wiki-enrich

Conclusion from the discussion: RLM's real edge is the "first mile" — ingesting and
synthesizing a large volume of data into a compact answer (search, comprehension,
architecture summarization). It does **not** meaningfully boost the actual
code-writing step, which is bottlenecked by precision on a small area plus a
verification loop (tests/linters), not by context volume. So the natural fit inside
Keryx is not the coding harness itself, but the **wiki generation/enrichment
pipeline**, which is exactly a "digest a lot of graph/code data into a compact page"
problem.

## Current-state findings (code-explorer pass, 2026-08-18, read-only)

- **`src/gdgraph/`** (build.ts, symbol.ts, pagerank.ts) — 100% deterministic,
  zero LLM calls, pure tree-sitter/AST parsing. The graph already lives as files on
  disk (`.metaproject/data/gdgraph/storage/*.jsonl`) and is only ever touched
  programmatically (`gdgraph query/find/path`) — this is already "half of RLM" by
  construction.
- **`src/gdgraph/repomap.ts`** (`computeRepomap`, ~line 111) already has a
  token-budget mechanism: ranks nodes by personalized PageRank, greedily appends
  until `config.repomap.tokenBudget` (default 8000, `chars/4` estimator) is hit,
  then hard-truncates. Static one-shot slice, not adaptive/queryable.
- **`src/wiki/collect.ts`** — also deterministic, hard caps everywhere (top-6 key
  files, top-8 related, etc.). No LLM.
- **`src/wiki/enrich.ts`** — the **only** LLM call site in the whole graph/wiki
  pipeline. `wikiEnrich` (~line 617) runs a concurrency-capped worker pool
  (default concurrency 1, ceiling 8, `DEFAULT_MAX_OUTPUT_TOKENS=8192`) and calls
  `runModelTurn` **once per page**, with only that page's already-templated
  markdown as input — never raw source. Low context-rot risk, but also low depth:
  the model can only restate graph-derived facts it's handed, it cannot dig deeper
  into actual code behavior.
- Critically, this call goes through **`src/harness/provider/single-turn.ts`**,
  which states explicitly: *"No tools, no policy loop."* Architecturally incapable
  of tool-calling or recursion as-is.
- **`src/wiki/ask.ts`** — not an LLM call at all. Deterministic Jaccard lexical
  retrieval + optional embedding rerank, citation-list assembly. Retrieval-only.
- **`.metaproject/skills/gdwiki/SKILL.md`** (~lines 66-128) already describes a
  manual, agent-driven workflow that mirrors RLM/map-reduce in spirit — one
  subagent per page, orchestrator doesn't read code or write prose itself — but
  this lives outside Keryx's own code; it depends on whatever external agent runs
  the skill.

## Proposed insertion point (not yet decided/scoped)

`wiki/enrich.ts`'s prose-writing step. Mostly reuse, not new build — Keryx's own
`src/harness/*` already has the needed primitives, just not wired to wiki-enrich:

- `src/harness/tool/builtin/shell-exec-tool.ts` — sandboxed shell exec, usable as
  the "REPL" (could run `gdgraph query/find/path` on demand).
- `src/harness/tool/builtin/spawn-subagent-tool.ts` + `src/harness/child/*` —
  budget/policy inheritance, provenance, canonical-result parsing. A ready-made
  recursive sub-call primitive.
- `src/harness/tool/builtin/metaproject-tools.ts` /
  `src/harness/tool/metaproject-operations.ts` — tools for reading
  `.metaproject` graph/wiki data from inside a model turn.

Sketch: reroute the wiki-enrich orchestrator off `single-turn.ts` onto the full
harness, spawn one bounded child subagent per page/module via
`spawn-subagent-tool`, give it `shell-exec-tool`/`metaproject-tools` access so it
pulls graph context on demand instead of trusting only the pre-capped "Key files"
list. Storage layer needs no change — already file-based and code-queryable.

## Open questions

- Cost/latency: is per-page subagent spawning worth it given `wiki/enrich.ts`
  already runs a worker pool over many pages — does recursion multiply LLM calls
  too much for marginal quality gain?
- Where's the actual quality ceiling today? Need concrete before/after examples of
  a wiki page that's shallow under the current pipeline vs. one enriched with
  on-demand graph digging, before committing scope.
- Does this want a new `wiki.config.json` (doesn't exist today) to hold RLM-specific
  knobs (recursion depth, sub-agent budget, concurrency), separate from
  `gdgraph.config.json`?
- Should `wiki/ask.ts` (currently retrieval-only) also get a synthesis step, or is
  that explicitly out of scope for this package?

## Token/latency economy levers (2026-08-18)

Framing: for a local model, "saving tokens" and "enabling a local model" are the
same problem viewed from two sides — a local model's token cost is ~free in dollars
but every call costs real wall-clock on the arena CPU box (~12 tok/s, no GPU, see
arena project's hardware notes). So the goal isn't just fewer tokens per call, it's
fewer and cheaper calls, period.

1. **Cheap non-LLM gate before spending any model call.** Not every page needs a
   "deep" LLM pass — a trivial module is already well served by the deterministic
   `collect.ts` template with zero LLM cost. Add a heuristic filter (module size,
   graph complexity, PageRank) to decide which pages get the expensive path and
   which stay template-only.
2. **Batch related pages instead of one call per page.** `wiki/enrich.ts` currently
   pays the fixed system-prompt overhead (~lines 143-157) on every single call. If
   sibling pages of one module are grouped into one call, that overhead is paid
   once per group instead of once per page.
3. **On-demand graph queries instead of pre-baked over-fetch — the actual RLM part.**
   Today the template pre-stuffs facts (top-6 key files, top-8 related, etc.)
   whether or not the page needs them. Give the subagent `shell-exec-tool` access to
   `gdgraph query/find/path` so it pulls exactly what it needs and stops, instead of
   always paying for the full pre-fetched bundle.
4. **Flat map-reduce, not deep recursion.** Cap at one subagent level per
   module, then a single top-level assembly — no nested recursion — to keep call
   count and latency bounded on weak local hardware.
5. **Incremental re-enrichment via `staleness.ts`.** Only re-run the LLM path for
   pages whose underlying graph nodes actually changed since the last enrichment
   pass, not the whole wiki on every run.

## Next step

Keep appending reasoning here. Once scope feels solid, run through
`brd-creator` / `gproject-orchestrator` to produce a proper BRD/PRD.

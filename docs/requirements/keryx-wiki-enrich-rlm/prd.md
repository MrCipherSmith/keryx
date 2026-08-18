# PRD: RLM-Style Recursive Enrichment for Keryx Wiki

## 1. Overview

Replace `wiki/enrich.ts`'s current single-shot, tools-less, template-only LLM call
per page with an optional recursive, tool-enabled enrichment path (the RLM
pattern) that lets the model query the code graph on demand, batches related
pages, and skips the LLM entirely for pages a cheap heuristic judges as already
well served by the deterministic template. Goal: cut both the number of LLM
calls and the tokens per call so a full wiki-enrich pass becomes practical to
run routinely against a slow, local, CPU-only model — not just a well-resourced
cloud API.

## 2. Context

- **Product:** Keryx Current (`.metaproject/` workspace CLI)
- **Module:** `src/wiki/` (enrichment), `src/gdgraph/` (symbol graph), `src/harness/`
  (agent execution primitives: tool-calling, subagent spawning, budget/policy)
- **User Role:** Keryx maintainer/operator running wiki enrichment against a real repo
- **Tech Stack:** TypeScript/Bun, tree-sitter-based static graph stored as
  `.jsonl`, existing agent harness with tool-calling and subagent spawning
  already implemented, local (e.g. Ollama-served) and/or cloud LLM backends

## 3. Problem Statement

`wiki/enrich.ts` (`wikiEnrich`, ~line 617) calls `runModelTurn` once per page
through `src/harness/provider/single-turn.ts`, which explicitly documents "No
tools, no policy loop." As a result, today's pipeline:

- **Always fires an LLM call**, even for pages the deterministic
  `wiki/collect.ts` template already covers adequately.
- **Cannot dig deeper into real code.** Each call is fed only a pre-baked,
  hard-capped template (top-6 key files, top-8 related pages, etc. from
  `collect.ts`) and can never query the graph for more, even when a page would
  clearly benefit from it.
- **Re-pays a fixed cost per page.** The system prompt (~lines 143-157) is
  re-sent on every single call with no batching of related pages.
- **Has no staleness awareness at the enrichment layer**, so a full rebuild
  re-spends the same LLM budget on pages whose underlying graph nodes never
  changed (even though `src/gdgraph/staleness.ts` already exists and could
  answer "did this change?").

Net effect: enrichment cost (in $ for a cloud model, or wall-clock for a local
one) scales linearly with page count regardless of actual need, which makes
routine, full enrichment impractical on a slow local CPU-only target (reference
hardware: 8-core AMD Ryzen, no discrete GPU/CUDA, ~12 tok/s) and depth-limited
even when a cloud model is used.

## 4. Goals

- Reduce total LLM calls per full wiki-enrich run via a pre-LLM classification
  gate, batching of related pages, and staleness-aware skipping.
- Reduce input tokens per call by replacing "always pre-fetch everything" with
  on-demand graph queries issued by the model itself.
- Make enrichment depth adaptive: pages that need real code understanding get a
  bounded, tool-enabled pass; pages that don't stay on the current cheap path.
- Keep worst-case call count and latency bounded and predictable on weak local
  hardware — flat map-reduce, not unbounded recursion.
- Preserve today's output as the default/fallback so this is additive and
  opt-in, not a breaking change for existing users of `wiki enrich`.

## 5. Non-Goals

- Changing `src/gdgraph/*` — it is already deterministic and out of scope; no
  LLM involvement is introduced there.
- Changing `src/wiki/ask.ts` — it is retrieval-only today; whether it should
  gain a synthesis step is an open question logged separately and explicitly
  deferred, not decided by this PRD.
- Selecting or bundling a specific local model — this PRD defines the
  mechanism; model choice remains a deployment-time configuration concern.
- Nested recursion (a `deep`-path subagent spawning further subagents) —
  explicitly excluded for latency predictability. Flat, one level only.
- A new distributed/queue execution model — the existing worker pool
  (`mapPool`) concurrency mechanism is reused as-is, not replaced.

## 6. Functional Requirements

- **FR-1:** A pre-LLM classification gate MUST run for every candidate page
  before any model call, producing a decision in `{skip, light, deep}` based on
  cheap, non-LLM signals already available from the graph (module/page size,
  graph complexity or PageRank, and staleness per `src/gdgraph/staleness.ts`).
- **FR-2:** Pages classified `deep` MUST be enriched via a bounded child
  subagent spawned through `spawn-subagent-tool`, granted `shell-exec-tool`
  scoped to read-only graph queries (`gdgraph query/find/path`) plus
  `metaproject-tools` for reading `.metaproject` wiki/graph data — not
  arbitrary shell access.
- **FR-3:** Pages classified `light` MUST continue through the existing
  `single-turn.ts` path unchanged — this is the preserved default behavior.
- **FR-4:** Pages classified `skip` MUST bypass any LLM call entirely; final
  content is the `collect.ts`-generated template as-is.
- **FR-5:** Sibling pages of the same module MAY be batched into a single
  `light`-path call (amortizing the fixed system-prompt cost) when their
  combined estimated size stays under the existing `repomap.ts` token-budget
  mechanism.
- **FR-6:** `deep`-path subagents MUST be flat — a `deep` subagent MUST NOT be
  permitted to spawn further subagents.
- **FR-7:** Re-running wiki-enrich MUST skip any page whose underlying graph
  nodes are unchanged since its last successful enrichment (via
  `staleness.ts`), regardless of classification tier.
- **FR-8:** Classification thresholds, batching, and the RLM path MUST be
  configurable (enable/disable, thresholds) via a new `wiki.config.json` (or an
  added section of an existing config, implementer's choice). Default
  configuration MUST reproduce today's behavior with RLM mode disabled.
- **FR-9:** Every `deep`-path subagent call MUST record its tool calls and
  token usage via the harness's existing provenance mechanism, so per-page cost
  is auditable.

## 7. Non-Functional Requirements

- **NFR-1:** With RLM mode enabled at default thresholds, a full run over a
  reference repo MUST issue fewer total LLM calls than today's one-call-per-page
  baseline. Exact numeric target is deferred to a baseline measurement (see
  Verification) — not fixed by this PRD.
- **NFR-2:** `deep`-path subagent calls MUST have an enforced token/tool-call
  budget, reusing the harness's existing budget/policy inheritance, to bound
  worst-case per-page latency.
- **NFR-3:** The feature MUST function against a local CPU-only backend (no
  GPU/CUDA assumption) without requiring changes to the harness's provider
  abstraction — it only uses primitives that already exist.
- **NFR-4:** With RLM mode disabled, output MUST be unchanged from current
  `wiki/enrich.ts` behavior — no silent change to existing users' wikis.

## 8. Constraints

- Must build on existing `src/harness/*` primitives (`spawn-subagent-tool`,
  `shell-exec-tool`, `metaproject-tools`) rather than introducing a new
  agent-execution mechanism.
- Must not modify `src/gdgraph/*` storage format or query surface.
- `shell-exec-tool` access granted to `deep` subagents must be scoped to
  read-only graph queries — no general filesystem write access, consistent with
  the read/write boundary already described in
  `.metaproject/skills/gdwiki/SKILL.md`.
- Recursion depth is hard-capped at one level (FR-6) — a design constraint, not
  merely a default.

## 9. Edge Cases

- **First run, no prior enrichment:** staleness check (FR-7) must treat "never
  enriched" as stale, never as skippable.
- **Misclassification:** the classification gate under-calls a page that
  actually needed `deep` treatment. Mitigation: the existing manual,
  skill-driven workflow (`.metaproject/skills/gdwiki/SKILL.md`) remains
  available as a manual override/escape hatch.
- **Budget exhaustion:** a `deep` subagent exhausts its token/tool-call budget
  mid-page. It must fall back to its best partial result or the deterministic
  template — the overall enrich run must never fail because one page's budget
  ran out.
- **Batch overflow:** a batched `light` group (FR-5) exceeds the token budget
  mid-batch. The batch must split rather than silently truncate a page —
  re-using `repomap.ts`'s existing truncate-with-marker fallback, not a new
  mechanism.
- **No config present:** absent `wiki.config.json` (FR-8 default) must fall
  back to today's single-turn, one-call-per-page, no-batching behavior — full
  backward compatibility.

## 10. Acceptance Criteria (Gherkin)

```gherkin
Scenario: Trivial page skips the LLM entirely
  Given a page whose module is below the size/complexity threshold
    configured in wiki.config.json
  When wiki-enrich runs
  Then no LLM call is made for that page
  And the page content equals the collect.ts-generated template

Scenario: Complex page gets a deep, tool-enabled pass
  Given a page whose module exceeds the deep-classification threshold
  When wiki-enrich runs
  Then a bounded child subagent is spawned via spawn-subagent-tool for that page
  And the subagent has access to shell-exec-tool scoped to gdgraph query/find/path
    and to metaproject-tools
  And the subagent does not spawn further subagents

Scenario: Unchanged page is skipped on re-run
  Given a page was successfully enriched in a prior run
  And its underlying graph nodes are unchanged since that run
  When wiki-enrich runs again
  Then no LLM call is made for that page
  And its existing enriched content is preserved

Scenario: RLM mode disabled preserves current behavior
  Given wiki.config.json has RLM mode disabled or is absent
  When wiki-enrich runs
  Then every page gets exactly one single-turn LLM call, as today
  And output is unchanged from the pre-RLM baseline

Scenario: Deep subagent exceeds its budget
  Given a deep-classified page's subagent reaches its configured
    token/tool-call budget before completing
  When the budget is exhausted
  Then the enrich run does not fail
  And the page falls back to its deterministic template content
    (or the subagent's best partial output) rather than aborting the run
```

## 11. Verification

- Unit/integration tests for the classification gate (FR-1) against fixture
  graphs of varying size, complexity, and staleness.
- Integration test asserting `deep` subagents cannot spawn further subagents
  (FR-6) — assert on harness call depth or an explicit policy check.
- Regression test asserting byte-for-byte output parity with the current
  `wiki/enrich.ts` when RLM mode is disabled (NFR-4).
- Before/after LLM-call-count measurement on a reference repo — Keryx's own
  repo is the natural dogfood target, consistent with the existing
  `keryx-benchmark-suite` dogfooding convention — to set and validate a
  concrete NFR-1 numeric target (deliberately left open by this PRD).
- Manual/qualitative before-after comparison of a handful of `deep`-classified
  pages' prose depth vs. the current baseline, to confirm the added subagent
  cost is actually justified by a quality gain (the open question already
  logged in this package's notes).
- Token/latency measurement on the reference CPU-only hardware target (8-core
  AMD Ryzen, no GPU, ~12 tok/s) to confirm NFR-2/NFR-3 budgets hold in
  practice, not just in theory.

# RLM wiki-enrich: classify gate + deep subagent path + batching + per-page staleness

Status: frozen at flow start
Source: `docs/requirements/keryx-wiki-enrich-rlm/prd.md` (upstream requirements) +
`docs/requirements/keryx-wiki-enrich-rlm/trd.md` (technical design, grounded against
current code 2026-08-18)

## Problem

`src/wiki/enrich.ts`'s `wikiEnrich()` calls `runModelTurn` (`single-turn.ts`, "No tools, no
policy loop") once per selected page, unconditionally, through a fixed template with no
graph access and no per-page change awareness. This means:

- Every page pays a full LLM call even when the deterministic `collect.ts` template would
  already be adequate.
- No call can dig into the actual code graph beyond the pre-baked, hard-capped fields
  `collect.ts` bakes in (top-6 key files, top-8 related, etc.).
- The fixed system-prompt cost is re-paid per page, with no batching of sibling pages.
- A full re-run re-spends the same LLM budget on pages whose underlying graph nodes never
  changed, even though nothing in the pipeline tracks that per page today.

Net effect: enrichment cost scales linearly with page count regardless of actual need,
which is impractical to run routinely on a slow local CPU-only model (reference: 8-core AMD
Ryzen, no GPU, ~12 tok/s) and depth-limited even on a well-resourced cloud model.

## Expected Outcome

- A pre-LLM classification gate (`skip` / `light` / `deep`) runs for every selected page
  before any model call, using cheap graph-derived signals (page size, PageRank/fan-in,
  per-page staleness).
- `deep`-classified pages get a bounded, flat (non-recursive) child turn with read-only
  access to the code graph (`graph_query`, `graph_path`, `graph_symbol`, `graph_affected`,
  `repomap`, `read_wiki` — the existing `metaproject-operations.ts` descriptors, never
  `shell_exec_tool`), reusing the harness's existing `spawnSubagent`/`runAgentTurn`
  primitives directly (not the interactive `spawn_subagent` tool, which has no caller in a
  batch CLI).
- `light`-classified pages keep going through the existing unchanged `single-turn.ts` path,
  optionally batched with sibling pages of the same module.
- `skip`-classified pages bypass the LLM entirely; output is the `collect.ts` template as-is.
- Re-running `wiki enrich` skips any page whose underlying graph nodes are unchanged since
  its last successful enrichment, regardless of classification tier (extends
  `enrich-resume.json` with `completedNodeHashes`, since `gdgraph/staleness.ts` is repo-wide
  only and cannot answer this per page).
- Everything above is gated by `.metaproject/wiki.config.json`, `rlm.enabled`, defaulting to
  `false` — with RLM mode disabled or the config absent, output is byte-for-byte identical
  to today's `wikiEnrich` behavior (no breaking change for existing users).

## Out of Scope (per PRD Non-Goals)

- Changing `src/gdgraph/*` internals, storage format, or query surface.
- Changing `src/wiki/ask.ts` (retrieval-only today; a synthesis step there is explicitly
  deferred, not part of this flow).
- Selecting/bundling a specific local model — this flow builds the mechanism only.
- Nested recursion — a `deep` child MUST NOT spawn further subagents (enforced by the tool
  grant containing no `spawn_subagent`-equivalent capability, not by a runtime depth check).
- A new distributed/queue execution model — the existing `mapPool` concurrency mechanism in
  `enrich.ts` is reused as-is.

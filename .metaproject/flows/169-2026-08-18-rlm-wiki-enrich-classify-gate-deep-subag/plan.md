# Implementation Plan

Status: adopted from TRD (`docs/requirements/keryx-wiki-enrich-rlm/trd.md`) — architecture
already resolved through code grounding, not a fresh brainstorm.

## Approach

Additive changes inside the existing `wikiEnrich()` pipeline, gated end-to-end by
`rlm.enabled` in a new optional `.metaproject/wiki.config.json` (default `false` ⇒ today's
behavior, byte-for-byte). No new CLI command, no new process, no changes to `gdgraph`
storage/query surface or `wiki/ask.ts`.

Rejected alternative (from TRD grounding, not a fresh brainstorm — the PRD's own sketch):
route `deep` pages through the interactive `spawn_subagent` tool + `shell_exec_tool` scoped
to gdgraph subcommands. Rejected because (a) `spawn_subagent` is a tool the model calls from
inside an interactive turn — `wiki enrich` is a batch CLI with no such turn to call it from,
and (b) `shell_exec_tool` requires per-command human approval (`risk: "shell"`, default-deny
gate in `commands/agent.ts`), which cannot work unattended over N pages, and has no built-in
scoping — building one would duplicate the already-existing read-only
`metaproject-operations.ts` descriptor set.

## Steps

1. **`src/wiki/config.ts`** — `WikiConfig` type, `DEFAULT_WIKI_CONFIG`, `mergeWikiConfig`,
   `loadWikiConfig(cwd)`, `wikiConfigPath(cwd)` — same deep-merge-with-individual-fallback
   idiom as `src/gdgraph/config.ts` (`DEFAULT_GDGRAPH_CONFIG`/`mergeGdgraphConfig`/
   `loadGdgraphConfig`). Shape per TRD §3.1. Numeric defaults are implementer's call
   (documented as such in the TRD); pick conservative starting values and note them in the
   flow journal.
2. **`src/wiki/classify.ts`** — pure `classifyPage(page, signals, config): "skip"|"light"|"deep"`
   plus a `PageGraphSignals` computation helper that runs once per `wikiEnrich` run (reusing
   `personalizedPageRank` from `repomap.ts`, not a per-page graph rebuild). No I/O inside
   `classifyPage` itself (mirrors `computeRepomap`'s purity contract).
3. **Per-page staleness** — extend `ResumeState` (`enrich.ts:135`) with
   `completedNodeHashes?: Record<string, string>`; compute/compare per TRD §3.3. Gate the
   whole per-page hash computation behind `graphMaybeStale()` (`gdgraph/staleness.ts`) as a
   cheap upfront skip when the repo hasn't moved since the last graph build.
4. **`deep`-path child turn** — in `wikiEnrich`'s per-page worker, for `deep`-classified
   pages: call `spawnSubagent()` (`harness/child/orchestrate.ts`) for admission, then
   `runAgentTurn()` (`commands/agent.ts`) with a tool array from
   `toInteractiveTools(METAPROJECT_OPERATIONS.filter(op => DEEP_ENRICH_OPS.includes(op.name)), port)`
   (TRD §1.4/§4). Budget (`maxRuntimeMs`/`maxToolCalls`) sourced from
   `wiki.config.json`'s `rlm.deep.*`. On budget exhaustion or failure, fall back to the
   deterministic template or best partial output — the run must not fail (PRD Edge Cases).
5. **`light`-path batching** — group sibling pages of the same module (same grouping
   `collect.ts` already uses) into one `runModelTurn` call when combined size fits
   `repomap.ts`'s existing token-budget mechanism; split (not truncate) on overflow, reusing
   `repomap.ts`'s greedy-fill pattern (TRD §1.5).
6. **`skip`-path** — page content is `collect.ts`'s template as emitted, unchanged.
7. **RLM-off parity** — a single early branch: when `rlm.enabled` is false or
   `wiki.config.json` is absent, skip classify/deep/batch entirely and run today's
   `enrich.ts:688-776` path verbatim.
8. **Provenance (FR-9)** — confirm `deep`-path tool calls land in the harness's existing
   per-tool-call provenance store via the `ToolDefinition.replay` metadata already present
   on every `METAPROJECT_OPERATIONS` entry; no new provenance code expected, but verify.
9. **Tests** — unit tests for `classify.ts` against fixture graphs of varying
   size/complexity/staleness; integration test asserting a `deep` child's tool set contains
   no spawn/shell capability (flat recursion, FR-6); regression test asserting byte-for-byte
   parity with current `wiki/enrich.ts` output when `rlm.enabled` is false (NFR-4).
10. **Docs** — update any doc that describes `wiki enrich` behavior (README/docs-site per
    project convention) to mention the optional RLM mode and `wiki.config.json`.

## Risks

- Numeric classification thresholds are unset by design (PRD defers them to a baseline
  measurement) — implementer must pick defaults that are safe/conservative (bias toward
  `light` over `deep` until real numbers exist) and record the reasoning in `journal.md`,
  not silently invent "final" numbers.
- `deep`-path child budget defaults (`maxRuntimeMs`/`maxToolCalls`) must not starve a normal
  `wiki enrich --all` run — validate against a real page count, not just unit tests.
- Batching (`light` path) changes the exact prompt shape sent to the model even when RLM is
  enabled — must not be silently mixed into the RLM-off code path (NFR-4 parity risk).

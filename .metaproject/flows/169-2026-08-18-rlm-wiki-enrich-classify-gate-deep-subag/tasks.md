# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Context already complete via PRD/TRD — no context-collector dispatch needed; verify nothing new surfaced since 2026-08-18 before closing. |
| T2 | implement | `src/wiki/config.ts` (`WikiConfig`/`DEFAULT_WIKI_CONFIG`/`mergeWikiConfig`/`loadWikiConfig`, mirrors `gdgraph/config.ts`) + `src/wiki/classify.ts` (pure `classifyPage`) + `PageGraphSignals` computation. Plan steps 1-2. |
| T5 | implement | Extend `ResumeState` (`enrich.ts:135`) with `completedNodeHashes`; per-page hash compute/compare gated behind `graphMaybeStale()` upfront pre-check. Plan step 3. |
| T6 | implement | `deep`-path per-page worker branch: `spawnSubagent()` admission + `runAgentTurn()` turn + tool grant `toInteractiveTools(METAPROJECT_OPERATIONS.filter(...DEEP_ENRICH_OPS), port)`; budget from `wiki.config.json`; fallback to template/partial on budget exhaustion (must not fail the run). Plan step 4. |
| T7 | implement | `light`-path sibling-page batching (reuse `repomap.ts` token-budget + split-on-overflow) + `skip`-path passthrough + single early-branch RLM-off parity guard. Plan steps 5-7. |
| T3 | test | Unit tests for `classify.ts` (fixture graphs: size/complexity/staleness variants); integration test asserting `deep` child tool set has no spawn/shell capability (FR-6 flat recursion); regression test for byte-for-byte parity when `rlm.enabled: false` (NFR-4). Plan step 9. |
| T8 | docs | Update `wiki enrich` docs (README/docs-site, per project convention of keeping docs current with code) to describe optional RLM mode and `wiki.config.json`. Plan step 10. |
| T4 | review | Provenance check (T6's tool calls land in existing harness provenance store, plan step 8) + self-review + code-verifier + review-orchestrator + prepare PR. |

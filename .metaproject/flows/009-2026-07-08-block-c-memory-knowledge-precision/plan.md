# Implementation Plan

Status: ready

## Approach

Three phases per spec §14, lowest-risk first. **Phase 1 (C2 bitemporal + C3 typing, dep-free):**
pure Markdown header fields + type metadata + procedural injection — no asset, no MCP, lands first.
**Phase 2 (C1 optional embeddings, Block 0):** a `memory.embedding` CapabilityAdapter over
`@xenova/transformers` with a derived/disposable index; lexical search stays the always-computed
default and the fallback. **Phase 3 (C4 wiki Q&A / MCP, Block A):** `GdWikiService.ask` + `wiki ask`
CLI + read-only MCP Resources/Tools over the Block A surface. Block-completion gate = the byte-identical
everything-off + no-network + store-immutability tests (AC-C0/AC-C1/AC-C11).

Single coherent implementer (shared single-writer files: memory `types.ts`/`search.ts`/`service.ts`/
`config.ts`/`store.ts`, `commands/memory.ts`, `commands/wiki.ts`, `src/mcp/*`, `assets.lock.json`).

## Steps (grouped from spec T1–T26)

1. **C2/C3 schema+parser+config (T1–T3).** `MemoryClass` + bitemporal fields + `MEMORY_CLASS_MAP`
   (total coverage); back-compatible `parseEntry`; `temporal`/`typing` config blocks.
2. **C2 bitemporal service+supersede (T4, T5).** default `current` exclusion + `--as-of` interval +
   `--class` prefilter in search; `src/memory/supersede.ts` + `MemoryService.supersede` (non-destructive,
   both files retained, through `guardOutput`).
3. **C3 procedural injection (T7, T8).** generalize `relevant.ts` → `proceduralMemoryForScope`;
   `src/memory/inject.ts:renderProceduralBlock`; splice into the task-implementer/flow prompt assembly
   (empty scope ⇒ unchanged).
4. **CLI (T6).** `memory search --as-of/--class/--semantic` + `memory supersede`.
5. **C1 embedding adapter (T12–T14).** `src/memory/embedding/adapter.ts` (lazy `await import`; isAvailable
   = runtime + model asset); `index` config block (default off) + model in `assets.lock.json`;
   `src/memory/embedding/index.ts` derived/disposable/content-hash-keyed under `data/memory/embeddings/`.
6. **C1 search wiring + CLI (T15, T16).** `resolveCapability("memory.embedding")` into search — lexical
   ALWAYS first, rerank only when available, warn-once + fallback; `memory index --embeddings` +
   `--semantic` + `memory assets pull`.
7. **C4 wiki ask + MCP (T19–T22).** `src/wiki/ask.ts` + `GdWikiService.ask` (deterministic retrieval +
   citations; optional C1 rerank); `wiki ask` CLI; register memory+wiki read-only MCP Resources +
   `wiki.ask`/`memory.search` thin Tools (all through `redactRaw`).
8. **Fixtures + tests (T9–T11, T17, T18, T23, T24, T25).** `fixtures/temporal/` + `fixtures/paraphrase/`;
   temporal 100% correctness; type-scoped retrieval; supersede non-destructive; procedural injection
   integration; byte-identical fallback (embeddings off); availability true/false; recall@k(index) >
   recall@k(lexical); delete→rebuild determinism; store-mutation guard; MCP stdio round-trip
   (`wiki.ask`); no-network sandbox.
9. **Docs (T26).** roadmap-2026 status + reference runtime/model id.
10. **Review + PR.** Adversarial review (byte-identity / no-top-level-import / no-network / store-immutability).

## Risks

- **Byte-identity regression (top):** search output (`latest.md`/`latest.json`/ordering/scores) must be
  byte-identical with embeddings off. Mitigation: golden-file diff on a fixed corpus + import-spy asserting
  no `await import(runtime)` on the default path; lexical candidate set always computed first.
- **Store mutation:** search/index/ask must NEVER write the Markdown store. Mitigation: store-mutation guard
  test across all read paths; only create/ingest/supersede write (through the security seam).
- **Bitemporal back-compat:** entries without the new fields must parse unchanged (missing ⇒ null / class via
  map); default `current` semantics must not change results for non-superseded entries.
- **@xenova/transformers in CI/offline:** model asset may be unfetchable — availability-true rerank test
  skips gracefully or uses a stubbed embedder; the fallback + no-network + recall-improvement (with a small
  deterministic stub embedder on the paraphrase fixture) paths are mandatory.
- **No top-level import of the runtime:** extend the Block 0 static guard.

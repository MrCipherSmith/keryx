# Module src/memory/embedding

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/memory/embedding` groups 3 file(s). Depends on `src/memory`, `src/capability`, `src/lib`. Exposes 10 public symbol(s).

## Overview

`src/memory/embedding` owns the semantic layer of the memory subsystem: it builds and persists a content-hash-keyed vector cache derived from memory entries, and reranks lexical search results using cosine similarity against that cache. The module is deliberately a read-only consumer of the Markdown store — it never mutates entries, only reads them and writes a disposable derived index under `.metaproject/data/memory/embeddings/`. When the optional embedding runtime or its model asset is absent, the module degrades silently to lexical ranking so the memory service always returns a result.

## How it works

The module is organized in two cooperating layers. The adapter layer (`adapter.ts`) defines the pluggable vectorization contract: an `Embedder` function type and the `CapabilitySpec` that wires an optional runtime (`@xenova/transformers`, imported lazily via the capability seam) together with a verified model asset. Availability is declared false unless both the optional dependency resolved and the model asset passed sha256 verification; a failed `run()` propagates upward to the seam, which catches it and falls back to lexical. A deterministic offline embedder (`deterministicEmbedder`) — a bag-of-token FNV-1a hash normalized to L2 — is provided for tests and as an explicit fallback, giving the reranking contract provable correctness without any download.

The index layer (`index.ts`) owns the derived cache: it reads `MemoryEntry` objects from the store, converts each to a stable text representation (`entryText`), computes a 16-character SHA-256 content hash, calls the `Embedder`, and writes two files — `index.meta.json` and `vectors.jsonl` — to the embeddings directory. Entries are sorted by path before writing so the on-disk representation is byte-stable across rebuilds for the same corpus and model. Loading the index back is a simple parse of those two files, returning `null` on any error so callers can safely embed on the fly. The `rerankByEmbedding` function ties the two layers together: given a lexical candidate pool, a query, and an optional loaded index, it embeds the query, serves cached vectors for entries whose content hash is current, re-embeds stale or missing entries on the fly, and returns the pool sorted by cosine similarity with the original lexical order as a stable tiebreaker.

## Key concepts

- **Embedder** — a plain async function `(texts: string[]) => Promise<Float32Array[]>` that the index and rerank functions consume; decoupled from any specific runtime so tests can inject a deterministic implementation.
- **EmbeddingIndex** — the in-memory representation of the derived cache: an `EmbeddingIndexMeta` header (model, dims, timestamp, entry count) plus a `byPath` map from entry relative path to `{ contentHash, vector }`.
- **Content hash** — a 16-character SHA-256 prefix of the stable text representation of an entry (title + summary + tags + details). A changed hash signals that a cached vector is stale and must be re-embedded on the fly; an unchanged hash means the cached vector can be reused without hitting the runtime.
- **CapabilitySpec / ceiling** — the adapter exposes the embedding runtime to the rest of the system through `src/capability`'s seam. A `"ceiling"` capability entry in `metaproject.json` disables the runtime globally; the spec's `isAvailable()` returns false and no import warning is emitted.
- **Deterministic embedder** — a dependency-free FNV-1a-based bag-of-token vectorizer used offline; its cosine similarity is equivalent to TF cosine, making it suitable for correctness tests and as a documented fallback.

## Main flows

**Build index flow.** `buildEmbeddingIndex(cwd, entries, embedder, model, now)` sorts entries by path, maps each to `entryText`, calls the embedder for all texts in one batch, assembles `EmbeddingVectorRecord` objects (path + content hash + vector as a plain number array), writes `index.meta.json` and `vectors.jsonl` to the embeddings directory, then converts records to the in-memory `EmbeddingIndex` via `toIndex`. The Markdown store is never touched.

**Rerank flow.** `rerankByEmbedding(query, pool, embedder, index)` first embeds the query, then iterates the lexical candidate pool: for each entry it checks whether a cached vector exists with a matching content hash; mismatches go into a `needsEmbed` batch that is re-embedded in one additional embedder call. All vectors are then used to compute cosine similarity against the query vector, and the pool is stably sorted — cosine descending, original order as tiebreaker.

**Degraded / lexical-only flow.** When the capability seam resolves the adapter to `null` (runtime absent or model asset unverified), callers in `src/memory` skip `rerankByEmbedding` entirely. `loadEmbeddingIndex` returns `null` on a missing or corrupt cache, and `buildEmbeddingIndex` may still be called with the deterministic embedder as a stub so lexical results remain the output without error.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `EmbeddingIndexMeta` (interface)
- `EmbeddingVectorRecord` (interface)
- `EmbeddingIndex` (interface)
- `embeddingsDir` (function)
- `entryText` (function)
- `contentHash` (function)
- `buildEmbeddingIndex` (function)
- `loadEmbeddingIndex` (function)
- `cosine` (function)
- `rerankByEmbedding` (function)

### Key files

- `src/memory/embedding/embedding.test.ts` - imported by 0, imports 9
- `src/memory/embedding/index.ts` - imported by 3, imports 1
- `src/memory/embedding/adapter.ts` - imported by 3, imports 0

### Depends on

- `src/memory` - 4 import(s)
- `src/capability` - 2 import(s)
- `src/lib` - 2 import(s)

### Depended on by

- `src/memory` - 2 import(s)
- `src/wiki` - 2 import(s)

### Entry points

- `src/memory/embedding/index.ts`

### Graph signals

- Files: 3
- Cross-module imports: 8

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/memory](src-memory.md)
- [Module src/capability](src-capability.md)
- [Module src/lib](src-lib.md)
- [Module src/wiki](src-wiki.md)

## Changelog

- 1.0.0 - Prose enriched by gdwiki enrich workflow: Overview, How it works, Key concepts, Main flows filled from key files. Status set to accepted.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

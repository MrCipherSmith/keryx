# Implement Block C: Memory & Knowledge Precision (bitemporal + typing + opt-in embeddings + wiki Q&A/MCP)

Status: formalized
Source: docs/requirements/roadmap-2026/C-memory-knowledge/ (PRD/spec/AC-C0..AC-C12/tasks are the authoritative source)

## Problem

Lift the recall/precision ceiling of gd-metapro's knowledge layer (`memory` + `gdwiki`)
WITHOUT ever displacing the git-diffable Markdown as the authoritative source of truth.
Every capability is an opt-in ceiling on the deterministic floor: with nothing enabled and
no assets, `memory` and `gdwiki` behave byte-identically to today (the C0-7 gate). Four
work items: C2 bitemporal fact model (pure Markdown fields), C3 procedural memory typing +
active injection (pure metadata), C1 optional local embedding index (Block 0 asset), and
C4 gdwiki Q&A / MCP endpoint (rides Block A).

## Expected Outcome (Block C spec §§, tasks T1–T26)

- **Phase 1 — bitemporal + typing (dep-free):** add `MemoryClass` + bitemporal fields
  (`class`,`validFrom`,`validTo`,`recordedAt`,`supersedes`,`supersededBy`) to `MemoryEntry` +
  `MEMORY_CLASS_MAP` (total coverage of `MEMORY_TYPES`); back-compatible `parseEntry`;
  `temporal`/`typing` config blocks; bitemporal query filters (default `current` exclusion +
  `--as-of` interval + `--class` prefilter); non-destructive `memory supersede <old> --by <new>`
  (both files retained, through `guardOutput`); `memory search --as-of/--class/--semantic` +
  `memory supersede` CLI; `proceduralMemoryForScope` + `renderProceduralBlock` spliced into the
  task-implementer/flow prompt-assembly path (empty scope ⇒ prompt unchanged).
- **Phase 2 — optional embedding index (Block 0):** `src/memory/embedding/adapter.ts`
  CapabilityAdapter (lazy `await import(@xenova/transformers)`; `isAvailable` = runtime importable
  AND model asset resolved); `index` config block (default off) + model in `assets.lock.json`;
  derived, disposable, content-hash-keyed index under `data/memory/embeddings/`; wire
  `resolveCapability("memory.embedding")` into search — lexical candidate set ALWAYS computed first,
  rerank only when available, warn-once + lexical fallback otherwise; `memory index --embeddings` +
  `memory search --semantic` + `memory assets pull`.
- **Phase 3 — gdwiki Q&A / MCP (Block A):** `src/wiki/ask.ts` + `GdWikiService.ask` (deterministic
  lexical retrieval over wiki pages + memory → citations + answer; optional C1 rerank); `wiki ask`
  CLI; register `memory`+`wiki` as read-only MCP Resources + `wiki.ask`/`memory.search` as thin MCP
  Tools (all output through `redactRaw`, no business logic in `src/mcp/`).
- **Fixtures:** `fixtures/temporal/` (supersession chains + as-of), `fixtures/paraphrase/`
  (query→expected incl. paraphrases + recall@k threshold).
- **Golden rule (AC-C0/C0-7):** with no Block C capability enabled and no assets, the full existing
  `memory`+`gdwiki` suite and every deterministic command behave byte-identically — no embedding
  runtime imported, no socket opened, no asset touched. `dependencies` stays empty; `@xenova/transformers`
  imported ONLY via lazy `await import()` in the embedding adapter. Markdown stays authoritative:
  every derived layer (index, MCP responses, injected blocks, wiki answers) is reproducible from
  Markdown and never mutates the store outside create/ingest/supersede (each through the security seam).

## Out of Scope

- Hosted embedding API, external vector DB, or graph DB (local-only; NG-C1/NG-C3).
- A general RAG assistant — scope is the metaproject's own `memory`+`wiki` data only (NG-C4).
- Replacing weighted lexical search — it stays the default and the fallback (NG-C2).

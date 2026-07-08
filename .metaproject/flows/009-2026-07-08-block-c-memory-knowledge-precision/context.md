# Context

Collected deterministically by `gd-metapro flow init` at 2026-07-08T06:12:14.121Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `gd-metapro gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-07-07T13:53:28.505Z)
- refresh: `gd-metapro health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security

## Agent Findings

### Authoritative source (read first)
- docs/requirements/roadmap-2026/C-memory-knowledge/{prd,specification,acceptance-criteria,tasks}.md — spec is the contract; AC-C0..AC-C12 are fixture-backed gates.

### Existing memory module to extend (do NOT rewrite)
- `src/memory/types.ts` — `MemoryEntry`, `MEMORY_TYPES`, `MEMORY_TYPE_VALUES`. ADD `MemoryClass` + bitemporal fields + `MEMORY_CLASS_MAP` (must totally cover MEMORY_TYPES).
- `src/memory/store.ts` — `parseEntry` (line 42), `collectEntries`. Extend parseEntry back-compatibly (missing fields ⇒ null / class via map).
- `src/memory/search.ts` — `searchEntries` (line 9), weighted lexical. STAYS the default+fallback; add bitemporal/class filters and the embedding rerank hook (lexical candidate set ALWAYS computed first).
- `src/memory/config.ts` — `loadMemoryConfig`, deep-merge. Add `temporal`/`typing`/`index` blocks (index default off).
- `src/memory/service.ts` — `createMemoryService()` (line 28). Add `supersede`, bitemporal search, embedding wiring.
- `src/memory/relevant.ts` — `relevantAcceptedMemory` (the existing injection seam) → generalize to `proceduralMemoryForScope`; add `src/memory/inject.ts:renderProceduralBlock`.
- `src/memory/ingest.ts` (Mem0-style reconcile), `src/memory/security-seam.test.ts` (guardOutput pattern — supersede writes go through it).
- `src/wiki/service.ts` — `createGdWikiService()` (line 283); ADD `ask.ts` + `GdWikiService.ask`.

### Block 0 + Block A seams to instantiate (both landed on main)
- `src/capability/seam.ts` — `resolveCapability(cwd, spec)`, `runCapabilityOrFallback`, `warnCapabilityDegraded`. The `memory.embedding` ceiling gates through this.
- `src/assets/{resolver,lock,pull}.ts` + `.metaproject/assets.lock.json` — the embedding model asset resolves via `resolveAsset` (sha256 every load).
- `@xenova/transformers` is ALREADY in `optionalDependencies` (Block 0) — the reference embedding runtime; import ONLY via lazy `await import()` in `src/memory/embedding/adapter.ts`. EXTEND `src/capability/no-optional-imports.test.ts` to cover it.
- `src/harness/` — `runCorpus`/`gateCorpus` for the temporal + paraphrase fixtures.
- Block A `src/mcp/`: `resources.ts` (register memory+wiki read-only Resources), `tools.ts`/`dispatch.ts` (register `wiki.ask`/`memory.search` thin Tools), `redact-seam.ts` (all output routed). `src/mcp/` imports ONLY facades + lib + guard (M-3 boundary test).

### Hard invariants (AC-C0 / C0-7 golden rule)
- With no Block C capability + no assets: full existing memory+gdwiki suite byte-identical; no embedding import; no socket; no asset touched. `dependencies` stays `{}`.
- `@xenova/transformers` imported only lazily in the embedding adapter (static guard); `memory.embedding` default off.
- Markdown authoritative: index is derived/disposable/rebuildable; search/index/ask NEVER mutate the store; only create/ingest/supersede write (through the security seam).
- Lexical search is always computed first; embeddings only rerank when available; graceful warn-once + lexical fallback.

### Baseline
- main @ 0411917; `bun run check` green (268 tests); Blocks 0, A, B landed.

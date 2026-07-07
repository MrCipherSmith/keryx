# Tasks: Block C — Memory & Knowledge Precision

Version: 1.0.0
Date: 2026-07-07

Atomic tasks `T1..Tn`. **Kind** ∈ {schema, parser, service, adapter, cli, injection,
mcp, fixture, test, docs}. **Deps** name prerequisite tasks and cross-block dependencies
(**Block 0** = Capability Seam + Asset Resolver + fixture harness; **Block A** = `src/mcp/`
surface). Each task cites the governing `AC-C*` / constraint.

Recommended order follows spec §14: **Phase 1 (C2+C3, dep-free) → Phase 2 (C1) →
Phase 3 (C4)**.

---

## Phase 1 — Bitemporal + Typing (dep-free; no asset, no MCP)

| ID | Kind | Task | Deps | Gate |
|----|------|------|------|------|
| **T1** | schema | Add `MemoryClass` + bitemporal fields (`class`, `validFrom`, `validTo`, `recordedAt`, `supersedes`, `supersededBy`) to `MemoryEntry`; add `MEMORY_CLASS_MAP` (total coverage of `MEMORY_TYPES`). | — | AC-C7, C-5 |
| **T2** | parser | Extend `store.ts:parseEntry` to read the new header fields back-compatibly (missing ⇒ null / class via map). | T1 | AC-C6, C-4 |
| **T3** | config | Add `temporal` + `typing` blocks to `DEFAULT_MEMORY_CONFIG` + deep-merge in `loadMemoryConfig`. | T1 | C0-8 |
| **T4** | service | Bitemporal query filters in `searchEntries`/service: default `current` exclusion + `--as-of` interval filter; `--class` prefilter. | T2, T3 | AC-C5, AC-C7, C-4/C-5 |
| **T5** | service | New `src/memory/supersede.ts` + `MemoryService.supersede` — non-destructive supersede write (both files retained), through `guardOutput`. | T2 | AC-C6, C-4 |
| **T6** | cli | Wire `memory search --as-of/--class/--semantic-flag` and `memory supersede` commands. | T4, T5 | §6 |
| **T7** | injection | Generalize `relevant.ts:relevantAcceptedMemory` → `proceduralMemoryForScope`; add `src/memory/inject.ts:renderProceduralBlock`. | T2 | AC-C8, C-5 |
| **T8** | injection | Splice `renderProceduralBlock` into flow / task-implementer prompt assembly (extend existing `relevantAcceptedMemory` consumer path). | T7 | AC-C8, C-5 |
| **T9** | fixture | Commit `fixtures/temporal/` (supersession chains + as-of queries + expected results). | — | AC-C5, AC-C12, F-1/F-2 |
| **T10** | test | Temporal current/as-of resolution test (100% on fixture); type-scoped retrieval test; supersede non-destructive test. | T4, T5, T9 | AC-C5, AC-C6, AC-C7 |
| **T11** | test | Flow-injection integration test: procedural block present in assembled prompt; empty-scope no-op. | T8 | AC-C8 |

## Phase 2 — Optional embedding index (Block 0)

| ID | Kind | Task | Deps | Gate |
|----|------|------|------|------|
| **T12** | adapter | `src/memory/embedding/adapter.ts` implementing the Block 0 `CapabilityAdapter`: lazy `await import(runtime)` in try/catch; `isAvailable` = runtime importable AND model asset resolved. | Block 0 | C0-2, C-3, AC-C4 |
| **T13** | config | Add `index` block to `memory.config.json` (default `enabled:false`); declare embedding runtime under `optionalDependencies`; register model in `assets.lock.json`. | Block 0, T3 | C0-1, A-1..A-4 |
| **T14** | service | `src/memory/embedding/index.ts` — build/load derived, disposable index under `data/memory/embeddings/`; content-hash keyed; rebuildable. | T12, T13 | AC-C3, C-1 |
| **T15** | service | Wire `resolveCapability("memory.embedding")` into `MemoryService.search`: lexical candidate set ALWAYS computed first; rerank only when adapter available; warn-once + lexical fallback otherwise. | T4, T14 | AC-C1, AC-C4, C-2 |
| **T16** | cli | `memory index --embeddings` + `memory search --semantic` + `memory assets pull <id>` (Block 0). | T15 | §6, A-1/A-2 |
| **T17** | fixture | Commit `fixtures/paraphrase/` (query→expected-memory incl. paraphrases; recall@k threshold in manifest). | — | AC-C2, AC-C12, F-1/F-2 |
| **T18** | test | XP2 byte-identical fallback test (index off) [AC-C1]; availability-true rerank + availability-false fallback tests [AC-C4]; recall@k(index) > recall@k(lexical) on paraphrase fixture [AC-C2]; delete→rebuild determinism [AC-C3]. | T15, T16, T17 | AC-C1..AC-C4 |

## Phase 3 — gdwiki Q&A / MCP endpoint (Block A)

| ID | Kind | Task | Deps | Gate |
|----|------|------|------|------|
| **T19** | service | `src/wiki/ask.ts` + `GdWikiService.ask`: deterministic lexical retrieval over collected wiki pages + memory entries → citations + assembled answer; optional C1 rerank when available. | T15 (optional rerank), wiki service | AC-C9, C-6, C-8 |
| **T20** | cli | `wiki ask "<question>"` command. | T19 | §6 |
| **T21** | mcp | Register `memory` + `wiki` as **read-only** MCP Resources in `src/mcp/resources.ts`; route all output through `redactRaw`. | Block A, T19 | AC-C9, M-4, M-5 |
| **T22** | mcp | Register `wiki.ask` (and `memory.search`) as thin MCP Tools over the service facades (no business logic in `src/mcp/`). | Block A, T19 | AC-C9, M-2, M-3 |
| **T23** | test | stdio MCP round-trip (`tools/list`→`tools/call wiki.ask`, `resources/list`→`read`) against fixture project [AC-C9]; endpoint-disabled `gdwiki collect` byte-identical [AC-C10]. | T21, T22 | AC-C9, AC-C10, T-2 |

## Cross-cutting

| ID | Kind | Task | Deps | Gate |
|----|------|------|------|------|
| **T24** | test | Source-of-truth reproducibility + store-mutation guard: regenerate all derived artifacts from Markdown and diff; assert search/index/ask never mutate the store. | T15, T19 | AC-C11 |
| **T25** | test | No-network sandbox: every default `memory`/`gdwiki` command succeeds with no socket opened. | T6 | AC-C0, T-4 |
| **T26** | docs | Update `roadmap-2026/README.md` block-C link/name; note reference embedding runtime + model id; keep the four package files versioned. | — | DOC-1, prd Open Q1/Q2 |

---

### Dependency summary
- **All tasks** depend transitively on **Block 0** existing (seam is used directly by
  T12–T15; the fixture-corpora harness by T9/T17).
- **Phase 3 (T19–T23)** additionally depends on **Block A** (`src/mcp/` surface).
- **Phase 1** is fully independent of Block A and of the embedding asset path and can land
  first (lowest risk).

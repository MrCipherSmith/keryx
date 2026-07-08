# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `gd-metapro flow task done <id> <taskId>`.

Maps the block spec's T1–T26 (docs/requirements/roadmap-2026/C-memory-knowledge/tasks.md)
onto flow task units. Phase 1 (C2+C3, dep-free) → Phase 2 (C1 embeddings) → Phase 3 (C4 MCP).

| ID | Kind | Title | Spec tasks | Satisfies |
|----|------|-------|-----------|-----------|
| T1 | context | Study memory/wiki modules + Block 0/A seams (done Phase 1) | — | — |
| T2 | implement | C2/C3 schema+parser+config: MemoryClass + bitemporal fields + MEMORY_CLASS_MAP (total); back-compat parseEntry; temporal/typing/index config blocks | T1–T3 | AC5, AC7, AC11 |
| T3 | implement | C2 bitemporal search filters (current exclusion + --as-of + --class) + `memory/supersede.ts` + MemoryService.supersede (non-destructive, guardOutput) | T4, T5 | AC5, AC6 |
| T4 | implement | C3 procedural injection: proceduralMemoryForScope + inject.ts renderProceduralBlock spliced into task-implementer/flow prompt assembly | T7, T8 | AC8 |
| T5 | implement | CLI: `memory search --as-of/--class/--semantic` + `memory supersede` | T6 | AC5, AC6, AC7 |
| T6 | implement | C1 embedding adapter: `memory/embedding/adapter.ts` (lazy await import; isAvailable=runtime+asset); index config block (default off) + model in assets.lock.json; extend no-top-level-import guard | T12, T13 | AC4 |
| T7 | implement | C1 index build/load: `memory/embedding/index.ts` derived/disposable/content-hash-keyed under data/memory/embeddings/ | T14 | AC3 |
| T8 | implement | C1 search wiring: resolveCapability into search (lexical ALWAYS first; rerank only when available; warn-once+fallback) + `memory index --embeddings`/`--semantic`/`assets pull` | T15, T16 | AC2, AC3, AC4 |
| T9 | implement | C4 wiki ask: `wiki/ask.ts` + GdWikiService.ask (deterministic retrieval+citations; optional C1 rerank) + `wiki ask` CLI | T19, T20 | AC9 |
| T10 | implement | C4 MCP: register memory+wiki read-only Resources + wiki.ask/memory.search thin Tools (all through redactRaw; no logic in src/mcp) | T21, T22 | AC9 |
| T11 | test | Fixtures + tests: temporal/ + paraphrase/; temporal 100%, type-scoped, supersede non-destructive, procedural injection, byte-identical fallback, availability true/false, recall@k improvement, delete→rebuild, store-mutation guard, MCP stdio round-trip, no-network sandbox | T9–T11, T17, T18, T23, T24, T25 | AC1..AC10 |
| T12 | docs | roadmap-2026 status + reference embedding runtime/model id | T26 | AC11 |
| T13 | review | Adversarial review (byte-identity / no-top-level-import / no-network / store-immutability) + draft PR | — | AC1, AC11 |

## Notes
- **Golden rule is the block-completion gate:** T11's byte-identical everything-off + no-network + store-mutation-guard tests (AC1/AC2/AC10) must be green.
- Phase 1 (T2–T5) is fully dep-free and independent of Block A — lands first, lowest risk.
- Lexical weighted search stays the default+fallback; the lexical candidate set is ALWAYS computed first.
- `@xenova/transformers` is already in optionalDependencies (Block 0); import only via `await import` in the embedding adapter (static guard extended).
- Markdown stays authoritative: search/index/ask never mutate the store; only create/ingest/supersede write.

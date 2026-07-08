# Roadmap 2026 — gd-metapro Extension Package (Blocks 0 + A–E)

Version: 1.0.0
Status: spec in progress

This roadmap formalizes the 2026 functional-review recommendations into **six discrete
blocks** layered on top of — never replacing — the deterministic, local, offline,
git-diffable, zero-runtime-dependency core of gd-metapro. Every model / embedding /
network / precision feature is an **opt-in ceiling**; the deterministic core is the
**floor** and stays byte-identical when nothing is opted in.

Source artifacts (job): `problem-statement.md`, `architecture.md`, `tech-bestpractices.md`.

## Blocks & Dependency Order

| Order | Block | Directory | Depends on | Summary |
|-------|-------|-----------|------------|---------|
| 1 | **00 — Capability Seam** ✅ landed | [`00-capability-seam/`](00-capability-seam/) | — | The uniform opt-in substrate: `resolveCapability(id) → Adapter \| null`, `optionalDependencies` + lazy import, deterministic fallback as a tested path, the Asset Resolver (`assets.lock.json` + `assets pull/list/verify`), and the fixture-corpora acceptance harness + FN-rate gate. Ships **no** end-user feature — every block below instantiates it. |
| 2 | **A — Interop / MCP** ✅ landed | [`A-interop-mcp/`](A-interop-mcp/) | Block 0 | `gd-metapro mcp` stdio-first server; Tools = thin adapters over `createXService()`; Resources = read-only artifacts; `llms.txt` + gdskills plugin export; reposition the Standard as a generator. |
| 3 | **B — Code Understanding (`gdgraph`)** ✅ landed | [`B-code-understanding/`](B-code-understanding/) | Block 0 | Opt-in tree-sitter symbol graph (regex fallback), N-hop transitive `affected`, pure PageRank token-budgeted `repomap.md`. |
| 4 | **C — Memory / Knowledge** ✅ landed | [`C-memory-knowledge/`](C-memory-knowledge/) | Block 0, A (for C4) | Opt-in local embedding index, bitemporal Markdown fact model, memory typing, gdwiki Q&A over the MCP surface. |
| 5 | **D — Quality Signals** | [`D-quality-signals/`](D-quality-signals/) | Block 0 | Git-churn × complexity hotspot signal, dynamic coverage-map TIA (static fallback), always-on smoke tier. Dep-free. |
| 6 | **E — Security Hardening** | [`E-security-hardening/`](E-security-hardening/) | Block 0, A (for E3) | Semantic injection detection (Prompt Guard 2 on `backends` seam), modern exfil coverage, `security scan-mcp`, broadened hooks, checksum PII + optional NER, red-team eval harness. |

## Ordering Rules (from architecture §7)

1. **Block 0 first.** The seam + Asset Resolver + `optionalDependencies` policy + fixture
   harness are decided once, centrally. B, C, D, E all instantiate this seam; none may
   land before it.
2. **A before E3 and C4** — both couple to the MCP surface; E3 ships *with* A1
   (tool output is untrusted from day one).
3. **B, D, and E's non-model items** are independent of A and may proceed in parallel
   once Block 0 exists.

## Implementation Status

| Block | Status | Landed |
|-------|--------|--------|
| **00 — Capability Seam** | ✅ **landed** | `src/capability/` (`resolveCapability` seam + warn-once), `src/assets/` (resolver + `assets.lock.json` + `assets list\|verify\|pull`), `src/harness/` (`runCorpus`/`gateCorpus` + `fixtures/`), `optionalDependencies` policy + no-top-level-import guard, init/update capability wiring, non-shipping reference capability. Golden-rule + no-network gates green (201 tests). Ships **no** end-user feature — Blocks A–E instantiate the seam by appending descriptors to `CAPABILITY_REGISTRY`. |
| **A — Interop & Adoption (MCP)** | ✅ **landed** | `src/mcp/` (stdio-first MCP server: `server.ts` lazy-loads the SDK, `tools.ts` = 12-tool registry mapping each Tool → one `createXService()` method, `resources.ts` = read-only `metaproject://` scheme, `config.ts`/`discovery.ts`/`redact-seam.ts`, isolated `transport/{stdio,http-sse}.ts`), `gd-metapro mcp serve [--http]`, `init --mcp` manifest wiring. E3: `src/security/detect/mcp.ts` (`scanMcpManifest` — tool-poisoning / line-jumping / rug-pull) + `security scan-mcp` + `fixtures/mcp-threat/` corpus (100% flagged, no FP). Generators: `standard emit llms` (deterministic `llms.txt`) + `skills export --runtime plugin`. Golden rule holds: `dependencies` stays `{}`, SDK only in `optionalDependencies`, no top-level SDK import, disabled = byte-identical (235 tests green). |
| **B — Code Understanding (gdgraph)** | ✅ **landed** | `src/gdgraph/` extended: `config.ts` (deep-merged `gdgraph.config.json`, malformed⇒defaults), `affected.ts` (pure N-hop transitive closure over reverse-dependents; `--depth`/`--ranked`/`--json`; depth-1 stdout byte-identical to the legacy renderer), `pagerank.ts` (deterministic personalized PageRank), `repomap.ts` (token-budgeted `artifacts/repomap.md`, `chars-div-4` estimator, stable omission marker, re-run byte-identical), `service.ts` (`createGdgraphService()` facade Block A wraps). Opt-in tree-sitter symbol layer behind the Block 0 seam: `treesitter/{adapter,extract,grammars}.ts` (lazy `web-tree-sitter`, grammar WASM via the Asset Resolver + `assets.lock.json`), `enrich.ts` writes `storage/{symbols,calls}.jsonl` ADDITIVELY, `init --treesitter` capability wiring. Golden rule holds: `dependencies` stays `{}`, no top-level SDK/dep import, the 4 legacy artifacts byte-identical + no symbol files when the capability is off, no-network sandbox opens 0 sockets, enabled-but-unavailable warns once + exits 0. Fixture-backed: `fixtures/{transitive-closure,repomap,symbol-graph}/`. 268 tests green. |
| **C — Memory & Knowledge Precision** | ✅ **landed** | `src/memory/` extended: `types.ts` (`MemoryClass` + `MEMORY_CLASS_MAP` totally covering `MEMORY_TYPES`, bitemporal fields on `MemoryEntry`, `index`/`temporal`/`typing` config blocks), `store.ts` (`parseEntry` reads `Class`/`Valid-From`/`Valid-To`/`Recorded-At`/`Supersedes`/`Superseded-By` back-compatibly), `search.ts` (default `current` exclusion + `--as-of` interval + `--class` prefilter + `candidatePool` for rerank; default output byte-identical), `supersede.ts` (non-destructive bitemporal supersede through `guardOutput`), `relevant.ts`→`proceduralMemoryForScope` + `inject.ts` (`renderProceduralBlock` spliced into `flow/context.ts` prompt assembly), `embedding/{adapter,index}.ts` (C1 opt-in embedding rerank behind the Block 0 seam; `@xenova/transformers` lazy-only, derived disposable content-hash index under `data/memory/embeddings/`, lexical candidate set always first). `src/wiki/ask.ts` + `GdWikiService.ask` (C4 deterministic retrieval + citations, optional C1 rerank); MCP `wiki.ask` thin Tool + `memory`/`wiki` read-only Resources. CLI: `memory search --as-of/--class/--semantic`, `memory supersede`, `memory index --embeddings`, `memory assets`, `wiki ask`. Golden rule holds: `dependencies` stays `{}`, no top-level `@xenova/transformers` import, embeddings-off search byte-identical (golden diff + warn-once import-spy), no-network sandbox opens 0 sockets, Markdown stays authoritative (search/index/ask never mutate the store). Fixture-backed: `fixtures/{temporal,paraphrase}/` — temporal resolution 100%, recall@1 lexical 0.25 → index 1.00. 293 tests green. |
| D–E | ▫ planned | Instantiate the Block 0 seam. |

## Cross-Cutting Golden Rule

With zero opt-in flags set and no assets present, the full existing test suite and every
deterministic command behave **byte-identically** to today: no new dependency loaded, no
socket opened. This is the package-wide acceptance gate (`C0-7`).

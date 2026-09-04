---
Title: Module src/memory
Version: 1.1.1
Type: component
Status: accepted
VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df
VerifiedScope: sha256:70f67d138426d3f910281d4145c140c0caae4a59a3fe0f21b5fb7f3dbc69b288
Summary: `src/memory` groups 36 file(s). Depends on `src/lib`, `src/security`, `src/memory/embedding`. Exposes 5 public symbol(s).

# Module src/memory

## Summary

`src/memory` groups 36 file(s). Depends on `src/lib`, `src/security`, `src/memory/embedding`. Exposes 5 public symbol(s).

## Overview

`src/memory` is keryx's long-lived project knowledge store. It owns the full lifecycle of typed memory entries — creating, optionally cataloging, purely searching, ingesting, transitioning, and superseding Markdown files that live under `.metaproject/memory/`. Markdown is canonical; catalogs, embedding caches, and explicitly saved reports are disposable generated views. The module gives agents and humans a queryable, ranked, bounded record while automatic consumers receive only accepted/current scoped projections. It is consumed by commands, flow, gdskills, harness, MCP, and wiki integrations.

## How it works

The module is organized into three logical layers that compose from the bottom up.

### Data layer (`store.ts`)

The source of truth. It walks the filesystem under `.metaproject/memory/`, reads every Markdown file in the typed sub-folders registered in `MEMORY_TYPES` (e.g. `lessons/`, `decisions/`, `constraints/`, `known-mistakes/`), and parses each file into a `MemoryEntry` struct. Parsing is purely text-based — the store splits files into header fields (`field()`) and named Markdown sections (`splitSections()`), then populates bitemporal fields (`validFrom`, `validTo`, `recordedAt`), scope annotations, and the resolved `MemoryClass` (`semantic | episodic | procedural`) without any external dependency.

### Search layer (`search.ts`)

Operates entirely on in-memory `MemoryEntry` arrays and never persists a report. It runs a deterministic lexical scoring pipeline:

- Entries are first filtered by status, module/entity scope, knowledge class, and a bitemporal validity window.
- Then scored across five configurable dimensions (relevance, recency, confidence, status boost, scope match) whose weights come from `MemoryConfig`.
- The top-k results are returned as `ScoredEntry` objects with per-dimension score breakdowns.

On the opt-in semantic path (`filters.semantic === true` or `config.index.enabled`), `search.ts` also exposes a `candidatePool` function used by `service.ts` to widen a bounded candidate set before embedding reranking. Capability failure falls back to lexical results. The generated catalog is optional and is not consumed by runtime recall.

### Service layer (`service.ts`)

The single public façade created by `createMemoryService()`. It orchestrates the data and search layers plus a set of peer modules (`ingest.ts`, `dedup.ts`, `check.ts`, `supersede.ts`, `templates.ts`) to implement the full `MemoryService` interface. When embedding support is requested, it resolves an `Embedder` through `src/capability`'s capability seam (`resolveCapability`) and delegates to `src/memory/embedding` for index build and cosine reranking; when the capability is unavailable the service degrades silently to the lexical result. `memory index` writes an optional disposable catalog/cache; `search()` is pure, and only CLI `--save-report` writes a bounded unique report under ignored `.metaproject/runtime/memory/`.

### Configuration (`config.ts`)

A thin layer that reads an optional `.metaproject/memory.config.json` file and deep-merges it over `DEFAULT_MEMORY_CONFIG`, providing tunable ranking weights, dedup thresholds, ingest defaults, and embedding settings.

### Ingest pipeline (`ingest.ts`)

Bridges external tool outputs (health reports, code reviews, job results) into memory entries. It reads the source file, extracts candidate texts (JSON or Markdown), maps each to a memory type by source (`health` → `known-mistake`, `review`/`job`/`skill-verifier` → `lesson`), checks for duplicates and conflicts against existing entries, applies the security write seam (`guardOutput`) before any disk write, and performs Mem0-style reconciliation (appending a provenance note to an existing entry rather than creating a duplicate).

## Key concepts

- **MemoryEntry** — the core domain object. A parsed representation of one `.md` file: type, title, status, confidence, summary, details, tags, scopes, and bitemporal fields (`validFrom`, `validTo`, `recordedAt`, `supersedes`, `supersededBy`).

- **MemoryStatus** — lifecycle state of an entry: `draft | accepted | deprecated | conflict | superseded`. Accepted entries receive the highest status boost in ranking; superseded entries are excluded from default "current" queries.

- **MemoryClass** — a three-way knowledge classification (`semantic | episodic | procedural`) used for filtering and procedural injection. Every memory type maps to exactly one class (e.g. `decision` → `semantic`, `lesson` → `episodic`, `pattern` → `procedural`). The mapping is enforced to be total via an exhaustiveness assertion in `types.ts`.

- **MemoryType** — one of eleven named entry kinds (e.g. `lesson`, `decision`, `constraint`, `known-mistake`, `incident`) each mapped to a filesystem folder. Template-able types have an MVP Markdown scaffold.

- **ScoredEntry** — a search result wrapper that pairs a `MemoryEntry` with a weighted composite score and per-dimension breakdowns (`relevance`, `recency`, `confidence`, `status`, `scope`), enabling transparent ranking explanation.

- **MemoryConfig** — the project-local configuration object that controls ranking weights, recency decay, dedup thresholds, ingest defaults, the opt-in embedding index, bitemporal behavior, and class injection limits. Loaded from `.metaproject/memory.config.json` with deep-merge fallback to `DEFAULT_MEMORY_CONFIG`.

- **Bitemporal fields** — optional `Valid-From` / `Valid-To` header fields on an entry that enable point-in-time queries (`asOf`) and automatic exclusion of expired or superseded entries from the default "current" search.

## Main flows

**1. Pure memory search (`keryx memory search <query>`).**
`service.ts` scans canonical Markdown through `store.ts`, applies validated
status/class/scope/temporal filters, ranks bounded results, and returns them
without writing files or consuming a generated catalog. `--semantic` may
rerank a bounded lexical candidate pool through the optional embedding seam;
failure falls back to lexical results. `--save-report` is a separate explicit
operation that validates and atomically publishes a unique bounded Markdown/JSON
report under ignored `.metaproject/runtime/memory/`.

**2. Automated ingest from a health or review artifact.**
`service.ts` delegates to `ingestMemory()`, which extracts candidate text,
maps it to a type, checks duplicate/conflict state, applies the security write
seam, and creates or reconciles draft entries. It never auto-accepts content.

**3. Manual creation and lifecycle transition.**
`create()` validates type and writes a draft through the guarded seam. The
explicit `transition` command validates allowed edges, next headers, path
confinement, and security before same-directory atomic replacement; repeated
transitions are idempotent and invalid/terminal edges preserve bytes.

**4. Non-destructive supersession.**
`supersede` pre-validates and guards both entries, closes the old validity
interval, records provenance/changelog metadata, and retains both Markdown
files for git-diffable history.

---

<!-- keryx:reference:begin v=1 hash=fc80fb1e0e4dec1750a59d26b81ee1216eca881c51e8a7263e5738f293f5831b -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `MemoryStatus`
- `MEMORY_STATUS_VALUES`
- `Confidence`
- `MemoryTypeConfig`
- `MEMORY_TYPES`
- `MEMORY_TYPE_VALUES`
- `MemoryClass`
- `MEMORY_CLASS_VALUES`
- `MEMORY_CLASS_MAP`
- `classForType` (function)
- `MemoryScopes`
- `MemoryEntry`
- `memoryClassOf` (function)
- `MemoryConfig`
- `SearchFilters`
- `ScoredEntry`
- `DuplicateHint`
- `ConflictHint`
- `MemoryCreateInput`
- `MemoryCreateResult`

### Key files

- `src/memory/types.ts` - imported by 29, imports 0
- `src/memory/service.ts` - imported by 8, imports 16
- `src/memory/config.ts` - imported by 19, imports 4
- `src/memory/store.ts` - imported by 20, imports 2
- `src/memory/search.ts` - imported by 8, imports 4
- `src/memory/relevant.ts` - imported by 6, imports 5

### Depends on

- `src/lib` - 12 import(s)
- `src/memory/embedding` - 2 import(s)
- `src/commands` - 1 import(s)
- `src/wiki` - 1 import(s)
- `src/capability` - 1 import(s)
- `src/security` - 1 import(s)

### Depended on by

- `src/commands` - 12 import(s)
- `src/flow` - 8 import(s)
- `src/sac` - 7 import(s)
- `src/harness/tool` - 5 import(s)
- `src/memory/embedding` - 5 import(s)
- `src/wiki` - 4 import(s)

### Graph signals

- Files: 37
- Cross-module imports: 18
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived — regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/security](src-security.md)
- [Module src/memory/embedding](src-memory-embedding.md)
- [Module src/wiki](src-wiki.md)
- [Module src/capability](src-capability.md)
- [Module src/commands](src-commands.md)
- [Module src/flow](src-flow.md)
- [Module src/gdskills](src-gdskills.md)

## Changelog

- 1.1.1 - Reference refreshed from the code graph (5886c474).
- **1.1.0** — Documented pure recall, explicit disposable reports, accepted/current automatic projections, guarded lifecycle transitions, and non-destructive supersession.
- **1.0.0** — Prose sections enriched from code (config.ts, store.ts, service.ts, search.ts, ingest.ts, types.ts). Status set to accepted.
- **0.1.0** — Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

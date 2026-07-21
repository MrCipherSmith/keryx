---
Title: Module src/memory
Version: 1.0.0
Type: component
Status: accepted
Summary: `src/memory` groups 25 file(s). Depends on `src/lib`, `src/security`, `src/memory/embedding`. Exposes 5 public symbol(s).

# Module src/memory

## Summary

`src/memory` groups 25 file(s). Depends on `src/lib`, `src/security`, `src/memory/embedding`. Exposes 5 public symbol(s).

## Overview

`src/memory` is keryx's long-lived project knowledge store. It owns the full lifecycle of typed memory entries — creating, indexing, searching, ingesting, and superseding Markdown files that live under `.metaproject/memory/`. The module gives agents and humans a queryable, ranked, and deduplicated record of lessons, decisions, constraints, known mistakes, and related observations accumulated during a project's lifetime. It is the primary dependency of `src/commands` (9 imports) and is also consumed by `src/flow`, `src/wiki`, and the MCP layer.

## How it works

The module is organized into three logical layers that compose from the bottom up.

### Data layer (`store.ts`)

The source of truth. It walks the filesystem under `.metaproject/memory/`, reads every Markdown file in the typed sub-folders registered in `MEMORY_TYPES` (e.g. `lessons/`, `decisions/`, `constraints/`, `known-mistakes/`), and parses each file into a `MemoryEntry` struct. Parsing is purely text-based — the store splits files into header fields (`field()`) and named Markdown sections (`splitSections()`), then populates bitemporal fields (`validFrom`, `validTo`, `recordedAt`), scope annotations, and the resolved `MemoryClass` (`semantic | episodic | procedural`) without any external dependency.

### Search layer (`search.ts`)

Operates entirely on in-memory `MemoryEntry` arrays and never touches the filesystem itself. It runs a deterministic lexical scoring pipeline:

- Entries are first filtered by status, module/entity scope, knowledge class, and a bitemporal validity window.
- Then scored across five configurable dimensions (relevance, recency, confidence, status boost, scope match) whose weights come from `MemoryConfig`.
- The top-k results are returned as `ScoredEntry` objects with per-dimension score breakdowns.

On the opt-in semantic path (`filters.semantic === true` or `config.index.enabled`), `search.ts` also exposes a `candidatePool` function used by `service.ts` to widen the candidate set before embedding reranking.

### Service layer (`service.ts`)

The single public façade created by `createMemoryService()`. It orchestrates the data and search layers plus a set of peer modules (`ingest.ts`, `dedup.ts`, `check.ts`, `supersede.ts`, `templates.ts`) to implement the full `MemoryService` interface. When embedding support is requested, it resolves an `Embedder` through `src/capability`'s capability seam (`resolveCapability`) and delegates to `src/memory/embedding` for index build and cosine reranking; when the capability is unavailable the service degrades silently to the lexical result. Search and index operations write their outputs as artifacts under `.metaproject/data/memory/`.

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

### 1. Agent memory search (`keryx memory search <query>`)

`service.ts`'s `search()` method:

1. Calls `loadMemoryConfig()` to get ranking weights.
2. Calls `collectEntries()` (via `store.ts`) to scan `.metaproject/memory/` and parse all Markdown files into `MemoryEntry` objects.
3. `searchEntries()` in `search.ts` filters entries by status, class, scope, and temporal validity, scores each candidate across five dimensions, sorts by composite score, and returns the top-k `ScoredEntry` list.
4. The service writes the results as `latest.md` and `latest.json` under `.metaproject/data/memory/artifacts/`.
5. If `filters.semantic === true`, the service widens the candidate pool via `candidatePool()` and reranks it through the embedding adapter before slicing to the limit.

### 2. Automated ingest from a health or review artifact (`keryx memory ingest --source health <file>`)

`service.ts`'s `ingest()` method delegates to `ingestMemory()` in `ingest.ts`:

1. Reads the source file.
2. Extracts candidate text snippets (preferring structured JSON fields such as `message`, `summary`, `recommendation`; falling back to Markdown lines).
3. Maps them to the `known-mistake` or `lesson` type based on the declared source.
4. Checks each candidate against existing entries with `findDuplicates()` and `findConflicts()`.
5. For near-duplicates it reconciles in place (Mem0-style UPDATE); for genuinely new entries it runs the security write gate (`guardOutput`) and writes a fresh Markdown file under the appropriate type folder.
6. Returns counts of created, reconciled, and skipped entries.

### 3. Manual entry creation (`keryx memory create --type decision --title "Use X"`)

`service.ts`'s `create()` method:

1. Validates the type against `MEMORY_TYPES`.
2. Derives a slug.
3. Loads config for the default confidence level.
4. Checks for near-duplicates in the current store (returning them as advisory `DuplicateHint` objects without blocking).
5. Writes a scaffolded Markdown file via `renderMemoryEntry()` from `templates.ts`.
6. The resulting entry starts in `draft` status and is not yet queryable with the default "accepted"-boosted search until manually reviewed and accepted.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by `--force`. The prose sections above are the agent/human-owned part.

### Public API

- `DEFAULT_MEMORY_CONFIG`
- `memoryConfigPath` (function)
- `loadMemoryConfig` (function)
- `renderMemoryConfig` (function)
- `createMemoryService` (function)

### Key files

- `src/memory/config.ts` — imported by 15, imports 2
- `src/memory/service.ts` — imported by 4, imports 13
- `src/memory/store.ts` — imported by 12, imports 2
- `src/memory/types.ts` — imported by 10, imports 0
- `src/memory/ingest.ts` — imported by 3, imports 5
- `src/memory/search.ts` — imported by 6, imports 2

### Depends on

- `src/lib` — 8 import(s)
- `src/security` — 2 import(s)
- `src/memory/embedding` — 2 import(s)
- `src/wiki` — 1 import(s)
- `src/capability` — 1 import(s)

### Depended on by

- `src/commands` — 9 import(s)
- `src/flow` — 4 import(s)
- `src/memory/embedding` — 4 import(s)
- `src/wiki` — 3 import(s)
- `src/gdskills` — 1 import(s)
- `src/mcp` — 1 import(s)

### Graph signals

- Files: 25
- Cross-module imports: 14

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

- **1.0.0** — Prose sections enriched from code (config.ts, store.ts, service.ts, search.ts, ingest.ts, types.ts). Status set to accepted.
- **0.1.0** — Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

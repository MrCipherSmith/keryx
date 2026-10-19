---
Title: Module src/memory
Version: 1.1.4
Type: component
Status: accepted
VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df
VerifiedScope: sha256:ae32444bb6f6ab6b592761fd282aaadb80b4a2690211ef232207fb440d8797bf
Summary: "`src/memory` is the long-lived project knowledge store: it creates, catalogs, searches, ingests, transitions and supersedes typed Markdown memory entries under `.metaproject/memory/`."
---

# Module src/memory

## Summary

`src/memory` is keryx's long-lived project knowledge store. It owns the full lifecycle of typed memory entries: creating, cataloging, searching, ingesting, transitioning, and superseding Markdown files under `.metaproject/memory/`. The module provides agents and humans with a queryable, ranked, bounded record while automatic consumers receive only accepted/current scoped projections.

## Overview

The file count, public symbols, and the modules `src/memory` depends on and is used by are listed in the Reference section below, which is regenerated from the code graph.

### Design Principles

- **Markdown is canonical.** Catalogs, embedding caches, and saved reports are disposable generated views.
- **Pure recall is default.** `search()` returns results without writing files or consuming generated catalogs.
- **Explicit persistence.** Only `--save-report` writes bounded unique reports under `.metaproject/runtime/memory/`.
- **Graceful degradation.** Semantic search falls back to lexical results when embedding capability is unavailable.

## How it works

The module is organized into three logical layers that compose from the bottom up.

### Data Layer (`store.ts`)

The source of truth.

- Walks the filesystem under `.metaproject/memory/`
- Reads every Markdown file in typed sub-folders registered in `MEMORY_TYPES`
- Parses each file into a `MemoryEntry` struct

Parsing is purely text-based with no external dependencies:

- Splits files into header fields via `field()`
- Extracts named Markdown sections via `splitSections()`
- Populates bitemporal fields (`validFrom`, `validTo`, `recordedAt`)
- Resolves scope annotations and `MemoryClass` (`semantic | episodic | procedural`)

### Search Layer (`search.ts`)

Operates entirely on in-memory `MemoryEntry` arrays. Never persists a report.

**Scoring pipeline:**

1. Filter by status, module/entity scope, knowledge class, and bitemporal validity window
2. Score across five dimensions (weights from `MemoryConfig`):
   - Relevance
   - Recency
   - Confidence
   - Status boost
   - Scope match
3. Return top-k results as `ScoredEntry` with per-dimension breakdowns

**Semantic path** (opt-in via `filters.semantic === true` or `config.index.enabled`):

- `candidatePool()` function widens bounded candidate set before embedding reranking
- Used by `service.ts` for embedding reranking
- Capability failure falls back to lexical results

### Service Layer (`service.ts`)

The single public façade created by `createMemoryService()`.

**Orchestrates:**

- Data layer (`store.ts`)
- Search layer (`search.ts`)
- Peer modules:
  - `ingest.ts`
  - `dedup.ts`
  - `check.ts`
  - `supersede.ts`
  - `templates.ts`

**Embedding integration:**

- Resolves `Embedder` through `src/capability`'s capability seam (`resolveCapability`)
- Delegates to `src/memory/embedding` for index build and cosine reranking
- Degrades silently to lexical results when capability is unavailable

**Operations:**

- `memory index` — writes optional disposable catalog/cache
- `search()` — pure, no side effects
- `--save-report` — atomically publishes bounded unique report

### Configuration (`config.ts`)

Thin layer that:

1. Reads optional `.metaproject/memory.config.json`
2. Deep-merges it over `DEFAULT_MEMORY_CONFIG`

**Tunable parameters:**

- Ranking weights
- Dedup thresholds
- Ingest defaults
- Embedding settings

### Ingest Pipeline (`ingest.ts`)

Bridges external tool outputs into memory entries.

**Supported sources:**

- Health reports → `known-mistake`
- Code reviews → `lesson`
- Job results → `lesson`
- Skill verifier → `lesson`

**Pipeline steps:**

1. Read source file
2. Extract candidate texts (JSON or Markdown)
3. Map to memory type by source
4. Check for duplicates and conflicts
5. Apply security write seam (`guardOutput`)
6. Perform reconciliation (append provenance note to existing entry rather than creating duplicate)

## Key concepts

### MemoryEntry

The core domain object. A parsed representation of one `.md` file containing:

- Type, title, status, confidence
- Summary, details, tags, scopes
- Bitemporal fields (`validFrom`, `validTo`, `recordedAt`, `supersedes`, `supersededBy`)

### MemoryStatus

Lifecycle state: `draft | accepted | deprecated | conflict | superseded`

- Accepted entries receive highest status boost in ranking
- Superseded entries excluded from default "current" queries

### MemoryClass

Three-way knowledge classification:

| Class | Description | Example Types |
|-------|-------------|---------------|
| `semantic` | Declarative knowledge | decision |
| `episodic` | Experience-based | lesson |
| `procedural` | How-to knowledge | pattern |

Every memory type maps to exactly one class via exhaustiveness assertion in `types.ts`.

### MemoryType

Eleven named entry kinds (e.g., `lesson`, `decision`, `constraint`, `known-mistake`, `incident`). Template-able types have MVP Markdown scaffolds.

### ScoredEntry

Search result wrapper pairing `MemoryEntry` with:

- Weighted composite score
- Per-dimension breakdowns: relevance, recency, confidence, status, scope

Enables transparent ranking explanation.

### MemoryConfig

Project-local configuration controlling:

- Ranking weights
- Recency decay
- Dedup thresholds
- Ingest defaults
- Embedding index settings
- Bitemporal behavior
- Class injection limits

Loaded from `.metaproject/memory.config.json` with deep-merge fallback to `DEFAULT_MEMORY_CONFIG`.

### Bitemporal Fields

Optional `Valid-From` / `Valid-To` header fields enabling:

- Point-in-time queries (`asOf`)
- Automatic exclusion of expired or superseded entries

## Main flows

### 1. Pure Memory Search

```bash
keryx memory search <query>
```

1. `service.ts` scans canonical Markdown via `store.ts`
2. Applies validated status/class/scope/temporal filters
3. Ranks bounded results
4. Returns without writing files or consuming generated catalog

**Options:**

- `--semantic` — reranks bounded lexical candidate pool through optional embedding seam
- `--save-report` — explicit separate operation that validates and atomically publishes unique bounded report

### 2. Automated Ingest

Process health or review artifacts automatically.

1. `service.ts` delegates to `ingestMemory()`
2. Extracts candidate text
3. Maps to type
4. Checks duplicate/conflict state
5. Applies security write seam
6. Creates or reconciles draft entries

**Note:** Never auto-accepts content.

### 3. Manual Creation and Lifecycle Transition

**Create:**

1. `create()` validates type
2. Writes draft through guarded seam

**Transition:**

1. `transition` command validates:
   - Allowed edges
   - Next headers
   - Path confinement
   - Security
2. Same-directory atomic replacement
3. Repeated transitions are idempotent
4. Invalid/terminal edges preserve bytes

### 4. Non-destructive Supersession

1. `supersede` pre-validates and guards both entries
2. Closes old validity interval
3. Records provenance/changelog metadata
4. Retains both Markdown files

Both files remain available for git-diffable history.

<!-- keryx:reference:begin v=1 hash=90016a0146851228ffbf967327491689690b178eb5eaf27fd26b0b31d59770d0 -->
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
- `classForType`
- `MemoryScopes`
- `MemoryEntry`
- `memoryClassOf`
- `MemoryConfig`
- `SearchFilters`
- `ScoredEntry`
- `DuplicateHint`
- `ConflictHint`
- `MemoryCreateInput`
- `MemoryCreateResult`

### Key files

- `src/memory/types.ts` - imported by 35, imports 0
- `src/memory/service.ts` - imported by 15, imports 18
- `src/memory/store.ts` - imported by 28, imports 5
- `src/memory/config.ts` - imported by 23, imports 4
- `src/memory/search.ts` - imported by 12, imports 5
- `src/memory/relevant.ts` - imported by 7, imports 5

### Depends on

- `src/lib` - 10 import(s)
- `src/wiki` - 3 import(s)
- `src/memory/embedding` - 2 import(s)
- `src/capability` - 1 import(s)
- `src/security` - 1 import(s)

### Depended on by

- `src/commands` - 15 import(s)
- `src/sac` - 7 import(s)
- `src/wiki` - 7 import(s)
- `src/flow` - 6 import(s)
- `src/harness/tool` - 4 import(s)
- `src/mcp` - 4 import(s)

### Dependency basis

- Production imports only: 24 import(s) from test file(s) (e.g. `src/commands/agent-approval-context-p0.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 46
- Cross-module imports: 17
<!-- keryx:reference:end -->

## Related Pages

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

- 1.1.3 - Reference refreshed from the code graph. Source graph was stale; VerifiedAt was not advanced.
| Version | Changes |
|---------|---------|
| 1.1.4 | Restored the detailed prose (Overview, How it works, Key concepts, Main flows) that the 1.1.2 unwrap dropped because the front matter had no closing line; closed the front matter |
| 1.1.2 | Unwrapped from the markdown code fence an earlier enrich left around the page; no content changed. |
| 1.1.1 | Reference refreshed from code graph (5886c474) |
| 1.1.0 | Documented pure recall, explicit disposable reports, accepted/current projections, guarded lifecycle transitions, non-destructive supersession |
| 1.0.0 | Prose enriched from code (config.ts, store.ts, service.ts, search.ts, ingest.ts, types.ts). Status set to accepted |
| 0.1.0 | Initial draft generated by `keryx wiki collect` |

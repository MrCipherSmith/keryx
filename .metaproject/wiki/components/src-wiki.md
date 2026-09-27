---
Title: Module src/wiki
Version: 1.0.2
Type: component
Status: accepted
VerifiedAt: 4e80355f1b9fa8576742d151d54397abbd527b38
VerifiedScope: sha256:efbece62df36a579c3c2cb2e1a29804e1ce674bd6ac9a0540f89b71c65fa299e
---

# Module src/wiki

## Summary

`src/wiki` owns the keryx project knowledge base: Markdown pages stored under `.metaproject/wiki/`. It provides CLI-facing logic for creating and indexing pages, checking links, validating the collection, generating graph-driven drafts, and answering questions using wiki and memory content. It also includes utilities for enriching pages and finding pages that reference a source file.

## Overview

The module is the persistence and retrieval layer for project documentation intended to outlast individual tasks. Its public contract is consumed by command and MCP integrations. The module depends on graph, library, provider, memory, tool, and security functionality; see the reference section for current dependency details.

## Architecture

The module is organized around cooperating responsibilities:

| Responsibility | Files | Purpose |
|---|---|---|
| Service and domain types | `service.ts`, `types.ts` | Implement wiki operations and define their shared data structures |
| Question answering | `ask.ts` | Retrieve and rank wiki and memory candidates |
| Link lookup | `backlinks.ts` | Build reverse lookups from outgoing links |
| Rendering | `templates.ts` | Render page scaffolds and managed index content |
| Collection | `collect.ts` | Gather and rank candidate pages |
| Enrichment | `enrich.ts`, `deep-enrich.ts` | Plan or perform page enrichment using additional context |

### Service and page handling

`service.ts` provides core wiki operations and assembles them into the `GdWikiService` facade returned by `createGdWikiService`.

Pages are loaded through `collectPages`. This reads the typed directory tree under `.metaproject/wiki/`, parses page frontmatter such as `Version`, `Type`, and `Status`, and extracts each page's summary. Writes pass candidate content through `guardOutput` from `src/security` before it is written to disk.

The collection workflow uses code-graph data to rank modules and produce candidate pages. It can also gather candidates from health and testing context. Generated pages begin as drafts; regeneration is intended to preserve human-authored content rather than overwrite it.

### Types

`types.ts` defines the domain model, including:

- **`WikiPageType`** — the page categories used to determine a page's folder and purpose.
- **`WikiPage`** — the in-memory representation of a parsed page, including its path, type, frontmatter fields, and summary.
- **`WikiCollectedPage`** — a page type, slug, and rendered Markdown content prepared for collection.
- **`WikiAskCitation`** — a citation returned by the question-answering operation.
- **`GdWikiService`** — the service contract used by integrations.

The supported page categories and their folder mappings are defined by `WIKI_PAGE_TYPES`. Validation checks that a page's declared type matches its folder.

### Question answering

`ask.ts` combines candidates from wiki pages and memory entries. It scores candidates against the question using token overlap and returns citations assembled into a Markdown answer. An optional embedding-based rerank can adjust candidate order when the embedding capability is available. Candidate retrieval remains local; the rerank capability does not change candidate provenance.

### Backlinks

`backlinks.ts` builds a reverse index from wiki pages' outgoing references. It recognizes Markdown links and inline code that resembles source-file paths, then resolves targets relative to the repository root. The index supports lookups such as which wiki pages document a given source file.

### Rendering and enrichment

`templates.ts` contains rendering functions for page and index scaffolds, as well as related generated content. Sentinel markers delimit the managed section of `wiki/index.md`, allowing that section to be updated separately from surrounding human-written content.

The enrichment files provide functionality for selecting pages and planning or performing enrichment. Their exported symbols are listed in the reference section.

## Key Concepts

- **Page type** — A category that determines where a page belongs and what kind of knowledge it describes. The page's `Type` frontmatter value must agree with its directory.
- **Parsed page** — The in-memory representation of a wiki file, including its path, frontmatter values, and summary.
- **Collected page** — A rendered candidate produced from graph or other project context. Collection logic decides whether it can be written.
- **Draft and accepted status** — Generated pages use `Status: draft`. Draft markers help distinguish generated content from content that should be preserved as human-owned.
- **Backlink index** — A reverse map from wiki or source-file targets to pages that reference them.
- **Output security check** — Candidate content is checked with `guardOutput` before filesystem writes. The security policy determines whether a candidate can be written.

## Main Flows

### Collect pages

1. The collection workflow reads code-graph data and groups files by module.
2. It ranks modules using graph-derived information and renders page candidates.
3. It gathers additional candidates from health and testing context where available.
4. Before writing a candidate, it checks whether existing content is eligible for regeneration and applies the output security check.
5. It updates the managed section of the wiki index.
6. It records provenance for the collection run.

### Validate the wiki

1. `wikiValidate` loads pages and their parsed frontmatter.
2. It checks required fields and verifies that page types match their folders.
3. Link checking scans Markdown files under the wiki root, excluding `templates/`, and reports unresolved local targets.
4. The validation flow checks whether the generated index content is stale.
5. Link-check results are written to the latest report location.

### Answer a question

1. `wikiAsk` loads wiki pages and eligible memory entries.
2. It scores candidates against the tokenized question.
3. If requested and available, embedding similarity reranks the candidates.
4. It returns citations and assembles a Markdown answer.

---

<!-- keryx:reference:begin v=1 hash=d2f9593ad7c88ffaf33945259757c48fbe4075f762ce7670f92d2b11162a425f -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `wikiStatus` (function)
- `wikiCreatePage` (function)
- `wikiGenerateIndex` (function)
- `wikiCheckLinks` (function)
- `wikiValidate` (function)
- `wikiCollect` (function)
- `WikiPruneResult` (interface)
- `wikiPruneOrphans` (function)
- `validModuleNames` (function)
- `WikiEvidenceInput`
- `wikiEvidence` (function)
- `GdWikiEvidenceService`
- `createGdWikiService` (function)
- `collectGraphWikiCandidates` (function)
- `isTestSourceFile` (function)
- `extractModuleApi` (function)
- `DEFAULT_MAX_OUTPUT_TOKENS`
- `DEFAULT_CONCURRENCY`
- `MAX_CONCURRENCY`
- `WikiEnrichInput` (interface)

### Key files

- `src/wiki/service.ts` - imported by 23, imports 16
- `src/wiki/enrich.ts` - imported by 6, imports 19
- `src/wiki/collect.ts` - imported by 19, imports 4
- `src/wiki/types.ts` - imported by 21, imports 2
- `src/wiki/ask.ts` - imported by 9, imports 11
- `src/wiki/deep-enrich.ts` - imported by 2, imports 14

### Depends on

- `src/gdgraph` - 13 import(s)
- `src/lib` - 11 import(s)
- `src/memory` - 7 import(s)
- `src/harness/provider` - 4 import(s)
- `src/harness/tool` - 3 import(s)
- `src/memory/embedding` - 2 import(s)

### Depended on by

- `src/commands` - 15 import(s)
- `src/harness/tool` - 10 import(s)
- `src/forgetting` - 5 import(s)
- `src/gdgraph` - 4 import(s)
- `src/wiki/freshness` - 4 import(s)
- `scripts/benchmark` - 3 import(s)

### Dependency basis

- Production imports only: 38 import(s) from test file(s) (e.g. `src/commands/sync-forgetting.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 48
- Cross-module imports: 52
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/memory](src-memory.md)
- [Module src/memory/embedding](src-memory-embedding.md)
- [Module src/lib](src-lib.md)
- [Module src/capability](src-capability.md)
- [Module src/security](src-security.md)
- [Module src/sync](src-sync.md)
- [Module src/commands](src-commands.md)
- [Module src/gdskills](src-gdskills.md)

## Changelog

- 1.0.2 - Reference refreshed from the code graph (4e80355f).
- 1.0.1 - Reference refreshed from the code graph (5886c474).
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

# Plan

## Chosen approach

Additive extension of existing types, exactly as the symbol layer was added:
every new field is optional, and a graph written by an older keryx must keep
loading. No new module, no new storage file — `nodes.jsonl` and `edges.jsonl`
gain fields and one edge kind.

Reuse is mandatory where machinery exists. The module set comes only from
`validModuleNames` (`src/wiki/service.ts:358`) and grouping only from
`moduleNameFromProjectPath` (`:1213`); both were extracted precisely so a
second consumer never re-derives grouping (RP-13 FR3+FR4, flow 168). There are
two consumers today (`wikiPruneOrphans`, `src/sac/lifecycle-flag.ts`); this
makes three.

`VerifiedScope` is built by generalising the existing `computePageNodeHash`
(`src/wiki/staleness.ts:51-77`) from "top-6 key files" to the whole resolved
describe-set, rather than writing a second hashing routine.

## Steps

1. **Types** (`src/gdgraph/types.ts`): `GraphNode.kind` gains `"wiki-page"`,
   `language` gains `"markdown"`, plus optional `contentHash`/`mtimeMs`.
   `GraphEdge.kind` gains `"describes"`, plus optional `describesOrigin`.
2. **Hashes during build** (`src/gdgraph/build.ts`): compute sha256 and record
   mtime per file node. Measure the build-time cost; if it is material, note
   it in the journal rather than hiding it.
3. **Describe-set resolution** (`src/wiki/` — new small module): resolve a
   page to its described paths from `Describes:` frontmatter, then
   `## Related Code` links, then `computeModuleKeyFiles`, with that
   precedence, recording origin.
4. **Wiki nodes and edges into the graph** (`src/gdgraph/build.ts`): emit
   `wiki:<relativePath>` nodes and `describes` edges. Guard: when
   `validModuleNames()` is `undefined` the wiki layer is skipped entirely — an
   unbuilt graph means "nothing to say", never "everything is orphaned".
5. **Page provenance** (`src/wiki/`): parse and write `VerifiedAt` and
   `Describes` in frontmatter; compute `VerifiedScope` over the resolved
   describe-set; `WikiPage` gains the fields.
6. **Reverse query**: "pages describing file X" over the existing incoming-edge
   index. Expose through the existing gdgraph query surface only — no new CLI
   command in this phase.
7. **Tests** per AC, including the back-compat load of a pre-existing graph
   and the graph-unavailable posture.

## Rejected alternatives

- **A separate page↔code index file.** Rejected: a second store to keep in
  sync with the graph, and it would not answer traversal questions that cross
  from a page into imports.
- **Deriving the describe-set only from key files.** Rejected: an
  architecture page has no key files of its own, and a partially-described
  module would produce false positives. Explicit frontmatter must be able to
  override.
- **Starting from `enrich` (the source report's order).** Rejected: it pays
  the most expensive step first and closes neither the missing edge nor the
  frozen Reference. Recorded in the package PRD's recommendation.
- **Model-assisted describe-set inference.** Rejected for phase 0: the whole
  point of this phase is that it is deterministic and free.

## Risks

- Hashing every file adds build time — measure, and fall back to hashing
  lazily if it proves material.
- Pages whose describe-set resolves empty (architecture, decisions —
  11 of 53 pages here) must be representable as "undecidable", not silently
  treated as fresh or as orphans.
- `describes` edges enlarge `edges.jsonl`; expected small next to the existing
  9.7 MB `calls.jsonl`, but worth confirming rather than assuming.

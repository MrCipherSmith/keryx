# Acceptance Criteria

Phase 0 of `docs/requirements/keryx-living-wiki-graph/` (specification 1.4.0).
Each row names the package criterion it implements.

- AC1: After a graph build, `storage/wiki-pages.jsonl` contains a
  `WikiPageNode` with `id: "wiki:<relativePath>"` for every page under
  `.metaproject/wiki/`, and `storage/describes.jsonl` contains at least one
  `DescribesEdge` for every page whose describe-set resolves non-empty.
  `nodes.jsonl` and `edges.jsonl` are unchanged by the wiki layer.
  (package AC-1)

- AC2: A graph fixture written before this change — no `wiki-pages.jsonl`,
  no `describes.jsonl`, no `build-manifest.json` — loads through `loadGraph`
  without error, with `wikiPages`/`describes` simply absent, and every
  existing gdgraph consumer behaves identically on it. (package AC-2)

- AC3: A reverse query for a file covered by more than one page returns all of
  those pages and no others. (package AC-3)

- AC4: `describes` resolution honours precedence: a page with a `Describes:`
  frontmatter list produces edges only from that list
  (`describesOrigin: "frontmatter"`); with no frontmatter but `## Related Code`
  links, only from those; otherwise from `computeModuleKeyFiles` with
  `describesOrigin: "key-files"`. (specification §3.3)

- AC5: The module set and path-to-module grouping are obtained from
  `validModuleNames` and `moduleNameFromProjectPath`; a test that stubs
  `validModuleNames` changes the emitted wiki layer accordingly, proving no
  second derivation exists. (package AC-27)

- AC13: No wiki-layer record ever reaches `nodes.jsonl` or `edges.jsonl`.
  A build with the wiki layer active produces `nodes.jsonl`/`edges.jsonl`
  byte-identical to a build with it inactive, and `validModuleNames` returns
  the same module set either way — it must never mint a module from a wiki
  path. This is the regression that forced the layer split: five call sites
  treat every non-`asset` node as a source file.

- AC6: When `validModuleNames()` returns `undefined` (graph not built), the
  build emits no `wiki-page` nodes and no `describes` edges, and does not
  error. An absent graph must never be read as "every page is orphaned".
  (package AC-24)

- AC7: `storage/build-manifest.json` carries a `FileFingerprint`
  (`contentHash` sha256 + `mtimeMs`) for every source file, and two builds
  with no intervening edit produce identical `contentHash` values for every
  unchanged file. `GraphNode` itself is not extended, so `nodes.jsonl` stays
  byte-stable for its existing consumers. (LWG-2)

- AC8: A page's frontmatter `VerifiedAt` and `Describes` round-trip: parsed
  into the page model, and written back without altering any other byte of
  the file (verified by diff). (LWG-4)

- AC9: `VerifiedScope` is computed over the whole resolved describe-set, not
  only the top-6 key files: a page whose describe-set includes a seventh file
  changes its `VerifiedScope` when that seventh file changes. This is the
  defect in today's `computePageNodeHash` that phase 0 must not inherit.
  (specification §4.1, PRD P4)

- AC10: A page whose describe-set resolves empty is reported as undecidable —
  never as fresh, never as orphan. Verified on a real `architecture/*` page
  from this repository. (package AC-26, AC-20)

- AC11: No code path added in this flow reads or writes inside `.git/`; the
  suite passes on a worktree copy with `.git/` removed. (package AC-23)

- AC12: `bun test` passes, and the graph build over this repository completes
  with the new hashing without regression in behaviour. Any build-time
  increase is measured and recorded in the journal — reported honestly
  whichever way it comes out.

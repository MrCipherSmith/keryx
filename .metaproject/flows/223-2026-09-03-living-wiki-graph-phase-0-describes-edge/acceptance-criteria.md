# Acceptance Criteria

Phase 0 of `docs/requirements/keryx-living-wiki-graph/` (specification 1.4.0).
Each row names the package criterion it implements.

- AC1: After a graph build, `nodes.jsonl` contains a node with
  `kind: "wiki-page"` and `id: "wiki:<relativePath>"` for every page under
  `.metaproject/wiki/`, and `edges.jsonl` contains at least one edge with
  `kind: "describes"` for every page whose describe-set resolves non-empty.
  (package AC-1)

- AC2: A graph fixture written before this change — file nodes without
  `contentHash`/`mtimeMs`, edges without `describesOrigin` — loads through
  `loadGraph` without error, and every existing gdgraph consumer behaves
  identically on it. (package AC-2)

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

- AC6: When `validModuleNames()` returns `undefined` (graph not built), the
  build emits no `wiki-page` nodes and no `describes` edges, and does not
  error. An absent graph must never be read as "every page is orphaned".
  (package AC-24)

- AC7: Every file node carries `contentHash` (sha256 of file content) and
  `mtimeMs`; two builds with no intervening edit produce identical
  `contentHash` values for every unchanged file. (package AC-2, LWG-2)

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

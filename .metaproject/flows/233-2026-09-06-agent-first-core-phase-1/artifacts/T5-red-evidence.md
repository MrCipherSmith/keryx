# T5 containment RED evidence

- Timestamp: `2026-09-06T11:43:29Z`
- Test command: `bun test src/mcp/resources-containment.test.ts src/harness/tool/metaproject-adapter-containment.test.ts src/lib/contained-read.test.ts`
- Captured through: `keryx ctx run -- bun test ...`
- Exit code: `1`
- Result: `2 pass`, `13 fail`, `14 expect() calls`, 15 tests across 3 files.
- No production, flow, git, package, network, or model changes.

## Failure signatures

1. MCP external symlink read returned content instead of failing closed.
2. MCP replaced wiki root was followed instead of rejected.
3. MCP listing omitted an internal linked file/directory alias; the external alias was not exposed, but internal links were not enumerated.
4. Harness `readWiki` returned `isError: false` and content for an external symlink and a replaced wiki root.
5. Harness skill discovery skipped an internal linked category and followed a replaced skills root, returning one outside entry.
6. Harness `loadSkill` could not discover the internal linked catalog path.
7. Existing shared lexical containment re-rooted after an owner-root replacement and returned success.
8. The proposed shared reader module is absent; reader tests fail with module-not-found. This is intentional RED evidence for the implementation seam.

## Focused capture

Raw log: `.metaproject/data/gdctx/raw/2026-09-06T11-43-29-104Z_run.log`

Compact report: `.metaproject/data/gdctx/artifacts/2026-09-06T11-43-29-104Z_run.md`

The two passing tests document behavior already present: ordinary MCP reads through internal file/directory links and ordinary harness wiki reads through an internal file link. The suite is RED because containment, owner-root identity, recursive linked discovery, and the shared-reader seam are not implemented.

The deterministic race scenario is represented by the shared-reader `hooks.beforeOpen` fixture: replace the owner root immediately before the injected open boundary and require rejection without the sentinel. This is a seam contract, not a claim that a pathname realpath check followed by readFile is race-safe.

Routing audit: graph_used=gdgraph context; wiki_used=wiki/index.md, src-mcp, src-harness-tool, src-lib; ctx_used=yes; raw_rg_used=no.


# Context

Collected deterministically by `keryx flow init` at 2026-08-10T12:50:23.342Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-10T12:47:23.040Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security

## Agent Findings

- Scope is exactly P2-1 through P2-8 from
  `docs/requirements/keryx-memory-reliability/implementation-plan.md`.
- Canonical data is `.metaproject/memory/**/*.md` and
  `.metaproject/memory.config.json`; generated catalog/index, embeddings,
  runtime reports, temporary/staging files, and legacy `data/memory/artifacts`
  are disposable.
- `renderMetaprojectGitignoreBlock()` currently ignores common generated data
  but not memory index/embeddings/artifacts or runtime memory output. It must
  not ignore canonical `.metaproject/memory/**` entries.
- `createMemoryStructure()` currently creates an artifacts directory and no
  embeddings/runtime directories; update/init both use the generated ignore
  block and must remain non-destructive.
- `renderIndexMarkdown`, `renderMemoryManifest`, and memory templates still
  reference `data/memory/artifacts/latest.md`. `verify.ts` still uses legacy
  artifact existence as `documentation-memory` evidence.
- The Keryx repository currently tracks and has user-modified
  `.metaproject/data/memory/artifacts/latest.md` and `latest.json`. Do not
  delete or stage these dirty files; report P2-3 as a precise concern unless a
  safe repository-source removal is possible without destroying content.
- Existing P0/P1 flow packages and tests are shared-worktree context. Preserve
  unrelated changes and do not edit P3-owned runtime authority surfaces.

## Required verification

- Tests must use actual Git ignore matching for concrete generated paths and a
  canonical entry path after init and update.
- Verify generated memory index and embedding paths are ignored and output is
  reproducible; run focused tests, typecheck, and suitable broader checks.

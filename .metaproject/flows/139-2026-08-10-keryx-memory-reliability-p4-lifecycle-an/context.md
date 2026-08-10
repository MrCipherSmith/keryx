# Context

Collected deterministically by `keryx flow init` at 2026-08-10T18:32:19.619Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-10T13:03:34.223Z)
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

- Requirements source: `docs/requirements/keryx-memory-reliability/` P4 only.
- Lifecycle contract: allowed transitions must be pure, drafts cannot become
  accepted automatically, terminal states reject non-idempotent transitions.
- Canonical entry root is `.metaproject/memory/<typed-folder>/*.md`; generated
  runtime staging is ignored. Same-directory staging is required for replacement.
- Graph selected `src/memory/{service,store,ingest,reflect,supersede,types}.ts`,
  `src/commands/memory.ts`, and memory security/command tests.
- P2 advisory migration concern remains out of scope: preserve dirty tracked
  legacy `latest.*` artifacts exactly as found.
- Baseline prior to P4: P3 focused and changed suites/typecheck passed; the latest
  changed-suite report records four unrelated P0 failures in hook/migration tests.

# Context

Collected deterministically by `keryx flow init` at 2026-08-10T18:41:48.173Z.
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

- Requirements source: `docs/requirements/keryx-memory-reliability/`, P5 only;
  P5-1 through P5-9 are the frozen implementation scope.
- Canonical memory is Markdown under `.metaproject/memory/<type>/*.md`.
  Generated catalogs, embeddings, reports, and runtime files are disposable;
  lexical search must remain offline and must not read the catalog.
- P3 established accepted/current bounded automatic recall, including the
  corrected Valid-To==today behavior; P5 must centralize that rule without
  regressing it across relevant or procedural paths.
- P4 established the unified guarded atomic write seam. Do not bypass it or
  broaden lifecycle/write changes.
- Prior flows 105–109 are intentionally in progress with verified handoffs;
  preserve their dirty files and the P2-3 latest-artifact concern.
- Graph seed: `src/memory/config.ts`, `src/memory/store.ts`,
  `src/memory/relevant.ts`, `src/memory/inject.ts`, `src/memory/service.ts`,
  `src/commands/memory.ts`, and related memory/CLI/config/embedding tests.
- Testing baseline: Bun; `check` is `tsc --noEmit && bun test`; latest changed
  report was 92 passed / 0 failed across 27 selected tests.
- Relevant requirements: README, PRD AC-8/AC-10/AC-11, specification temporal,
  config, catalog, and compatibility contracts, artifact-lifecycle catalog
  rules, and metrics gates M-8–M-10.

# Context

Collected deterministically by `keryx flow init` at 2026-08-10T12:35:53.937Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-10T12:30:40.741Z)
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

- Requirements package: `docs/requirements/keryx-memory-reliability/`; P1 is
  specifically P1-1 through P1-10 in `implementation-plan.md`.
- P0 flow 105 remains in progress with its four tasks done and nine frozen ACs
  confirmed. Its opt-in `KERYX_P0_ENFORCE=1` tests identify only legacy
  `.metaproject/data/memory/artifacts/latest.{md,json}` writes.
- Graph context identified `src/memory/service.ts`, `types.ts`, `search.ts`,
  `store.ts`, `src/commands/memory.ts`, harness adapter/operations, and MCP
  adapters as the immediate contract surface.
- Wiki `src-memory` confirms search is lexical by default and optional semantic
  reranking must fail softly; the wiki's legacy report-write statement is a P1
  target, not proof of desired behavior.
- Accepted-memory search returned no applicable prior decision. Testing baseline
  was 1,833 passed / 0 failed before P0; P0 recorded unrelated live sandbox proxy
  failures during broad checks and an unrelated flow 002 checksum mismatch.
- P1 must preserve all pre-existing dirty P0/requirements files. Only this flow's
  editable package files and P1-scoped implementation/tests may change.

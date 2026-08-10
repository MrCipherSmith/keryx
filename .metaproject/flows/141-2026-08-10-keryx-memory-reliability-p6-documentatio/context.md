# Context

Collected deterministically by `keryx flow init` at 2026-08-10T18:52:42.814Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-10T18:50:13.559Z)
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

### Existing phases and evidence

- Flows 105–110 are verified handoffs and intentionally remain in progress;
  P2-3 is the only deferred item and concerns the tracked legacy latest files.
- P1 baseline full suite was 1853/0; later focused evidence includes P2 24/0,
  changed 80/0, P3 combined 27/0 + typecheck, P4 focused 27/0/changed 92/0,
  and P5 focused 54/0/changed 104/0 plus typecheck.
- Current normalized testing evidence is changed scope 104 passed, 0 failed,
  0 skipped across 30 selected files. Health baseline is a pre-existing warn
  gate (score 92, regression 3) and must be refreshed/classified.

### Required source anchors

- Requirements package: `docs/requirements/keryx-memory-reliability/`;
  P6 checklist is P6-1 through P6-11 in `implementation-plan.md`, with exact
  validation rows in `metrics-and-validation.md` and twelve PRD ACs in `prd.md`.
- Runtime: `src/commands/memory.ts`, `src/commands/module-commands.ts`,
  `src/standard/command-registry.ts`, `src/memory/**`, and integration tests.
- Workspace docs/templates: `src/lib/templates.ts`, `.metaproject/modules/memory.md`,
  `.metaproject/memory/{index.md,templates/entry.md}`, `.metaproject/skills/memory/`,
  `.metaproject/index.md`, and `docs/docs/{cli-reference,modules,architecture,
  complete-setup-and-agent-workflows,workspace-and-lifecycle}.md`.
- Wiki target: accepted `.metaproject/wiki/components/src-memory.md`, followed by
  `keryx wiki index` and link validation.
- Legacy files authorized for removal only after backup/hash verification:
  `.metaproject/data/memory/artifacts/latest.md` and `latest.json`.

### Constraints

Use `keryx ctx rg` for all searches, gdgraph before broad navigation, gdwiki for
domain/architecture context, testing context before tests, and memory search for
accepted history. Use `apply_patch` for repository edits. No commit, push, PR,
staging, dependency install, network, worktree switch, or flow-file hand edits.

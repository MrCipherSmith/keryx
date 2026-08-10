# Context

Collected deterministically by `keryx flow init` at 2026-08-10T12:52:54.188Z.
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

### Requirements and scope

- This flow implements only P3-1 through P3-10 in
  `docs/requirements/keryx-memory-reliability/implementation-plan.md`.
- P0/P1 are verified in-progress handoffs. P2 owns generated-data and migration
  policy concurrently; those surfaces are excluded here.
- The required outcome is automatic accepted/current/bounded recall while the
  explicit diagnostic CLI still permits a requested non-accepted status.

### Navigation and domain context

- gdgraph identified the direct P3 boundaries: memory relevant/injection,
  MetaprojectPort adapter and unified operations, MCP projections, approval
  context, flow context, and gdskills verification.
- Wiki pages `src-memory`, `src-mcp`, `src-flow`, and `src-gdskills` confirm the
  memory Markdown store is canonical, adapters are protocol boundaries, and
  verifier memory must be authoritative rather than a generated artifact.
- Accepted-memory search returned no applicable historical constraints.
- P0 fixtures include accepted, draft, conflict, deprecated, expired, and
  superseded entries plus the Valid-To boundary; P3 extends this matrix with a
  future/not-yet-valid entry and large text cases.

### Baseline risks

- Adapter defaults currently build no status/current filter; unified MCP has a
  legacy direct-service projection; approval relies on the adapter default.
- Flow related-memory selection is not restricted to accepted/current; verifier
  still considers legacy latest report paths as documentation-memory evidence.
- Existing procedural selection is close to the target but needs a hard cap and
  shared current-boundary semantics.

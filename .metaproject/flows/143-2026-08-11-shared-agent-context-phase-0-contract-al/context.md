# Context

Collected deterministically by `keryx flow init` at 2026-08-11T20:10:33.175Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-07-25T23:14:14.158Z)
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

- SAC contracts are normative in `docs/requirements/shared-agent-context/`;
  the codebase currently has no SAC runtime module.
- Security's existing `guardOutput` intentionally fails open when disabled,
  advisory or on error, so it cannot be used as the SAC production guard.
- MCP currently exposes a local transport and redaction seam but has no
  trusted remote principal contract; Phase 0 therefore supplies an in-process
  authorization contract only and leaves adapters deferred.
- Flow remains sole owner of work state; this flow adds no Flow mutation path
  and no knowledge store.
- Existing `src/lib/json.ts` and established TypeScript/Bun test conventions
  are the closest local contract/testing seams.

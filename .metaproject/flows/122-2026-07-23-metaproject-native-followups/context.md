# Context

Collected deterministically by `keryx flow init` at 2026-07-23T20:59:08.978Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-07-21T23:24:45.160Z)
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

Deep-verify audit (read-only) established:

- **S1 CONFIRMED-MISSING**: `RunDeps` at src/harness/run/run.ts:101-109 has no
  metaproject field; the port is wired only in shell.ts / mcp / spawn-subagent /
  tui, not in harness core (`runOffline`).
- **MP-6 PARTIAL**: src/harness/policy/metaproject-escalation.ts:28
  `escalateForBlastRadius` + :54 `metaprojectBlastRadius` exist and are tested,
  but referenced ONLY by their own test — not wired into `decide()` / the run
  loop. `PolicyContext` (src/harness/policy/types.ts:83-90) has no
  `metaprojectContext` field. The primitive defines its own
  `MetaprojectPolicyContext` interface.
- **MP-5a**: `backlinksFor` exported at src/wiki/backlinks.ts:83, surfaced via
  src/wiki/service.ts:814; NOT a port method nor in `METAPROJECT_OPERATIONS`
  (src/harness/tool/metaproject-operations.ts:362 — 11 ops; the `module` union
  already includes "wiki"/"flow" but no backlinks/flow descriptor uses them).
- **Shipped floor is green**: `tsc` clean; metaproject-adapter.test.ts +
  flow/schema.test.ts = 19 pass / 0 fail.

Use `keryx gdgraph affected <file>` before broad reads; workers must read
`.metaproject/index.md` first and route searches through `keryx ctx rg`.

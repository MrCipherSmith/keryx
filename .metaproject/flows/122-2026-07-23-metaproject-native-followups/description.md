# metaproject-native follow-ups (verifiable slice)

Status: formalized
Source: user description + deep-verify audit

## Problem

The keryx-metaproject-native package is PARTIAL (Phases 1-3 shipped). A deep
audit confirmed 5 remaining items. This flow implements only the tractable,
low-risk, fully-verifiable slice; heavy/risky items are deferred with rationale.

## Expected Outcome

- **S1**: harness-core `RunDeps` exposes an optional `metaprojectPort?` threaded
  into `runOffline` (additive; absent => byte-identical deterministic floor).
- **MP-6**: the already-shipped, currently-un-called
  `src/harness/policy/metaproject-escalation.ts` is wired into a policy call-site,
  gated on a supplied port + threshold (default off => decisions unchanged).
- **MP-5a**: `wikiBacklinks` exposed as a `MetaprojectPort` method (backed by the
  existing `src/wiki` `backlinksFor`) and as a `METAPROJECT_OPERATIONS` descriptor
  (read risk), surfaced in the agent + MCP projections.
- Zero new npm dependencies; deterministic; `tsc` clean; targeted tests green.

## Out of Scope (deferred; journaled, not half-built)

- **MP-5b flow read/transition operation**: transition is a WRITE op that must
  route through `FlowService` to preserve the D-02 invariant; needs its own design.
- **Retire the ~9 overlapping legacy MCP adapters** in `src/mcp/tools.ts`: blocked
  on an external-client name-compatibility decision.
- **In-process gdctx search facade** so `search_code` stops shelling out:
  module-level change to gdctx; largest item.

# Flow 046 — read-only repomap tool

Status: formalized
Source: flow 044 known follow-up #2. Driven via flow-orchestrator.

## Problem

The `repomap` metaproject tool is classified read-only (risk `read`, mutating
false), but its backing (gdgraph service `repomap` -> `writeRepomap`) PERSISTS
`.metaproject/data/gdgraph/artifacts/repomap.md` as a side effect on real runs — a
write under a read-only tool. gdgraph exposes a PURE `computeRepomap(graph, config,
options)` (no I/O) that `writeRepomap` wraps.

## Expected Outcome

`createMetaprojectAdapter`'s `repomap` computes the map WITHOUT writing the
artifact: it loads the graph + gdgraph config and calls the pure `computeRepomap`
directly (never `writeRepomap`). The tool still returns the ranked, budget-fitted
map (files/tokens/omitted/budget) and stays deterministic and never-throwing. No
`.metaproject/data/gdgraph/artifacts/repomap.md` is written by the tool. The
compute path is injectable so tests are deterministic.

## Out of Scope

- No change to gdgraph's own `keryx gdgraph repomap` CLI (which may still write). No
  change to the other operations, the port shape, the projections, or the agent. No
  new dependency.

# Description

## Problem

The wiki and the code graph are not connected. `src/gdgraph/**` contains zero
references to the wiki; `GraphNode` is `{id, kind, path, language}` and
`GraphEdge` has kinds `imports | asset | unresolved`. There is no "page
describes code" edge, so the question every freshness mechanism depends on —
*which pages does this change affect?* — is unanswerable by construction.

Measured on this repository at `45f00257`
(`docs/requirements/keryx-living-wiki-graph/probe-wiki-drift.py`): **28 of 42
component pages have drifted, 530 commits in total**, and all 42 were last
touched in one month — the corpus was generated once and never maintained.

A page also carries no record of what it was verified against, so "is this
page stale?" cannot be answered even approximately, and `GraphNode` stores
neither a content hash nor an mtime, which blocks incremental rebuilds later.

## Expected outcome

Phase 0 of the Living Wiki + Graph package: the foundation, deterministic and
model-free.

1. Wiki pages are nodes in the graph, joined to the code they describe by a
   `describes` edge that is traversable in both directions.
2. File nodes carry `contentHash` and `mtimeMs`.
3. Pages carry `VerifiedAt` (git sha) and `VerifiedScope` (content-hash
   snapshot), both parsed and written, both living inside the page file.

After this flow, "which pages describe file X" and "has this page's code moved
since it was verified" are answerable. Nothing else in the package is built
here — no report, no refresh, no enrichment.

## Out of scope

- The freshness queue, backlog report and change classification (phase 1).
- Managed `## Reference` markers and `wiki refresh` (phase 2).
- Delta prose enrichment and the SAC propose route (phase 3).
- Incremental graph rebuild (phase 4) — this flow only lays its data
  foundation (`contentHash`/`mtimeMs`), it does not change build behaviour.
- The health metric and CI job (phase 5).
- Turning on `rlm.enabled`: a one-line config change, independent of LWG.

## References

- Package: `docs/requirements/keryx-living-wiki-graph/`
  (specification 1.4.0 — §3.1, §3.2, §3.3, §3.3.1, §3.3.2, §4.1, §4.4.1).
- Requirements: LWG-1, LWG-2, LWG-4.
- Branch carrying the package: `docs/living-wiki-graph`.

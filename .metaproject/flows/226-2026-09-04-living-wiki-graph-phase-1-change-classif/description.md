# Description

## Problem

Phase 0 (flow 225, PRs #448/#449) connected the wiki to the graph: pages are
nodes, `describes` edges are traversable both ways, pages carry `VerifiedAt`
and `VerifiedScope`, and file fingerprints land in a build manifest. What is
still missing is the thing a person or an agent can actually act on — a
signal.

Nothing yet answers "what changed, and which pages does it put in doubt?".
The measured drift on this repository is real: 28 of 42 component pages,
530 commits, all 42 last touched in a single month
(`docs/requirements/keryx-living-wiki-graph/probe-wiki-drift.py`).

## Expected outcome

Phase 1 of the package: the freshness signal, deterministic and model-free.

1. **LWG-7 — change classification.** Each changed file is classified
   `added` / `removed` / `moved` / `signature` / `body` / `cosmetic`, using
   the existing symbol layer's `SymbolNode.signature` rather than a new AST
   diff. `cosmetic` must produce no work.
2. **LWG-8 — impact propagation.** From changed files, traverse the graph in
   both directions, deciding whether to continue by edge type rather than a
   hop limit, with confidence decaying `must-refresh` → `review-suggested` →
   `fyi`. Every affected page carries a reason chain.
3. **LWG-9 — freshness queue.** A git hook appends one JSONL line per commit
   within a 50 ms budget: no graph build, no model, no reading the file back.
4. **LWG-10 — `keryx wiki freshness`.** A read-only, categorised backlog
   (`stale-reference`, `stale-prose`, `undocumented`, `orphan`, `unknown`),
   sorted by commits-behind, with `--json` valid against the package schema.

## Out of scope

- Managed `## Reference` markers and `wiki refresh` (phase 2).
- Delta prose enrichment and the SAC propose route (phase 3).
- Incremental graph rebuild (phase 4). Phase 0 already wrote the manifest it
  will read.
- The health metric and CI job (phase 5).

## References

- Package: `docs/requirements/keryx-living-wiki-graph/` (specification 2.0.0
  — §3.3.1, §3.3.2, §4.1, §4.4.1, §5, §6, §7, §8; `ci-protocol.md`).
- Requirements: LWG-7, LWG-8, LWG-9, LWG-10.
- Predecessor: flow 225 (phase 0), merged as `ff390934`.

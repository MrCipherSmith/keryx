# Description

## Problem

Freshness is measurable and repairable, and invisible unless someone
remembers to run a command. `keryx health run` reports lint, types, tests,
complexity and coverage; documentation drift appears in none of them, so the
one signal built over three phases decays quietly between manual runs.

## Why this phase and not phase 3

Phase 3 (delta prose enrichment) is skipped deliberately, on measurement
rather than preference. Over a 189-file range on this repository the drift
was **100% `stale-reference` and 0% `stale-prose`** — every stale page was
repairable by the free, model-free `wiki refresh`, and the only
token-spending phase had nothing to work on.

That zero was checked for being an artifact, twice, before being trusted:
all 53 pages carry real prose (no `_Draft_` placeholders remain), and all 53
name graph symbols in that prose (2137 mentions), so the `stale-prose`
detector can fire on this corpus. It did not fire because no *changed* symbol
is named in any page's prose.

The implementation plan named this outcome in advance as a valid result
rather than an omission.

## Expected outcome

1. **LWG-15 — `wiki_freshness` in the health report.** Read from the last
   freshness report; never recomputed inside `health run`, which must not
   start a graph traversal.
2. **Absence is reported, not rounded.** No freshness report means the metric
   is absent and says so. It must never read as "nothing is stale".
3. **The gate is untouched by default.** A stale page does not fail a build
   unless a project opts in.
4. **A CI job** per `ci-protocol.md` §6: `validate` blocking, `freshness`
   reporting, and a summary that treats a clean result as clean only when
   `limitations` is empty.

## Out of scope

- Delta prose enrichment and `rlm.enabled` (phase 3) — deferred on the
  measurement above, not abandoned.
- Incremental graph rebuild (phase 4) — a pure optimisation, worth taking
  when full builds start to hurt.
- Any change to what `wiki freshness` computes.

## References

- Package: `docs/requirements/keryx-living-wiki-graph/`, `ci-protocol.md` §6,
  specification §10.
- Predecessors: flows 225, 226, 227 and the provenance fix (`a6290d54`).

# Description

## Problem

Phase 1 shipped the signal. It reports that 44 of 50 pages are affected — and
then offers nothing to do about any of them. Two gaps close that.

**The machine half of every page is frozen.** `writeCollectedPage`
(`src/wiki/service.ts:791-804`) rewrites a page only while it is still an
unmodified draft, so the `## Reference (from code graph)` section stops
tracking the graph the moment a human accepts the page. The documented
contract already says otherwise, and contradicts itself doing so:
`.metaproject/skills/gdwiki/SKILL.md:110` calls that section "graph-owned and
regenerated", while `:113` makes the accepted page unoverwritable. Both are
satisfiable only if page and section are different units of ownership, and the
code makes no such distinction.

**Nothing stamps provenance.** `VerifiedAt` and `VerifiedScope` are parsed,
written and hashed — by nothing. So every page reads `unknown`, the freshness
ratio is 0 of 50, and the commits-behind ordering has nothing to sort. The
phase-1 report is honest but inert.

## Expected outcome

1. **LWG-5 — managed block.** Machine markers around the Reference section,
   with a content hash so a hand edit inside it is detected rather than
   silently overwritten. Everything outside the markers stays human-owned,
   always.
2. **LWG-11 — `keryx wiki refresh`.** Deterministic, model-free regeneration
   of managed blocks, including on `Status: accepted` pages. Bumps patch,
   appends a `## Changelog` line, stamps `VerifiedAt`/`VerifiedScope`.
3. **`keryx wiki verify`.** Stamps provenance without touching content — "a
   human looked and confirmed". This is what turns the phase-1 report from
   all-`unknown` into a real backlog.
4. **`keryx wiki migrate-markers`.** One-off, idempotent, adds markers to the
   existing corpus without changing a byte of content.
5. **LWG-14 — validation.** Extends `wiki validate` with the structural rules
   the managed block makes checkable.

## Out of scope

- Delta prose enrichment, the SAC `--propose` route, and `rlm.enabled`
  (phase 3). Nothing here calls a model.
- Incremental graph rebuild (phase 4).
- The health metric and CI job (phase 5).

## References

- Package: `docs/requirements/keryx-living-wiki-graph/` specification 2.0.0,
  §4.2, §4.2.1, §4.2.2, §4.5, §8, §9.
- Requirements: LWG-5, LWG-11, LWG-14, and the stamping half of LWG-4.
- Predecessors: flow 225 (phase 0, `2fee9e09`), flow 226 (phase 1, `060453b6`).

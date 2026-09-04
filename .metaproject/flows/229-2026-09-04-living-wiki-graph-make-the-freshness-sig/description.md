# Description

## Problem

The package was built on one premise: **an agent reads a stale wiki page and
generates code against an API that no longer exists.** Four phases later the
staleness is measured, repairable and visible in `health` and CI — and the
agent still cannot see it.

Verified, not assumed: no MCP tool or resource mentions freshness, the
`gdwiki` skill has no route to it, and `wiki freshness`, `wiki refresh`,
`wiki verify` and `wiki migrate-markers` are absent from
`src/standard/command-registry.ts` — the source of truth for what an agent
may call. An agent opening `components/src-ctx.md` today has no idea whether
it is current, and cannot discover the command that would tell it.

This is a gap in my own work, not a new feature: specification §8 and §10
describe both surfaces, and phase 5 simply did not carry them into its
acceptance criteria.

## Expected outcome

1. The four commands registered, with honest `read`, `json` and `sideEffects`
   flags — `freshness` read-only, the other three writing.
2. An MCP surface for freshness, read-only, beside `wiki_query`/`wiki_ask`.
3. A route in `skills/gdwiki/SKILL.md`: consult the report before treating a
   page as context, and read a `stale-*` page with the caveat attached.

## Out of scope

- Any change to what freshness computes.
- Auto-refresh from an agent. Reading a caveat is not the same as granting
  write access, and the commands stay operator-invoked.

## References

- Package specification 2.0.0 §8 (CLI/skill surface) and §10 (integrations).
- Predecessors: flows 225, 226, 227, 228.

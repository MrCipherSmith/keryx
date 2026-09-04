# Plan

## Chosen approach

**Register first, expose second, route third** — each step is useful alone.
Registration is what makes the commands discoverable at all; the MCP surface
is what lets a connected agent ask without shelling out; the skill route is
what makes it consult before reading rather than after being wrong.

**Read-only on the agent side.** `freshness` is safe to expose. `refresh`,
`verify` and `migrate-markers` write, and while they are registered so an
agent can *describe* them, nothing here grants an agent the ability to stamp
provenance. A stamp asserts a human looked — that is the whole point of
`wiki verify`'s `--page`/`--baseline` split, and handing it to an automated
caller would undo it.

## Steps

1. Four `CommandDescriptor` entries with accurate flags.
2. An MCP read-only tool returning the last report, with its `limitations`
   intact — an agent must see "the graph was not built" rather than an empty
   list.
3. The `gdwiki` SKILL route.
4. Tests: registry coverage, MCP shape, and that the MCP path performs no
   write.

## Rejected alternatives

- **Exposing `wiki refresh` as an MCP tool.** Rejected: it rewrites pages,
  and the value of a deterministic repair is that a person chose to run it.
- **Having the skill tell an agent to run `freshness` itself.** Rejected as
  too slow to be obeyed; reading one JSON file is cheap, running the report
  is not.

## Risks

- A registry entry claiming `read: true` for something that writes would be a
  lie the agent acts on. Each flag is set from what the command actually does.
- The MCP tool must not fabricate a report when none exists; it returns the
  not-measured status the metric already models.
